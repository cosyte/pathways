import { EventEmitter } from "node:events";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../src/config/load.js";
import type { ServerStorage } from "../src/config/schema.js";
import { dialectFor, type DriverImport, type DriverPackage } from "../src/storage/dialects.js";
import { StorageError, Store } from "../src/storage/store.js";
import { serverStorage, URL_ENV } from "./databases.js";
import { makeCertificates, removeCertificates, type Certificates } from "./net-helpers.js";

let certs: Certificates | undefined;
beforeAll(() => {
  certs = makeCertificates();
});
afterAll(() => removeCertificates(certs));

/** A made-up password, so a test can check it never reaches an error. */
const PASSWORD = "synthetic-pw-0000";

async function problemsOf(promise: Promise<unknown>): Promise<readonly string[]> {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as ConfigError).problems;
}

function open(storage: ServerStorage, url: string | undefined, importDriver?: DriverImport) {
  return dialectFor(storage, {
    env: url === undefined ? {} : { [URL_ENV]: url },
    ...(importDriver === undefined ? {} : { importDriver }),
  });
}

const notInstalled =
  (...names: DriverPackage[]): DriverImport =>
  (name) =>
    names.includes(name)
      ? Promise.reject(Object.assign(new Error("synthetic"), { code: "ERR_MODULE_NOT_FOUND" }))
      : import(name);

describe("dialectFor: the connection URL", () => {
  it("names the file, the key and the variable when the variable is not set", async () => {
    expect(await problemsOf(open(serverStorage("postgres"), undefined))).toEqual([
      `pathways.yaml: storage.postgres.url: the environment variable ${URL_ENV} is not set`,
    ]);
  });

  it.each([
    ["postgres", "not a url"],
    ["postgres", "mysql://host/db"],
    ["mysql", "postgres://host/db"],
    ["sqlserver", "https://host/db"],
  ] as const)("refuses a %s URL that is not one, without repeating it", async (kind, url) => {
    const [problem] = await problemsOf(open(serverStorage(kind), url));
    expect(problem).toMatch(
      new RegExp(
        `^pathways\\.yaml: storage\\.${kind}\\.url: the environment variable ${URL_ENV} does not hold a [a-z]+:// URL$`,
      ),
    );
    expect(problem).not.toContain(url);
  });

  it("refuses a PostgreSQL URL that sets TLS itself, since pathways.yaml owns TLS", async () => {
    const url = `postgres://u:${PASSWORD}@127.0.0.1/db?application_name=x&sslmode=disable`;
    expect(await problemsOf(open(serverStorage("postgres"), url))).toEqual([
      `pathways.yaml: storage.postgres.url: the URL in ${URL_ENV} sets TLS options; set TLS in pathways.yaml instead, with tls or plaintext: true`,
    ]);
  });

  it.each(["mysql", "sqlserver"] as const)(
    "refuses a %s URL with options, a missing host or database, or broken encoding",
    async (kind) => {
      const scheme = kind === "mysql" ? "mysql" : "sqlserver";
      const cases = [
        [`${scheme}://u:${PASSWORD}@db.local/pathways?debug=true`, `carries options after "?"`],
        [`${scheme}:///pathways`, "names no host"],
        [`${scheme}://u:${PASSWORD}@db.local`, "names no database"],
        [`${scheme}://u:${PASSWORD}@db.local/a/b`, "names no database"],
        [`${scheme}://u:%zz@example.test/pathways`, "is not percent-encoded correctly"],
      ];
      for (const [url, what] of cases) {
        const problems = await problemsOf(open(serverStorage(kind), url));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(`pathways.yaml: storage.${kind}.url: the URL in ${URL_ENV} `);
        expect(problems[0]).toContain(what);
        expect(problems[0]).not.toContain(PASSWORD);
      }
    },
  );

  it("names a TLS file it cannot read by its key", async () => {
    const storage = serverStorage("postgres", {
      tls: { ca: "/nonexistent/ca.pem", cert: undefined, key: undefined },
      plaintext: false,
    });
    expect(await problemsOf(open(storage, "postgres://127.0.0.1/db"))).toEqual([
      "pathways.yaml: storage.postgres.tls.ca: could not be read (ENOENT)",
    ]);
  });
});

describe("dialectFor: the driver packages", () => {
  it("names the one package to install when it is missing", async () => {
    expect(
      await problemsOf(open(serverStorage("postgres"), "postgres://h/db", notInstalled("pg"))),
    ).toEqual([
      "pathways.yaml: storage.postgres: the driver package pg is not installed; add it to the project with npm install pg",
    ]);
    expect(
      await problemsOf(open(serverStorage("sqlserver"), "sqlserver://h/db", notInstalled("tarn"))),
    ).toEqual([
      "pathways.yaml: storage.sqlserver: the driver package tarn is not installed; add it to the project with npm install tarn",
    ]);
  });

  it("names both of SQL Server's packages when both are missing", async () => {
    const importDriver = notInstalled("tedious", "tarn");
    expect(
      await problemsOf(open(serverStorage("sqlserver"), "sqlserver://h/db", importDriver)),
    ).toEqual([
      "pathways.yaml: storage.sqlserver: the driver packages tedious and tarn are not installed; add them to the project with npm install tedious tarn",
    ]);
  });

  it("reports a driver that fails to load for another reason as storage it cannot open", async () => {
    const importDriver: DriverImport = () => Promise.reject(new SyntaxError("synthetic"));
    const error: unknown = await Store.open(serverStorage("mysql"), {
      env: { [URL_ENV]: "mysql://h/db" },
      importDriver,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ reason: "open", code: undefined });
  });
});

/** Stand-in driver modules that record what Pathways hands them, and connect nowhere. */
function fakeDrivers() {
  const seen: Record<string, unknown> = {};
  const connections: EventEmitter[] = [];
  class FakeConnection extends EventEmitter {
    constructor(config: unknown) {
      super();
      seen["tedious"] = config;
      connections.push(this);
    }
    connect(callback: (error?: Error) => void): void {
      callback(Object.assign(new Error("synthetic"), { code: "ESOCKET" }));
    }
  }
  const modules: Record<DriverPackage, unknown> = {
    pg: {
      Pool: class extends EventEmitter {
        constructor(options: unknown) {
          super();
          seen["pg"] = options;
          seen["pgPool"] = this;
        }
      },
    },
    // A CommonJS build hands a package over as it is, with no `default`.
    mysql2: {
      createPool: (options: unknown) => {
        seen["mysql2"] = options;
        return {};
      },
    },
    tedious: { Connection: FakeConnection, ISOLATION_LEVEL: {}, Request: class {}, TYPES: {} },
    tarn: {
      Pool: class {
        constructor(options: { create: () => Promise<unknown> }) {
          seen["tarn"] = options;
        }
      },
    },
  };
  const importDriver: DriverImport = (name) =>
    Promise.resolve(name === "mysql2" ? modules[name] : { default: modules[name] });
  return { seen, connections, importDriver };
}

describe("dialectFor: what each driver is given", () => {
  const ca = (): string => certs?.files.ca ?? "";
  const verified = (kind: ServerStorage["kind"]): ServerStorage =>
    serverStorage(kind, {
      tls: { ca: ca(), cert: undefined, key: undefined },
      plaintext: false,
      pool: { max: 7, idleTimeoutMs: 1_234 },
      connectTimeoutMs: 4_321,
    });

  it("PostgreSQL: the URL as it is, TLS always set, and the pool settings", async () => {
    const { seen, importDriver } = fakeDrivers();
    const url = `postgres://u:${PASSWORD}@db.local:5433/pathways?application_name=pathways`;
    await open(verified("postgres"), url, importDriver);
    expect(seen["pg"]).toEqual({
      connectionString: url,
      ssl: { ca: certs?.ca, rejectUnauthorized: true },
      max: 7,
      idleTimeoutMillis: 1_234,
      connectionTimeoutMillis: 4_321,
    });
    await open(serverStorage("postgres"), url, importDriver);
    expect(seen["pg"]).toMatchObject({ ssl: false });
    // An idle connection's error, unheard, would end the process.
    const pool = seen["pgPool"] as EventEmitter;
    expect(() => pool.emit("error", new Error("synthetic: the server restarted"))).not.toThrow();
  });

  it("MySQL: the URL taken apart, TLS only when set", async () => {
    const { seen, importDriver } = fakeDrivers();
    const url = `mysql://u%40x:${PASSWORD}@[::1]/path%20ways`;
    await open(verified("mysql"), url, importDriver);
    expect(seen["mysql2"]).toEqual({
      host: "::1",
      port: 3_306,
      user: "u@x",
      password: PASSWORD,
      database: "path ways",
      ssl: { ca: certs?.ca, rejectUnauthorized: true },
      connectionLimit: 7,
      maxIdle: 7,
      idleTimeout: 1_234,
      connectTimeout: 4_321,
    });
    await open(serverStorage("mysql"), "mariadb://db.local:3307/pathways", importDriver);
    expect(seen["mysql2"]).not.toHaveProperty("ssl");
    expect(seen["mysql2"]).toMatchObject({ host: "db.local", port: 3_307, user: "" });
  });

  it("SQL Server: a login, encryption with the server's certificate verified, and tarn's pool", async () => {
    const { seen, connections, importDriver } = fakeDrivers();
    const dialect = await open(
      verified("sqlserver"),
      `sqlserver://sa:${PASSWORD}@db.local:1444/pathways`,
      importDriver,
    );
    dialect.createDriver();
    const tarn = seen["tarn"] as { create: () => Promise<unknown>; max: number; min: number };
    expect(tarn).toMatchObject({
      min: 0,
      max: 7,
      idleTimeoutMillis: 1_234,
      propagateCreateError: true,
    });

    // Kysely writes a connection's errors to console.error: only a fixed text and a code get there.
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(tarn.create()).rejects.toMatchObject({ code: "ESOCKET" });
      expect(seen["tedious"]).toEqual({
        server: "db.local",
        authentication: { type: "default", options: { userName: "sa", password: PASSWORD } },
        options: {
          port: 1_444,
          database: "pathways",
          encrypt: true,
          trustServerCertificate: false,
          cryptoCredentialsDetails: { ca: certs?.ca, rejectUnauthorized: true },
          connectTimeout: 4_321,
        },
      });
      const [connection] = connections;
      const heard: unknown[] = [];
      connection?.on("error", (error) => heard.push(error));
      connection?.on("end", () => heard.push("end"));
      connection?.emit(
        "error",
        Object.assign(new Error(`login for sa at db.local`), { code: "ELOGIN" }),
      );
      connection?.emit("error", new Error("db.local"));
      connection?.emit("end");
      expect(heard).toEqual([
        expect.objectContaining({ message: "the SQL Server connection failed", code: "ELOGIN" }),
        expect.objectContaining({ message: "the SQL Server connection failed" }),
        "end",
      ]);
      expect(JSON.stringify(printed.mock.calls.map((call) => String(call[0])))).not.toContain(
        "db.local",
      );
    } finally {
      printed.mockRestore();
    }

    const plaintext = await open(
      serverStorage("sqlserver"),
      "mssql://db.local/pathways",
      importDriver,
    );
    plaintext.createDriver();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        (seen["tarn"] as { create: () => Promise<unknown> }).create(),
      ).rejects.toMatchObject({ code: "ESOCKET" });
    } finally {
      quiet.mockRestore();
    }
    expect(seen["tedious"]).toMatchObject({
      server: "db.local",
      authentication: { options: { userName: "", password: "" } },
      options: { port: 1_433, encrypt: false, cryptoCredentialsDetails: {} },
    });
  });
});

describe("Store.open on a server that is not there", () => {
  // Port 1 on this machine refuses at once: each driver loads, connects, and reports the refusal by
  // its code, with nothing from the URL in the error.
  it.each([
    ["postgres", `postgres://u:${PASSWORD}@127.0.0.1:1/pathways`, "ECONNREFUSED"],
    ["mysql", `mysql://u:${PASSWORD}@127.0.0.1:1/pathways`, "ECONNREFUSED"],
    ["sqlserver", `sqlserver://u:${PASSWORD}@127.0.0.1:1/pathways`, "ESOCKET"],
  ] as const)(
    "%s: a refused connection is a StorageError with its code",
    async (kind, url, code) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const error: unknown = await Store.open(serverStorage(kind, { connectTimeoutMs: 5_000 }), {
          env: { [URL_ENV]: url },
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toMatchObject({ reason: "open", code });
        expect((error as Error).message).toBe("the database could not be opened");
      } finally {
        printed.mockRestore();
      }
    },
  );
});
