import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";

import { makeProject } from "./helpers.js";
import { ed25519KeyPair } from "./ssh-keys.js";

// OpenSSH's own server for the SFTP suites, started on the loopback as this user, with throwaway
// keys made for the run and synthetic files only. PATHWAYS_TEST_SSHD names the sshd binary (an
// absolute path): .github/workflows/sftp.yml sets it, and the suites are skipped where it is not set.

/** The sshd binary the SFTP suites run, or undefined where they are skipped. */
export const SSHD = process.env["PATHWAYS_TEST_SSHD"];

/**
 * OpenSSH's `sftp-server` program, where this machine has it: Debian and Ubuntu, Fedora and Red
 * Hat, and Arch keep it in different places. A test that ends it needs it as a process of its own.
 */
export const SFTP_SERVER = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
  "/usr/libexec/sftp-server",
].find((path) => existsSync(path));

/** A port free on the loopback just now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Resolves once something listens on `port`, trying for up to ten seconds. */
export async function listening(port: number): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sshd did not start listening");
}

/** One OpenSSH server for a test: its folder, port, host key, and the user's key. */
export interface Sshd {
  readonly home: string;
  readonly port: number;
  readonly hostPublic: string;
  readonly userKey: string;
  process: ChildProcess;
  readonly config: string;
  /**
   * With `ownSftpServer`, the file each `sftp-server` the server starts writes its process id to,
   * as it starts.
   */
  readonly sftpPid: string;
}

/** What {@link startSshd} sets up besides its defaults. */
export interface SshdOptions {
  /** Lines added to the server's configuration. */
  readonly extra?: readonly string[];
  /**
   * Serves SFTP through {@link SFTP_SERVER}, a process of its own that a test can end while the
   * SSH connection stays up, rather than inside the server's own process (`internal-sftp`).
   */
  readonly ownSftpServer?: boolean;
}

const servers: Sshd[] = [];

/** Starts sshd on a free port, serving this user. Stop it with {@link stopAllSshd}. */
export async function startSshd(options: SshdOptions = {}): Promise<Sshd> {
  const { extra = [], ownSftpServer = false } = options;
  const home = await makeProject({});
  const port = await freePort();
  const host = ed25519KeyPair();
  const user = ed25519KeyPair();
  await writeFile(join(home, "host_ed25519"), host.private, { mode: 0o600 });
  await writeFile(join(home, "authorized_keys"), `${user.public}\n`, { mode: 0o600 });
  const sftpPid = join(home, "sftp-server.pid");
  let subsystem = "internal-sftp";
  if (ownSftpServer) {
    if (SFTP_SERVER === undefined) throw new Error("this machine has no sftp-server");
    // The server runs the subsystem through the user's shell; exec keeps the process id it wrote.
    subsystem = join(home, "sftp-server.sh");
    await writeFile(subsystem, `#!/bin/sh\necho $$ > '${sftpPid}'\nexec '${SFTP_SERVER}'\n`);
    await chmod(subsystem, 0o755);
  }
  const config = join(home, "sshd_config");
  await writeFile(
    config,
    [
      `Port ${String(port)}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(home, "host_ed25519")}`,
      `PidFile ${join(home, "sshd.pid")}`,
      `AuthorizedKeysFile ${join(home, "authorized_keys")}`,
      `AllowUsers ${userInfo().username}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      `Subsystem sftp ${subsystem}`,
      ...extra,
      "",
    ].join("\n"),
  );
  await mkdir(join(home, "inbox"));
  const sshd: Sshd = {
    home,
    port,
    hostPublic: host.public,
    userKey: user.private,
    process: runSshd(config),
    config,
    sftpPid,
  };
  servers.push(sshd);
  await listening(port);
  return sshd;
}

/** sshd in the foreground, logging to stderr, which the test keeps quiet. */
export function runSshd(config: string): ChildProcess {
  return spawn(String(SSHD), ["-D", "-e", "-f", config], { stdio: "ignore" });
}

/** Stops `sshd` and waits for it to exit. */
export async function stopSshd(sshd: Sshd): Promise<void> {
  if (sshd.process.exitCode !== null || sshd.process.signalCode !== null) return;
  const exited = new Promise((resolve) => sshd.process.once("exit", resolve));
  sshd.process.kill("SIGTERM");
  await exited;
}

/** Stops every server {@link startSshd} started. */
export async function stopAllSshd(): Promise<void> {
  for (const server of servers.splice(0)) await stopSshd(server);
}
