import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  examplePrintFindings,
  readPrintConfig,
  sampleBlocks,
  samplePrintFindings,
} from "@cosyte/script-utils/docs-content";
import { describe, expect, it } from "vitest";

/**
 * No example prints a value that identifies a person, or a whole message.
 *
 * The rule is `example-print` from `@cosyte/script-utils/docs-content`, with this repository's own
 * names added in `cosyte-docs-content.config.json`: a source's facts (a file's name, headers, a peer's
 * address or certificate name), the channel's configuration, and a body, an output or a context
 * printed whole. It reads every TypeScript and JavaScript sample a reader copies: the README, the
 * hand-written pages, the example projects' READMEs, every script and transform in `examples/` and
 * the starter `pathways init` writes, and the samples in the doc comments under `src/`, which the
 * reference on docs.cosyte.com is generated from. What an example prints is an id the engine made, a
 * code, a count, a size or a name the project chose; a field that identifies a person is checked on
 * or handed on, never printed.
 */
const root = join(import.meta.dirname, "..");
const { accessors, wholeValues, printers } = readPrintConfig(root);
const extra = { accessors, wholeValues, printers };

interface Sample {
  readonly where: string;
  readonly code: string;
}

/** Every file under `dir` whose name `keep` accepts, recursively, outside `node_modules`. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && keep(d.name) && !d.parentPath.includes("node_modules"))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

const isScript = (name: string): boolean => /\.(?:ts|mts|js|mjs)$/u.test(name);

/** The fenced samples inside the `/** *\/` comments of a TypeScript text, comment stars removed. */
function commentSamples(label: string, source: string): Sample[] {
  const out: Sample[] = [];
  let body: string[] | undefined;
  let start = 0;
  source.split("\n").forEach((line, i) => {
    const text = /^\s*\*\s?(.*)$/u.exec(line)?.[1];
    if (text === undefined) {
      body = undefined;
      return;
    }
    if (/^\s*```/u.test(text)) {
      if (body === undefined) {
        body = [];
        start = i + 2;
      } else {
        out.push({ where: `${label}:${String(start)}`, code: body.join("\n") });
        body = undefined;
      }
      return;
    }
    body?.push(text);
  });
  return out;
}

/** The README and the hand-written pages, as the docs-content check reads them. */
function pageFindings(): string[] {
  const dir = join(root, "docs-content");
  const pages = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  return examplePrintFindings({ pages, readme }, extra).map(
    (f) => `${f.file}:${String(f.line)}: ${f.message}`,
  );
}

function exampleReadmeSamples(): Sample[] {
  return filesUnder(join(root, "examples"), (name) => name === "README.md").flatMap((file) =>
    sampleBlocks(readFileSync(file, "utf8")).map((b) => ({
      where: `${relative(root, file)}:${String(b.line)}`,
      code: b.code,
    })),
  );
}

function scriptFiles(dir: string): Sample[] {
  return filesUnder(join(root, dir), isScript).map((file) => ({
    where: relative(root, file),
    code: readFileSync(file, "utf8"),
  }));
}

function docCommentSamples(): Sample[] {
  return filesUnder(join(root, "src"), (name) => name.endsWith(".ts")).flatMap((file) =>
    commentSamples(relative(root, file), readFileSync(file, "utf8")),
  );
}

function findings(samples: readonly Sample[]): string[] {
  return samples.flatMap((s) =>
    samplePrintFindings(s.code, extra).map(
      (f) => `${s.where} (sample line ${String(f.line)}): ${f.message}`,
    ),
  );
}

describe("no example prints a value that identifies a person or a whole message", () => {
  it("is required by this repository's configuration", () => {
    expect(readPrintConfig(root).required).toBe(true);
  });

  it("the README and the hand-written pages", () => {
    const found = pageFindings();
    expect(found, found.join("\n")).toEqual([]);
  });

  it("the example projects' READMEs", () => {
    const samples = exampleReadmeSamples();
    expect(findings(samples), findings(samples).join("\n")).toEqual([]);
  });

  it("the scripts and transforms of the example projects", () => {
    const samples = scriptFiles("examples");
    expect(samples.length).toBeGreaterThanOrEqual(20);
    expect(findings(samples), findings(samples).join("\n")).toEqual([]);
  });

  it("the starter project pathways init writes", () => {
    const samples = scriptFiles(join("templates", "starter"));
    expect(samples.length).toBeGreaterThan(0);
    expect(findings(samples), findings(samples).join("\n")).toEqual([]);
  });

  it("the doc-comment samples under src/, which the reference is generated from", () => {
    const samples = docCommentSamples();
    expect(samples.length).toBeGreaterThan(100);
    expect(findings(samples), findings(samples).join("\n")).toEqual([]);
  });
});

describe("the rule reads what this repository's samples print", () => {
  it("finds a print planted in a doc comment", () => {
    const planted = [
      "/**",
      " * @example",
      " * ```ts",
      " * const msg = parseHL7(raw);",
      " * console.log(msg.patient.mrn);",
      " * ```",
      " */",
    ].join("\n");
    const samples = commentSamples("planted.ts", planted);
    expect(samples).toEqual([
      { where: "planted.ts:4", code: "const msg = parseHL7(raw);\nconsole.log(msg.patient.mrn);" },
    ]);
    expect(findings(samples)).toEqual([expect.stringContaining("planted.ts:4 (sample line 2)")]);
  });

  it.each([
    ["a source file's name", "console.log(ctx.source.name);"],
    ["a sender's headers", "console.log(ctx.source.headers);"],
    ["a peer's certificate name", "console.log(ctx.source.tlsPeerSubject);"],
    ["a peer's address", "console.log(ctx.source.remoteAddress);"],
    ["the channel's configuration", "console.log(ctx.config.apiKey);"],
    ["a whole context", "console.log(ctx);"],
    ["a request's body", "process.stdout.write(body.toString());"],
    ["a transform's output", "console.log(JSON.stringify(output));"],
    ["a whole message", "console.log(msg.toString());"],
  ])("finds %s printed", (_, code) => {
    expect(findings([{ where: "planted.ts", code }])).toHaveLength(1);
  });

  it.each([
    ["the engine's message id", "console.log(ctx.messageId);"],
    ["the attempt", "console.log(ctx.attempt);"],
    ["a body's size", "process.stdout.write(`${String(body.length)} bytes\\n`);"],
    ["a message type", 'console.log(msg.get("MSH.9.1"));'],
  ])("passes %s", (_, code) => {
    expect(findings([{ where: "planted.ts", code }])).toEqual([]);
  });
});
