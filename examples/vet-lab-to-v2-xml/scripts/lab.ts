// `npm run lab -- [answer...]`: a stand-in for a results web service that takes HL7 v2 XML. It
// listens for HTTPS on 127.0.0.1, port 8443 unless LAB_PORT names another, with the certificate
// `npm run certs` made, and refuses a connection that presents no client certificate signed by the
// same CA. It reads each request's body as HL7 v2 XML with @cosyte/hl7, writes it to data/lab/ as a
// file of its own, and answers 200 with an XML acknowledgement (ACK) to it. Each answer's MSA.1 is
// the next one named on the command line: AA, AE or AR, or other-id for an AA whose MSA.2 names
// another message. Once they run out, it answers AA. It prints sizes and codes, never content.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

import {
  buildAck,
  Hl7XmlError,
  parseHL7Xml,
  toHl7Xml,
  type XmlMessageStructure,
} from "@cosyte/hl7";

const OUT = "data/lab";
const TLS = ".pathways/tls";
/** The most of a request's body it reads, 1 MiB. */
const MAX_BODY = 1_048_576;
const ANSWERS = ["AA", "AE", "AR", "other-id"] as const;
type Answer = (typeof ANSWERS)[number];

/**
 * The ACK message structure, as the HL7 v2.5 standard gives it. @cosyte/hl7 ships group tables for
 * ORU_R01 only, so the writer is given this one: an ACK has no groups, and the table also makes the
 * writer refuse a segment that has no place in it.
 */
const ACK_STRUCTURE: XmlMessageStructure = {
  structure: "ACK",
  items: ["MSH", "SFT*", "MSA", "ERR*"],
};

/** The data types of the ACK's fields that have components, in HL7 v2.5. */
const ACK_DATA_TYPES: Readonly<Record<string, string>> = {
  "MSH.3": "HD",
  "MSH.4": "HD",
  "MSH.5": "HD",
  "MSH.6": "HD",
  "MSH.7": "TS",
  "MSH.9": "MSG",
  "MSH.11": "PT",
  "MSH.12": "VID",
};

const queue: Answer[] = [];
for (const given of process.argv.slice(2)) {
  if (!(ANSWERS as readonly string[]).includes(given)) {
    process.stderr.write(`unknown answer ${given}: give AA, AE, AR or other-id\n`);
    process.exit(2);
  }
  queue.push(given as Answer);
}

let received = 0;
mkdirSync(OUT, { recursive: true });

/** The XML acknowledgement to the message in `body`, with the answer `answer`. */
function acknowledge(body: string, answer: Answer): string {
  const message = parseHL7Xml(body);
  const ack = buildAck(message, { code: answer === "other-id" ? "AA" : answer });
  if (answer === "other-id") ack.setField("MSA.2", "SYN-OTHER-0001");
  return toHl7Xml(ack, { dataTypes: ACK_DATA_TYPES, groups: ACK_STRUCTURE });
}

const server = createServer(
  {
    cert: readFileSync(`${TLS}/lab.crt`),
    key: readFileSync(`${TLS}/lab.key`),
    ca: readFileSync(`${TLS}/ca.crt`),
    requestCert: true,
    rejectUnauthorized: true,
  },
  (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    request.on("end", () => {
      received += 1;
      const file = `${OUT}/${String(received)}.xml`;
      const head = `${String(request.method)} ${String(request.url)}: ${String(size)} bytes to ${file}`;
      const body = Buffer.concat(chunks);
      writeFileSync(file, body);
      const answer = queue.shift() ?? "AA";
      let ack: string;
      try {
        if (size > MAX_BODY) throw new Error("too large");
        ack = acknowledge(body.toString("utf8"), answer);
      } catch (error) {
        const code = error instanceof Hl7XmlError ? error.code : "unreadable";
        process.stdout.write(`${head}, not HL7 v2 XML (${code}), answered 400\n`);
        response.writeHead(400).end();
        return;
      }
      const said = answer === "other-id" ? "AA to another control id" : answer;
      process.stdout.write(`${head}, answered ${said}\n`);
      response.writeHead(200, { "Content-Type": "application/xml" }).end(ack);
    });
  },
);

const port = Number(process.env["LAB_PORT"] ?? 8443);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on https://127.0.0.1:${String(port)}\n`);
});
