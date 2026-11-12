// `npm run certs`: makes development TLS material in .pathways/tls/ with the openssl command, unless
// it is there already: a certificate authority (ca.crt), the certificate scripts/lab.ts presents for
// 127.0.0.1 and localhost (lab.crt, lab.key), and the client certificate the channel presents to it
// (client.crt, client.key). Each is valid for 30 days, and the keys are readable by this user only.
// .gitignore keeps .pathways/ out of git. A real service's client certificate comes from whoever
// runs the service, never from a script like this one.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".pathways/tls";
// An elliptic curve key on P-256, written without a passphrase.
const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
const DAYS = "30";

if (existsSync(join(DIR, "ca.crt"))) {
  process.stdout.write(`${DIR} is there already\n`);
  process.exit(0);
}

mkdirSync(DIR, { recursive: true, mode: 0o700 });

function openssl(args: readonly string[]): void {
  execFileSync("openssl", args, { cwd: DIR, stdio: "pipe" });
}

/** Writes `lines` to `name` in the folder, for openssl to read. */
function write(name: string, lines: readonly string[]): void {
  writeFileSync(join(DIR, name), [...lines, ""].join("\n"));
}

// The certificate authority, which signs the other two.
write("ca.cnf", [
  "[req]",
  "distinguished_name = dn",
  "prompt = no",
  "[dn]",
  "CN = Pathways example development CA",
  "[v3_ca]",
  "basicConstraints = critical,CA:TRUE",
  "keyUsage = critical,keyCertSign,cRLSign",
  "subjectKeyIdentifier = hash",
]);
openssl([
  "req",
  "-x509",
  "-config",
  "ca.cnf",
  "-extensions",
  "v3_ca",
  ...KEY,
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
  "-days",
  DAYS,
]);

/** A certificate the CA signs, for `name`, with the X.509 extensions given. */
function leaf(
  name: string,
  commonName: string,
  serial: number,
  extensions: readonly string[],
): void {
  write(`${name}.cnf`, [
    "[req]",
    "distinguished_name = dn",
    "prompt = no",
    "[dn]",
    `CN = ${commonName}`,
  ]);
  write(`${name}.ext`, [
    "basicConstraints = CA:FALSE",
    "keyUsage = critical,digitalSignature",
    ...extensions,
  ]);
  openssl([
    "req",
    "-new",
    "-config",
    `${name}.cnf`,
    ...KEY,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-set_serial",
    String(serial),
    "-days",
    DAYS,
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.crt`,
  ]);
  for (const done of [`${name}.cnf`, `${name}.ext`, `${name}.csr`]) rmSync(join(DIR, done));
}

leaf("lab", "localhost", 2, [
  "extendedKeyUsage = serverAuth",
  "subjectAltName = DNS:localhost,IP:127.0.0.1",
]);
leaf("client", "Pathways example lab", 3, ["extendedKeyUsage = clientAuth"]);
rmSync(join(DIR, "ca.cnf"));
for (const key of ["ca.key", "lab.key", "client.key"]) chmodSync(join(DIR, key), 0o600);
process.stdout.write(`wrote ${DIR}: ca.crt, lab.crt, lab.key, client.crt, client.key\n`);
