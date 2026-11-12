// `npm run send -- <file...>`: sends each HL7 v2 file to the channel's MLLP source on 127.0.0.1,
// port 2575 unless MLLP_PORT names another, one at a time on one connection, and prints the code of
// the ACK each draws: AA once the message is stored.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

// MLLP frames each message as a vertical tab, the message, then a file separator and a carriage return.
const START = Buffer.of(0x0b);
const END = Buffer.of(0x1c, 0x0d);

const port = Number(process.env["MLLP_PORT"] ?? 2575);
const socket = connect({ host: "127.0.0.1", port });
socket.setTimeout(10_000, () => socket.destroy(new Error("no ACK within 10 seconds")));

let buffered = Buffer.alloc(0);
const waiting: ((frame: string) => void)[] = [];
socket.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (let end = buffered.indexOf(END); end !== -1; end = buffered.indexOf(END)) {
    const frame = buffered.subarray(buffered.indexOf(START) + 1, end).toString("latin1");
    buffered = buffered.subarray(end + END.length);
    waiting.shift()?.(frame);
  }
});

/** Sends one message and resolves with the ACK it draws. */
function exchange(message: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    waiting.push((frame) => {
      socket.off("error", reject);
      resolve(frame);
    });
    socket.write(Buffer.concat([START, message, END]));
  });
}

for (const file of process.argv.slice(2)) {
  const ack = await exchange(readFileSync(file));
  // MSA-1 is the acknowledgment code.
  const msa = ack.split("\r").find((segment) => segment.startsWith("MSA|"));
  process.stdout.write(`${file}: ${msa?.split("|")[1] ?? "no MSA segment"}\n`);
}
socket.end();
