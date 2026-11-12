// `npm run receiver`: a stand-in for the system the channel POSTs to. It listens on 127.0.0.1, port
// 8080 unless RECEIVER_PORT names another, writes each request's body to data/receiver/ as a file
// of its own, and answers 200. It prints the file's name and size, never what is in it.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const OUT = "data/receiver";
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/hl7-v2": "hl7",
  "application/fhir+json": "json",
};

let received = 0;
mkdirSync(OUT, { recursive: true });

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received += 1;
    const type = (request.headers["content-type"] ?? "").split(";")[0] ?? "";
    const file = `${OUT}/${String(received)}.${EXTENSIONS[type] ?? "txt"}`;
    const body = Buffer.concat(chunks);
    writeFileSync(file, body);
    process.stdout.write(
      `${String(request.method)} ${String(request.url)} ${type}: ${String(body.length)} bytes to ${file}\n`,
    );
    response.writeHead(200).end();
  });
});

const port = Number(process.env["RECEIVER_PORT"] ?? 8080);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on http://127.0.0.1:${String(port)}\n`);
});
