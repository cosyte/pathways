// The port helpers the tests share: a listener a test starts binds port 0, and a port a
// configuration must name before anything binds it is picked again when another test file's worker
// takes it first.
import { connect, createServer, type AddressInfo, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLOSED_PORT,
  LISTENER_TAKEN,
  onPickedPorts,
  orTaken,
  pickPorts,
  PortTaken,
  sourceListening,
} from "./net-helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Listens on `port` of 127.0.0.1, as a listener in another worker would. */
async function listen(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.push(server);
  return server;
}

/** Binds `port` as an attempt does: a port taken first is {@link PortTaken}. */
async function bind(port: number): Promise<number> {
  try {
    await listen(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortTaken();
    throw error;
  }
  return port;
}

describe("a port picked for a configuration", () => {
  it("can be taken by another worker between its picking and its binding", async () => {
    const [port = 0] = await pickPorts(1);
    await listen(port);
    await expect(listen(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("is picked again when it is taken first, and the attempt runs on the new one", async () => {
    const { port: held } = (await listen(0)).address() as AddressInfo;
    const picks = [[held]];
    const tried: number[] = [];
    const bound = await onPickedPorts(
      1,
      ([port = 0]) => {
        tried.push(port);
        return bind(port);
      },
      { pick: (count) => Promise.resolve(picks.shift() ?? pickPorts(count)) },
    );
    expect(tried).toEqual([held, bound]);
    expect(bound).not.toBe(held);
  });

  it("lets PortTaken through after its tries, and any other error at once", async () => {
    const { port: held } = (await listen(0)).address() as AddressInfo;
    let tries = 0;
    const always = (): Promise<readonly number[]> => Promise.resolve([held]);
    await expect(
      onPickedPorts(
        1,
        ([port = 0]) => {
          tries += 1;
          return bind(port);
        },
        { pick: always, tries: 3 },
      ),
    ).rejects.toBeInstanceOf(PortTaken);
    expect(tries).toBe(3);

    tries = 0;
    await expect(
      onPickedPorts(1, () => {
        tries += 1;
        return Promise.reject(new Error("synthetic"));
      }),
    ).rejects.toThrow("synthetic");
    expect(tries).toBe(1);
  });

  it("are all different when picked together", async () => {
    const ports = await pickPorts(8);
    expect(new Set(ports).size).toBe(8);
  });
});

describe("orTaken", () => {
  it("turns a failure into PortTaken only when the run said a listener could not have its port", async () => {
    const failing = (): Promise<never> => Promise.reject(new Error("synthetic"));
    await expect(
      orTaken(failing, () => Promise.resolve(`pathways: the health endpoint ${LISTENER_TAKEN}.\n`)),
    ).rejects.toBeInstanceOf(PortTaken);
    await expect(orTaken(failing, () => Promise.resolve(""))).rejects.toThrow("synthetic");
    expect(
      await orTaken(
        () => Promise.resolve(1),
        () => Promise.resolve(""),
      ),
    ).toBe(1);
  });
});

describe("sourceListening", () => {
  it("stops the engine and throws PortTaken when the source is down, and passes one that is up", async () => {
    let stopped = 0;
    const engine = (source: string) => ({
      health: () => Promise.resolve({ channels: { adt: { source } } }),
      stop: () => {
        stopped += 1;
        return Promise.resolve();
      },
    });
    await expect(sourceListening(engine("down"), "adt")).rejects.toBeInstanceOf(PortTaken);
    expect(stopped).toBe(1);
    await sourceListening(engine("up"), "adt");
    expect(stopped).toBe(1);
  });
});

describe("CLOSED_PORT", () => {
  it("refuses a connection, and is a port no bind to port 0 hands out", async () => {
    const code = await new Promise<string | undefined>((resolve) => {
      const socket = connect(CLOSED_PORT, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
    });
    expect(code).toBe("ECONNREFUSED");
    expect(CLOSED_PORT).toBeLessThan(1024);
  });
});
