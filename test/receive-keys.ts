// Run by test/receive-race.test.ts as a process of its own: opens the SQLite store at argv[2] and
// hands in, resumed, one synthetic note under each of argv[3] idempotency keys, in order, then
// prints how many the store answered as already stored.
import { Store } from "../src/storage/store.js";

async function main(): Promise<void> {
  const [file = "", count = "0"] = process.argv.slice(2);
  const store = await Store.open(file);
  let again = 0;
  try {
    for (let i = 0; i < Number(count); i += 1) {
      const received = await store.receive(
        "notes",
        new TextEncoder().encode(`synthetic note ${String(i)}`),
        {
          idempotencyKey: `synthetic-key-${String(i)}`,
          resumed: true,
        },
      );
      if (received.alreadyStored === true) again += 1;
    }
  } finally {
    await store.close();
  }
  process.stdout.write(String(again));
}

void main();
