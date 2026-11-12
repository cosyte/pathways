import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { MessageFor, TransformFor, XmlDocument } from "../src/transform.js";
import { loadProject } from "../src/config/load.js";
import { ChannelWorker } from "../src/engine/channel-worker.js";
import { Engine } from "../src/engine/engine.js";
import {
  decode,
  encode,
  runTransform,
  summarize,
  XML_DEFAULTS,
  type XmlSettings,
} from "../src/engine/worker-entry.js";
import { TEST_DATABASES, testStorage } from "./databases.js";
import { captureLogger, cleanUp, dropFile, makeProject } from "./helpers.js";

// Every value below is synthetic: ids, codes and names that are plainly fake.

afterEach(cleanUp);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
/** Keeps a byte order mark, so a test can see it was written. */
const text = (body: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
const BOM = String.fromCharCode(0xfeff);

/** A body written the way no serializer writes it: single quotes, odd spacing, CRLF, a comment. */
const ORDER =
  "<?xml version='1.0' encoding='UTF-8'?>\r\n" +
  "<!-- a synthetic order -->\r\n" +
  "<order  xmlns='urn:example:orders' id='TEST-ORDER-001'\r\n" +
  '       status="new" >\r\n' +
  "  <patient mrn='TEST000001'><name>TESTPATIENT &amp; ALPHA</name></patient>\r\n" +
  "  <test code='TEST-CODE-1'/>\r\n" +
  "  <note><![CDATA[x < y]]></note>\r\n" +
  "</order>";

/** Reads `body` with `settings`, through the format registry, as a worker does. */
const read = (body: string | Uint8Array, settings: XmlSettings = {}): Promise<XmlDocument> =>
  decode("xml", typeof body === "string" ? bytes(body) : body, { xml: settings });

/** Writes `output` on an `xml` channel, through the format registry, as a worker does. */
const write = async (output: unknown, settings: XmlSettings = {}): Promise<string> =>
  text(await encode("xml", output, { xml: settings }));

/** The code a promise rejects with, and its text. */
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; text: string }> {
  try {
    await promise;
  } catch (error) {
    const summary = summarize(error);
    return { ...(summary.code === undefined ? {} : { code: summary.code }), text: summary.detail };
  }
  throw new Error("expected a refusal");
}

describe("format: xml, read", () => {
  it("hands the transform a parsed document", async () => {
    const document = await read(ORDER);
    expect(document.nodeType).toBe(9);
    expect(document.documentElement?.localName).toBe("order");
    expect(document.documentElement?.namespaceURI).toBe("urn:example:orders");
    expect(document.documentElement?.getAttribute("id")).toBe("TEST-ORDER-001");
    const name = document.getElementsByTagName("name")[0];
    expect(name?.textContent).toBe("TESTPATIENT & ALPHA");
  });

  it("refuses a DOCTYPE with a code, and names nothing the body holds", async () => {
    const hostile =
      '<?xml version="1.0"?>\n<!DOCTYPE order [<!ENTITY secret SYSTEM "file:///etc/hostname">]>\n' +
      "<order id='TEST-ORDER-SECRET'>&secret;</order>";
    const refused = await refusal(read(hostile));
    expect(refused.code).toBe("XXE_OR_DTD_PRESENT");
    for (const part of ["TEST-ORDER-SECRET", "secret", "hostname", "order"]) {
      expect(refused.text).not.toContain(part);
    }
  });

  it("refuses an entity declaration on its own, in any case", async () => {
    const refused = await refusal(read('<!entity x "TEST-VALUE"><order/>'));
    expect(refused.code).toBe("XXE_OR_DTD_PRESENT");
    expect(refused.text).not.toContain("TEST-VALUE");
  });

  it("refuses any custom entity reference, since none can be declared", async () => {
    const refused = await refusal(read("<order id='TEST-ORDER-002'>&lab;</order>"));
    expect(refused.code).toBe("ENTITY_EXPANSION_LIMIT");
    expect(refused.text).not.toContain("lab");
    expect(refused.text).not.toContain("TEST-ORDER-002");
    // The five predefined entities and character references are not custom.
    const document = await read("<order>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;</order>");
    expect(document.documentElement?.textContent).toBe("<>&\"'AB");
  });

  it("refuses a body that is not well-formed XML, naming nothing it holds", async () => {
    for (const body of ["<order><patient></order>", "TEST-NOT-XML", "<a/><b/>", ""]) {
      const refused = await refusal(read(body));
      expect(refused.code).toBe("NOT_WELL_FORMED_XML");
      expect(refused.text).not.toContain("TEST-NOT-XML");
      expect(refused.text).not.toContain("patient");
    }
  });

  it("refuses a body that is not UTF-8", async () => {
    const latin1 = new Uint8Array([...bytes("<order>"), 0xe9, ...bytes("</order>")]);
    expect((await refusal(read(latin1))).code).toBe("ERR_ENCODING_INVALID_ENCODED_DATA");
  });

  it("refuses a body over the size cap, by default and as the channel sets it", async () => {
    expect(XML_DEFAULTS.maxBytes).toBe(10_485_760);
    const filler = "x".repeat(64);
    const body = `<order>${filler}</order>`;
    const size = bytes(body).byteLength;
    await expect(read(body, { maxBytes: size })).resolves.toBeDefined();
    const refused = await refusal(read(body, { maxBytes: size - 1 }));
    expect(refused.code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
    expect(refused.text).not.toContain(filler);
    const large = `<order>${"y".repeat(XML_DEFAULTS.maxBytes)}</order>`;
    expect((await refusal(read(large))).code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
  });

  it("refuses a character XML 1.0 forbids, as it is or as a character reference", async () => {
    for (const body of [
      "<order>TEST-VALUE\u0001</order>",
      "<order>TEST-VALUE&#1;</order>",
      "<order>TEST-VALUE&#x1F;</order>",
      "<order note='TEST-VALUE&#x8;'/>",
      "<order><![CDATA[TEST-VALUE\u0002]]></order>",
      "<order><!--TEST-VALUE\u0003--></order>",
      "<order>TEST-VALUE&#xFFFE;</order>",
      "<order>TEST-VALUE&#xD800;</order>",
    ]) {
      const refused = await refusal(read(body));
      expect(refused.code).toBe("NOT_WELL_FORMED_XML");
      expect(refused.text).not.toContain("TEST-VALUE");
    }
    // Tab, line feed, carriage return and characters past the controls are allowed.
    const allowed = await read("<order>&#9;&#10;&#13;&#x85;&#xE9;&#x1F600;</order>");
    expect(allowed.documentElement?.textContent).toBe("\t\n\r\u0085é\u{1f600}");
    // A reference inside a CDATA section is text, not a reference.
    await expect(read("<order><![CDATA[&#1;]]></order>")).resolves.toBeDefined();
  });

  it("refuses text outside the root element, and reads comments and whitespace there", async () => {
    for (const body of [
      "<order/>TEST-VALUE",
      "TEST-VALUE<order/>",
      "<order/><!--c-->TEST-VALUE<?p x?>",
      "<?xml version='1.0'?>TEST-VALUE\n<order/>",
      "<order/><![CDATA[TEST-VALUE]]>",
      "<order/>?>",
      "<order a='>'/>TEST-VALUE",
      "<order><![CDATA[</order>]]></order>TEST-VALUE",
    ]) {
      const refused = await refusal(read(body));
      expect(refused.code).toBe("NOT_WELL_FORMED_XML");
      expect(refused.text).not.toContain("TEST-VALUE");
    }
    for (const body of [
      "<?xml version='1.0'?>\r\n<!--c-->\n<?p x?>\t<order a='>'><![CDATA[</order>]]></order>\r\n<!--d--> <?q?>\n",
      "<order><!-- </order> --><?p </order>?><a/></order>",
    ]) {
      expect(await write(await read(body))).toBe(body);
    }
  });

  it("refuses a body over maxBytes before it decodes it", async () => {
    const latin1 = new Uint8Array([...bytes("<order>"), 0xe9, ...bytes("</order>")]);
    const refused = await refusal(read(latin1, { maxBytes: latin1.byteLength - 1 }));
    expect(refused.code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("<order/>")]);
    await expect(read(bom, { maxBytes: 8 })).resolves.toBeDefined();
    expect((await refusal(read(bom, { maxBytes: 7 }))).code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
  });

  it("refuses nesting deeper than maxDepth and more elements than maxElements", async () => {
    const nested = "<a><b><c><d/></c></b></a>";
    await expect(read(nested, { maxDepth: 4 })).resolves.toBeDefined();
    expect((await refusal(read(nested, { maxDepth: 3 }))).code).toBe(
      "ELEMENT_DEPTH_LIMIT_EXCEEDED",
    );
    const wide = `<a>${"<b/>".repeat(10)}</a>`;
    await expect(read(wide, { maxElements: 11 })).resolves.toBeDefined();
    expect((await refusal(read(wide, { maxElements: 10 }))).code).toBe("NODE_COUNT_LIMIT_EXCEEDED");
  });
});

describe("format: xml, write", () => {
  it("writes an untouched document back byte for byte", async () => {
    for (const body of [
      ORDER,
      `${BOM}${ORDER}\r\n`,
      "<order/>",
      '<order\tid="TEST-ORDER-003"\n/>\n\n',
      "<order>\r<a>\u0085</a> </order>",
      "<?xml version='1.0'?><order>café \u{1f600}</order>",
    ]) {
      expect(await write(await read(body))).toBe(body);
    }
  });

  it("writes a changed document with the change, as XML that reads back", async () => {
    const document = await read(ORDER);
    document.documentElement?.setAttribute("status", "sent");
    const written = await write(document);
    expect(written).not.toBe(ORDER);
    expect(written).toContain('status="sent"');
    const again = await read(written);
    expect(again.documentElement?.getAttribute("status")).toBe("sent");
    expect(again.documentElement?.getAttribute("id")).toBe("TEST-ORDER-001");
    expect(again.getElementsByTagName("name")[0]?.textContent).toBe("TESTPATIENT & ALPHA");
    expect(again.getElementsByTagName("note")[0]?.textContent).toBe("x < y");
  });

  it("writes a change back to the original value as the original bytes", async () => {
    const document = await read(ORDER);
    const root = document.documentElement;
    root?.setAttribute("status", "sent");
    root?.setAttribute("status", "new");
    expect(await write(document)).toBe(ORDER);
  });

  it("escapes markup a transform puts in text and attributes", async () => {
    const document = await read("<order/>");
    const root = document.documentElement;
    root?.setAttribute("note", '"<&>');
    root?.appendChild(document.createTextNode("</order><injected/>&lab;"));
    const again = await read(await write(document));
    expect(again.documentElement?.getAttribute("note")).toBe('"<&>');
    expect(again.documentElement?.textContent).toBe("</order><injected/>&lab;");
    expect(again.getElementsByTagName("injected")).toHaveLength(0);
  });

  it("refuses a document it cannot write as XML, naming nothing it holds", async () => {
    for (const added of ["TEST-VALUE\u0001", "TEST-VALUE\r", "TEST-VALUE\uD800", "TEST-VALUE￾"]) {
      const document = await read("<order/>");
      document.documentElement?.appendChild(document.createTextNode(added));
      const refused = await refusal(write(document));
      expect(refused.code).toBe("XML_NOT_WRITABLE");
      expect(refused.text).not.toContain("TEST-VALUE");
    }
    const attribute = await read("<order/>");
    attribute.documentElement?.setAttribute("note", "TEST-VALUE\u0002");
    expect((await refusal(write(attribute))).code).toBe("XML_NOT_WRITABLE");
  });

  it("refuses a document whose text the reader would refuse, or that names a forbidden reference", async () => {
    const declared = await read("<order/>");
    declared.documentElement?.appendChild(declared.createComment("<!DOCTYPE TEST-VALUE>"));
    const refused = await refusal(write(declared));
    expect(refused.code).toBe("XML_NOT_WRITABLE");
    expect(refused.text).toContain("XXE_OR_DTD_PRESENT");
    expect(refused.text).not.toContain("TEST-VALUE");
    for (const reference of ["&#x1;", "&#2;", "&#99999999;"]) {
      const document = await read("<order/>");
      document.documentElement?.appendChild(document.createCDATASection(reference));
      expect((await refusal(write(document))).code).toBe("XML_NOT_WRITABLE");
    }
    const allowed = await read("<order/>");
    allowed.documentElement?.appendChild(allowed.createCDATASection("&#65;&#x42;"));
    expect(await write(allowed)).toBe("<order><![CDATA[&#65;&#x42;]]></order>");
  });

  it("refuses a document its serializer throws on, naming nothing it holds", async () => {
    class Unwritable {
      readonly nodeType = 9;
      readonly documentElement = null;
      toString(): string {
        throw new Error("TEST-VALUE");
      }
    }
    const refused = await refusal(write(new Unwritable()));
    expect(refused.code).toBe("XML_NOT_WRITABLE");
    expect(refused.text).not.toContain("TEST-VALUE");
  });

  it("leaves a plain object shaped like a document to the channel's format", async () => {
    const shaped = { nodeType: 9, documentElement: null };
    expect(text(await encode("json", shaped))).toBe('{"nodeType":9,"documentElement":null}');
  });

  it("refuses a comment or processing instruction that would write as other markup", async () => {
    const changes: ((document: XmlDocument) => unknown)[] = [
      (d) => d.documentElement?.appendChild(d.createComment("TEST-VALUE --> <b/> <!-- y")),
      (d) => d.documentElement?.appendChild(d.createComment("TEST-VALUE -- y")),
      (d) => d.documentElement?.appendChild(d.createComment("TEST-VALUE-")),
      (d) =>
        d.documentElement?.appendChild(
          d.createProcessingInstruction("p", "TEST-VALUE ?> <b/> <?q y"),
        ),
      (d) =>
        d.documentElement?.appendChild(d.createProcessingInstruction("p?><b/><?q", "TEST-VALUE")),
      (d) => d.documentElement?.appendChild(d.createProcessingInstruction("xml", "TEST-VALUE")),
      (d) => d.documentElement?.appendChild(d.createProcessingInstruction("XmL", "TEST-VALUE")),
      (d) => d.appendChild(d.createProcessingInstruction("xml", 'version="1.0"')),
      (d) =>
        d.insertBefore(
          d.createProcessingInstruction("xml", 'version="1.0"?><b/><?q TEST-VALUE'),
          d.documentElement,
        ),
      (d) => d.appendChild(d.createTextNode("TEST-VALUE")),
      (d) => d.appendChild(d.createCDATASection("TEST-VALUE")),
    ];
    for (const change of changes) {
      const document = await read("<a/>");
      change(document);
      const refused = await refusal(write(document));
      expect(refused.code).toBe("XML_NOT_WRITABLE");
      expect(refused.text).not.toContain("TEST-VALUE");
    }
  });

  it("writes comments, processing instructions and split text that read back the same", async () => {
    const document = await read("<a/>");
    const root = document.documentElement;
    root?.appendChild(document.createComment(" a - b "));
    root?.appendChild(document.createProcessingInstruction("p", "x ? > y"));
    root?.appendChild(document.createTextNode("one "));
    root?.appendChild(document.createTextNode(""));
    root?.appendChild(document.createCDATASection(""));
    root?.appendChild(document.createTextNode("two"));
    root?.appendChild(document.createElementNS("urn:example:other", "p:b"));
    const written = await write(document);
    expect(written).toBe(
      '<a><!-- a - b --><?p x ? > y?>one <![CDATA[]]>two<p:b xmlns:p="urn:example:other"/></a>',
    );
  });

  it("refuses a document that reads back with other names, namespaces or data", async () => {
    // createElement makes an element in no namespace, which a default namespace would take in.
    const namespaced = await read("<order xmlns='urn:example:orders'/>");
    namespaced.documentElement?.appendChild(namespaced.createElement("note"));
    expect((await refusal(write(namespaced))).code).toBe("XML_NOT_WRITABLE");
    const same = await read("<order xmlns='urn:example:orders'/>");
    same.documentElement?.appendChild(same.createElementNS("urn:example:orders", "note"));
    expect(await write(same)).toBe('<order xmlns="urn:example:orders"><note/></order>');
    // A CDATA section whose data is changed to hold the end of a section after it was made.
    const section = await read("<a/>");
    const cdata = section.createCDATASection("TEST-VALUE");
    section.documentElement?.appendChild(cdata);
    cdata.appendData("]]><b/>");
    const refused = await refusal(write(section));
    expect(refused.code).toBe("XML_NOT_WRITABLE");
    expect(refused.text).not.toContain("TEST-VALUE");
  });

  it("writes a changed document's declaration as UTF-8, whatever it named", async () => {
    for (const [declared, written] of [
      ['<?xml version="1.0" encoding="ISO-8859-1"?>', '<?xml version="1.0" encoding="UTF-8"?>'],
      [
        "<?xml version='1.0' encoding='UTF-16' standalone='yes'?>",
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>",
      ],
      ['<?xml version="1.0" encoding="utf-8"?>', '<?xml version="1.0" encoding="utf-8"?>'],
      ['<?xml version="1.0"?>', '<?xml version="1.0"?>'],
    ] as const) {
      const body = `${declared}\n<a/>`;
      const untouched = await read(body);
      expect(await write(untouched)).toBe(body);
      const document = await read(body);
      document.documentElement?.setAttribute("n", "TESTÉ");
      const out = await encode("xml", document, {});
      expect(text(out)).toBe(`${written}\n<a n="TESTÉ"/>`);
      expect(out).toEqual(bytes(`${written}\n<a n="TESTÉ"/>`));
    }
    const built = await read("<a/>");
    built.insertBefore(
      built.createProcessingInstruction("xml", 'version="1.0" encoding="UTF-16"'),
      built.documentElement,
    );
    expect(await write(built)).toBe('<?xml version="1.0" encoding="UTF-8"?><a/>');
  });

  it("writes a document a transform builds on a channel of another format", async () => {
    const source = await read("<order/>");
    const built = source.implementation.createDocument(null, "result", null);
    built.documentElement?.setAttribute("id", "TEST-RESULT-001");
    for (const format of ["xml", "json", "text"] as const) {
      expect(text(await encode(format, built))).toBe('<result id="TEST-RESULT-001"/>');
    }
  });
});

describe("format: xml, in a transform and a worker", () => {
  const workers: ChannelWorker[] = [];
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });

  it("types an xml transform's message as an XmlDocument", () => {
    expectTypeOf<MessageFor<"xml">>().toEqualTypeOf<XmlDocument>();
    const transform = ((document) =>
      document.documentElement?.getAttribute("status") === "new"
        ? document
        : null) satisfies TransformFor<"xml">;
    expectTypeOf(transform).toBeFunction();
  });

  it("hands a transform the document and writes back what it returns", async () => {
    const outputs = await runTransform(
      (message) => {
        const document = message as XmlDocument;
        document.documentElement?.setAttribute("status", "sent");
        return document;
      },
      "xml",
      bytes("<order id='TEST-ORDER-004' status='new'/>"),
    );
    expect(outputs.map(text)).toEqual(['<order id="TEST-ORDER-004" status="sent"/>']);
  });

  it("reads with the channel's settings in the worker thread", async () => {
    const body = bytes(`<order>${"x".repeat(100)}</order>`);
    const capped = new ChannelWorker({
      channel: "xml-capped",
      transformFile: undefined,
      format: "xml",
      xml: { maxBytes: 64 },
      timeoutMs: 5_000,
      memoryMb: 256,
    });
    const open = new ChannelWorker({
      channel: "xml-open",
      transformFile: undefined,
      format: "xml",
      timeoutMs: 5_000,
      memoryMb: 256,
    });
    workers.push(capped, open);
    const refused = await capped.run(body);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.code).toBe("INPUT_SIZE_LIMIT_EXCEEDED");
    expect(await open.run(body)).toEqual({ ok: true, outputs: [body] });
  });

  it("runs an xml channel end to end: a file in, the transform, a .xml file out", async () => {
    const root = await makeProject({
      "channels/orders/channel.yaml":
        "format: xml\nxml: { maxBytes: 4096, maxDepth: 16 }\n" +
        "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\ntransform: ./transform.ts\n" +
        "destinations:\n  - file: { dir: ../../data/out }\n",
      "channels/orders/transform.ts":
        "export default (document) =>\n" +
        '  document.documentElement.getAttribute("status") === "new" ? document : null;\n',
    });
    const project = await loadProject(root);
    expect(project.channels[0]?.xml).toEqual({ maxBytes: 4096, maxDepth: 16 });
    const store = await (
      await testStorage(TEST_DATABASES[0] as never, project.databaseFile)
    ).open();
    const engine = new Engine({ project, store, logger: captureLogger().logger });
    try {
      await engine.start();
      await dropFile(join(root, "data", "inbox", "new.xml"), ORDER);
      await engine.tick();
      expect(await readdir(join(root, "data", "out"))).toEqual(["1-1.xml"]);
      expect(await readFile(join(root, "data", "out", "1-1.xml"), "utf8")).toBe(ORDER);
    } finally {
      await engine.stop();
      await store.close();
    }
  });

  it("refuses an xml: block on a channel of another format", async () => {
    const root = await makeProject({
      "channels/orders/channel.yaml":
        "format: text\nxml: { maxBytes: 4096 }\n" +
        "source:\n  file: { dir: ../../data/inbox, minAge: 0 }\n" +
        "destinations:\n  - file: { dir: ../../data/out }\n",
    });
    await expect(loadProject(root)).rejects.toThrow("an xml: block needs format: xml");
  });
});
