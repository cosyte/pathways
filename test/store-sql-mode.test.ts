import { sql, type Kysely } from "kysely";
import mysql2 from "mysql2/promise";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { ServerStorage } from "../src/config/schema.js";
import { Store } from "../src/storage/store.js";
import {
  available,
  closeAdmins,
  dropDatabases,
  freshDatabase,
  SERVER_DATABASES,
  type TestDatabase,
} from "./databases.js";

afterEach(dropDatabases);
afterAll(closeAdmins);

/**
 * The server's sql_mode for this session, with NO_BACKSLASH_ESCAPES added: a backslash in a string
 * literal is then an ordinary character, so a value escaped on the client for the default mode is
 * read wrongly.
 */
const NO_BACKSLASH_ESCAPES =
  "set session sql_mode = concat_ws(',', nullif(@@session.sql_mode, ''), 'NO_BACKSLASH_ESCAPES')";

/** A synthetic HL7 v2 message: escape sequences (`\F\`, `\S\`), quotes and bare backslashes. */
const BODY = Buffer.from(
  [
    "MSH|^~\\&|SYNTH-APP|SYNTH-FAC|TEST-APP|TEST-FAC|20260101000000||ORU^R01|SYNTH0001|P|2.5",
    "PID|1||TEST000001^^^TESTFAC^MR||TESTPATIENT^ALPHA||19700101|U",
    `OBX|1|TX|SYNTH^Note||it\\'s \\F\\ a "quoted" value \\S\\ with \\\\ two backslashes`,
    "",
  ].join("\r"),
);

/** An error text that, escaped on the client for the default mode, ends its string early. */
const FAILURE = `synthetic failure: can't parse \\' "here" \\\\ or \\`;

/** Metadata as JSON, which escapes its own quotes and backslashes with backslashes. */
const META = JSON.stringify({ note: `O'Test \\ "synthetic"`, path: "C:\\synthetic\\inbox" });

const MYSQL_SERVERS = SERVER_DATABASES.filter((database) => database.kind === "mysql");

/** A store on a fresh database whose one connection runs under NO_BACKSLASH_ESCAPES. */
async function storeUnderMode(database: TestDatabase): Promise<Store> {
  const { storage, env } = await freshDatabase(database);
  // One connection, so the session's mode holds for every statement the store runs.
  const single: ServerStorage = {
    ...(storage as ServerStorage),
    pool: { max: 1, idleTimeoutMs: 60_000 },
  };
  const store = await Store.open(single, { env });
  const db = (store as unknown as { readonly db: Kysely<unknown> }).db;
  await sql.raw(NO_BACKSLASH_ESCAPES).execute(db);
  const { rows } = await sql<{ mode: string }>`select @@session.sql_mode as mode`.execute(db);
  expect(rows[0]?.mode).toContain("NO_BACKSLASH_ESCAPES");
  return store;
}

for (const database of MYSQL_SERVERS) {
  describe.skipIf(!available(database))(`NO_BACKSLASH_ESCAPES on ${database.label}`, () => {
    it("stores and reads back a body, an error text and metadata with backslashes and quotes, byte for byte", async () => {
      const store = await storeUnderMode(database);
      try {
        const duplicateKey = `synthetic\\'key"`;
        const first = await store.receive("adt", BODY, {
          failure: FAILURE,
          storedMeta: META,
          duplicateKey,
        });
        const second = await store.receive("adt", BODY, { duplicateKey });
        expect(second.duplicateOf).toBe(first.id);

        const body = await store.messageBody(first.id);
        expect(Buffer.from(body ?? new Uint8Array()).equals(BODY)).toBe(true);
        expect((await store.message(first.id))?.error).toBe(FAILURE);
        const stored = await store.storedMeta(0, 10);
        expect(stored.find((row) => row.id === first.id)?.meta).toBe(META);
        expect(await store.channels()).toEqual(["adt"]);
        await store.failTransform(second.id, FAILURE);
        expect((await store.message(second.id))?.error).toBe(FAILURE);
      } finally {
        await store.close();
      }
    });

    // What the store did before: mysql2's query() writes each value into the SQL text, escaped
    // for the default mode, and under NO_BACKSLASH_ESCAPES the server keeps the escapes.
    it("shows that a value escaped on the client comes back changed under the same mode", async () => {
      const { url } = await freshDatabase(database);
      const connection = await mysql2.createConnection({ uri: url });
      try {
        await connection.query(NO_BACKSLASH_ESCAPES);
        await connection.query("create table synthetic_values (v text not null)");
        const value = "a\\b";
        await connection.query("insert into synthetic_values (v) values (?)", [value]);
        const [rows] = await connection.query("select v from synthetic_values");
        expect((rows as { v: string }[])[0]?.v).toBe("a\\\\b");
      } finally {
        await connection.end();
      }
    });
  });
}
