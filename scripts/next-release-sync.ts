/**
 * Keep the README's "In the next release" section to what no release has shipped yet, move what a
 * release shipped up into "What the latest release ships", and name the new version as the one on
 * npm. npm shows the README of the version it serves, so the Version Packages commit has to say what
 * that version holds.
 *
 * Each next-release bullet names the changesets it stands for in an HTML comment,
 * `<!-- changesets: xml-format -->`. The release's `version` script runs `changeset version`, which
 * consumes the pending changesets into CHANGELOG.md, and then `scripts/sync-next-release.ts`, so the
 * Version Packages commit carries this rewrite, and `test/release-status.test.ts` holds on it.
 *
 * The rules:
 *
 * - A bullet whose changesets are all consumed (their files gone from `.changeset/`) moves to the end
 *   of the list under "What the latest release ships", without its comment. With no such list to
 *   hold it, the step refuses rather than lose it.
 * - A bullet that still names a pending changeset stays. If it also names a consumed one, its comment
 *   drops that one: release-status fails a next-release bullet that names a consumed changeset, and
 *   the bullet's work is not all out yet. A bullet that names none stays, for release-status to
 *   report.
 * - Bullets separated by blank lines are one list, and the kept ones keep that spacing.
 * - While a bullet stays, each version in the section's lead text becomes the new one ("not in
 *   0.0.3" reads "not in 0.0.4"). Once none stays, the section and its Contents line go: an empty
 *   section says nothing a reader can use, and the next change that needs a bullet adds it back.
 * - Every version the README names as the one on npm ("0.0.3, the version on npm", "0.0.3 is on
 *   npm") becomes the new one, with or without a next-release section.
 * - A README with CRLF line endings is written back with CRLF; one that mixes line endings is
 *   refused.
 *
 * Reports name the file and counts, never the file's text.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADING = "## In the next release";

const LATEST_HEADING = "## What the latest release ships";

/** The Contents entry that links to the section. */
const CONTENTS_LINE = /^- \[In the next release\]\(#in-the-next-release\)\n/m;

/** The changeset ids a bullet names, as `release-status.test.ts` reads them. */
const CHANGESETS = /<!--\s*changesets:\s*([\w\s,-]+?)\s*-->/;

/** Every changesets comment on a line, with the space before it. */
const ANY_CHANGESETS = /\s*<!--\s*changesets:\s*[\w\s,-]+?\s*-->/g;

/** A version as Changesets writes one, prerelease included. */
const VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

/** A version the README names as the one on npm, as `release-status.test.ts` reads it. */
const ON_NPM =
  /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?=,\s+the\s+version\s+on\s+npm\b|\s+is\s+on\s+npm\b)/g;

/** A version Changesets can write, with nothing a replacement could read as a pattern. */
const USABLE_VERSION = /^[0-9A-Za-z.+-]+$/;

/** What a rewrite produced: the new text with what moved, or why there is none. */
export type NextReleaseRewrite =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly text: string;
      /** Bullets moved up into What the latest release ships. */
      readonly moved: number;
      /** Bullets left in In the next release. */
      readonly kept: number;
      /** Kept bullets whose comment no longer names a consumed changeset. */
      readonly narrowed: number;
    }
  | { readonly ok: false; readonly reason: string };

/** One bullet of a list: its lines, joined, and the changesets it names. */
interface Bullet {
  readonly text: string;
  readonly ids: readonly string[];
}

/** A section body split into the lead before the first bullet, the bullets, and the rest. */
interface SplitSection {
  readonly lead: string;
  readonly bullets: readonly Bullet[];
  /** Whether blank lines separate the bullets. */
  readonly loose: boolean;
  readonly tail: string | undefined;
}

const isBullet = (line: string): boolean => line.startsWith("- ");
const isIndented = (line: string): boolean => /^\s+\S/.test(line);

/** Split a section body into the lead before the first bullet, the bullets, and the rest. */
function splitSection(body: string): SplitSection {
  const lines = body.split("\n");
  const first = lines.findIndex(isBullet);
  if (first === -1) return { lead: body, bullets: [], loose: false, tail: undefined };
  // Each bullet is its `- ` line and the indented lines under it. Blank lines carry the list on
  // when a bullet or an indented line follows them; any other line ends it.
  const groups: string[][] = [];
  let loose = false;
  let i = first;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBullet(line)) {
      groups.push([line]);
      i += 1;
      continue;
    }
    if (isIndented(line)) {
      groups.at(-1)?.push(line);
      i += 1;
      continue;
    }
    if (line.trim() !== "") break;
    let j = i;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
    const after = lines[j];
    if (after === undefined) break;
    if (isBullet(after)) loose = true;
    else if (isIndented(after)) groups.at(-1)?.push(...lines.slice(i, j));
    else break;
    i = j;
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
    loose,
    tail: i < lines.length ? lines.slice(i).join("\n") : undefined,
  };
}

/** Put a split section back together under its heading, with `bullets` as its list. */
function joinSection(
  heading: string,
  lead: string,
  split: SplitSection,
  bullets: readonly string[],
): string {
  const parts = [`${heading}\n${lead}`, bullets.join(split.loose ? "\n\n" : "\n")];
  if (split.tail !== undefined) parts.push(split.tail);
  return parts.join("\n");
}

/** Where a `## ` section sits in `text`, from its heading to the next one, or undefined. */
function locate(
  text: string,
  heading: string,
): { from: number; to: number; last: boolean } | undefined {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return undefined;
  const from = start + 1;
  const next = text.indexOf("\n## ", from);
  return next === -1 ? { from, to: text.length, last: true } : { from, to: next + 1, last: false };
}

/** A released bullet as it reads under What the latest release ships: its comment gone. */
function withoutComment(bullet: string): string {
  return bullet
    .split("\n")
    .flatMap((line) => {
      const bare = line.replace(ANY_CHANGESETS, "").trimEnd();
      return bare === "" && line.trim() !== "" ? [] : [bare];
    })
    .join("\n");
}

/** `text` with `moved` at the end of the What the latest release ships list, or undefined. */
function moveUp(text: string, moved: readonly string[]): string | undefined {
  if (moved.length === 0) return text;
  const at = locate(text, LATEST_HEADING);
  if (at === undefined) return undefined;
  const split = splitSection(text.slice(at.from + LATEST_HEADING.length + 1, at.to));
  if (split.bullets.length === 0) return undefined;
  const bullets = [...split.bullets.map((b) => b.text), ...moved];
  const rebuilt = joinSection(LATEST_HEADING, split.lead, split, bullets);
  return `${text.slice(0, at.from)}${rebuilt}${text.slice(at.to)}`;
}

/** The rewrite on a README with LF line endings. */
function rewriteLf(readme: string, pending: readonly string[], version: string): NextReleaseRewrite {
  let text = readme;
  const moved: string[] = [];
  let kept = 0;
  let narrowed = 0;
  const at = locate(readme, HEADING);
  if (at !== undefined) {
    const split = splitSection(readme.slice(at.from + HEADING.length + 1, at.to));
    const pendingIds = new Set(pending);
    const staying: string[] = [];
    for (const bullet of split.bullets) {
      const open = bullet.ids.filter((id) => pendingIds.has(id));
      if (bullet.ids.length > 0 && open.length === 0) {
        moved.push(withoutComment(bullet.text));
      } else if (open.length < bullet.ids.length) {
        narrowed += 1;
        staying.push(
          bullet.text.replace(CHANGESETS, () => `<!-- changesets: ${open.join(", ")} -->`),
        );
      } else {
        staying.push(bullet.text);
      }
    }
    kept = staying.length;
    if (kept === 0) {
      let before = readme.slice(0, at.from);
      if (at.last) before = `${before.replace(/(?:\n+---)?\s*$/, "")}\n`;
      text = `${before}${readme.slice(at.to)}`.replace(CONTENTS_LINE, "");
    } else {
      const lead = split.lead.replace(VERSION, () => version);
      const section = joinSection(HEADING, lead, split, staying);
      text = `${readme.slice(0, at.from)}${section}${readme.slice(at.to)}`;
    }
  }
  const withMoved = moveUp(text, moved);
  if (withMoved === undefined) {
    return {
      ok: false,
      reason: `${String(moved.length)} released bullet(s) have no What the latest release ships list to move into`,
    };
  }
  text = withMoved.replace(ON_NPM, () => version);
  return { ok: true, changed: text !== readme, text, moved: moved.length, kept, narrowed };
}

/**
 * Move each next-release bullet whose changesets are all consumed, given the ones still pending, up
 * into What the latest release ships, and name `version` as the one on npm.
 *
 * @example
 * ```ts
 * const result = rewriteNextRelease(readme, ["xml-format"], "0.0.4");
 * // result.ok && result.text keeps the xml-format bullet and names 0.0.4 as the version on npm
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
  if (!readme.includes("\r")) return rewriteLf(readme, pending, version);
  const lf = readme.replace(/\r\n/g, "\n");
  if (lf.includes("\r") || lf.split("\n").length !== readme.split("\r\n").length) {
    return { ok: false, reason: "it mixes CRLF and LF line endings" };
  }
  const result = rewriteLf(lf, pending, version);
  return result.ok ? { ...result, text: result.text.replace(/\n/g, "\r\n") } : result;
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
    const narrowed =
      result.narrowed === 0
        ? ""
        : `, ${String(result.narrowed)} naming only pending changesets`;
    return {
      code: 0,
      message: `sync-next-release: README.md moved ${String(result.moved)} released bullet(s) up; ${String(result.kept)} left${narrowed}; the version lines name ${version}`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unparsable file";
    return { code: 1, message: `sync-next-release: could not read or write: ${code}` };
  }
}
