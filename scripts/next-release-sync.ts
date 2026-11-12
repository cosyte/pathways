/**
 * Keep the README's "In the next release" section to what no release has shipped yet.
 *
 * Each bullet names the changesets it stands for in an HTML comment,
 * `<!-- changesets: xml-format -->`. The release's `version` script runs `changeset version`, which
 * consumes the pending changesets into CHANGELOG.md, and then `scripts/sync-next-release.ts`, so the
 * Version Packages commit drops the bullets it released in the same commit, and
 * `test/release-status.test.ts` holds on it.
 *
 * The rules: a bullet is dropped once every changeset it names is consumed (its file is gone from
 * `.changeset/`); a bullet that still names a pending changeset stays, and so does one that names
 * none, which the release-status test reports on its own. While a bullet stays, each version in the
 * section's lead text becomes the new one ("not in 0.0.3" reads "not in 0.0.4"). Once none stays,
 * the section and its Contents line go: an empty section says nothing a reader can use, and the next
 * change that needs a bullet adds the section back. A README with no such section is not written.
 * Reports name the file and counts, never the file's text.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADING = "## In the next release";

/** The Contents entry that links to the section. */
const CONTENTS_LINE = /^- \[In the next release\]\(#in-the-next-release\)\n/m;

/** The changeset ids a bullet names, as `release-status.test.ts` reads them. */
const CHANGESETS = /<!--\s*changesets:\s*([\w\s,-]+?)\s*-->/;

/** A version as Changesets writes one, prerelease included. */
const VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

/** A version Changesets can write, with nothing a replacement could read as a pattern. */
const USABLE_VERSION = /^[0-9A-Za-z.+-]+$/;

/** What a rewrite produced: the new text with what moved, or why there is none. */
export type NextReleaseRewrite =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly text: string;
      readonly dropped: number;
      readonly kept: number;
    }
  | { readonly ok: false; readonly reason: string };

/** One bullet of the section: its lines, joined, and the changesets it names. */
interface Bullet {
  readonly text: string;
  readonly ids: readonly string[];
}

/** Split a section body into the lead before the first bullet, the bullets, and the rest. */
function splitSection(body: string): {
  lead: string;
  bullets: Bullet[];
  tail: string | undefined;
} {
  const lines = body.split("\n");
  const first = lines.findIndex((line) => line.startsWith("- "));
  if (first === -1) return { lead: body, bullets: [], tail: undefined };
  // Each bullet is its `- ` line and the indented lines under it; the list ends at any other line.
  const groups: string[][] = [];
  let current: string[] = [];
  let end = first;
  for (const line of lines.slice(first)) {
    if (line.startsWith("- ")) {
      current = [line];
      groups.push(current);
    } else if (/^\s+\S/.test(line)) current.push(line);
    else break;
    end += 1;
  }
  const bullets = groups.map((own) => {
    const text = own.join("\n");
    const match = CHANGESETS.exec(text);
    const ids = match === null ? [] : String(match[1]).split(/[\s,]+/);
    return { text, ids };
  });
  return {
    lead: lines.slice(0, first).join("\n"),
    bullets,
    tail: end < lines.length ? lines.slice(end).join("\n") : undefined,
  };
}

/**
 * Drop each next-release bullet whose changesets are all consumed, given the ones still pending.
 *
 * @example
 * ```ts
 * const result = rewriteNextRelease(readme, ["xml-format"], "0.0.4");
 * // result.ok && result.text keeps the xml-format bullet and its lead names 0.0.4
 * ```
 */
export function rewriteNextRelease(
  readme: string,
  pending: readonly string[],
  version: string,
): NextReleaseRewrite {
  if (!USABLE_VERSION.test(version)) {
    return { ok: false, reason: "package.json has no usable version" };
  }
  const start = readme.indexOf(`\n${HEADING}\n`);
  if (start === -1) return { ok: true, changed: false, text: readme, dropped: 0, kept: 0 };
  const from = start + 1;
  const next = readme.indexOf("\n## ", from);
  const to = next === -1 ? readme.length : next + 1;
  const section = readme.slice(from, to);
  const body = section.slice(HEADING.length + 1);
  const { lead, bullets, tail } = splitSection(body);

  const pendingIds = new Set(pending);
  const kept = bullets.filter((b) => b.ids.length === 0 || b.ids.some((id) => pendingIds.has(id)));
  const dropped = bullets.length - kept.length;

  if (kept.length === 0) {
    let before = readme.slice(0, from);
    const after = readme.slice(to);
    if (next === -1) before = `${before.replace(/(?:\n+---)?\s*$/, "")}\n`;
    const text = `${before}${after}`.replace(CONTENTS_LINE, "");
    return { ok: true, changed: text !== readme, text, dropped, kept: 0 };
  }

  const newLead = lead.replace(VERSION, () => version);
  const parts = [`${HEADING}\n${newLead}`, ...kept.map((b) => b.text)];
  if (tail !== undefined) parts.push(tail);
  const newSection = parts.join("\n");
  const text = `${readme.slice(0, from)}${newSection}${readme.slice(to)}`;
  return { ok: true, changed: text !== readme, text, dropped, kept: kept.length };
}

/** The ids of the changesets still pending in a changeset folder, its own README aside. */
export function pendingChangesets(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -".md".length))
    .sort();
}

/** What a sync did: the exit code and the one line to report. */
export interface NextReleaseResult {
  readonly code: 0 | 1;
  readonly message: string;
}

/**
 * Sync `README.md` under `root` to the changesets pending in `root/.changeset` and the version in
 * `root/package.json`.
 *
 * @example
 * ```ts
 * const { code, message } = syncNextRelease(process.cwd());
 * ```
 */
export function syncNextRelease(root: string): NextReleaseResult {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : undefined;
    if (typeof version !== "string") {
      return { code: 1, message: "sync-next-release: package.json has no usable version" };
    }
    const path = join(root, "README.md");
    const pending = pendingChangesets(join(root, ".changeset"));
    const result = rewriteNextRelease(readFileSync(path, "utf8"), pending, version);
    if (!result.ok) return { code: 1, message: `sync-next-release: README.md: ${result.reason}` };
    if (!result.changed) {
      return { code: 0, message: "sync-next-release: README.md already lists only pending work" };
    }
    writeFileSync(path, result.text);
    const what =
      result.kept === 0
        ? "the section is gone"
        : `${String(result.kept)} left, the lead names ${version}`;
    return {
      code: 0,
      message: `sync-next-release: README.md dropped ${String(result.dropped)} released bullet(s); ${what}`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unparsable file";
    return { code: 1, message: `sync-next-release: could not read or write: ${code}` };
  }
}
