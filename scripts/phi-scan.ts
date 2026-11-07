#!/usr/bin/env tsx
/**
 * `@cosyte/pathways` PHI scanner: the CI / pre-commit half of the PHI commit-gate.
 *
 * ===========================================================================
 * WHAT IS IN THIS FILE, AND WHAT IS NOT.
 *
 * The MACHINERY is `@cosyte/script-utils/phi-scan`, a devDependency: argument
 * parsing, the allow-list and override log, target enumeration on all three
 * routes, the union of the working-tree walk with the bytes git carries, content
 * deduplication, THE COMPLETENESS RULE, every refusal, and the cross-cutting
 * SSN/email FLOOR. Read that module's docblock for what each rule closes and
 * what it costs; nothing is restated here, because a claim written down twice is
 * a claim that drifts.
 *
 * IT IS A DEPENDENCY AND NOT A COPY, AND THAT IS THE POINT. This file used to
 * carry the whole engine, and `scripts/parser-template/` is a SCAFFOLD rather
 * than a dependency, so every parser repo held its own copy. A newly-found
 * escape therefore cost one pull request and one adversarial review PER REPO,
 * and three escape classes have been paid for that way already. Now it costs one
 * pull request in `cosyte/config` and a version bump here.
 *
 * WHAT STAYS LOCAL is what genuinely differs: THE FIVE PER-REPO AXES below, and
 * the STANDARD-SPECIFIC FIELD DETECTION, which `detect` at the bottom of this
 * file hands to `scripts/phi-detect.ts`.
 * ===========================================================================
 *
 * ===========================================================================
 * WHAT IT DETECTS
 * ===========================================================================
 *
 *   Two layers, both run over every target the engine reads:
 *
 *     (1) the engine's cross-cutting FLOOR: a dashed Social Security Number,
 *         and an email at a domain the allow-list does not declare;
 *     (2) FIELD-LEVEL detection for the four formats Pathways parses, in
 *         `scripts/phi-detect.ts`: the person names, dates of birth,
 *         identifiers and phones of HL7 v2, FHIR, X12 and C-CDA, read from
 *         whole messages AND from fixtures written inline in TypeScript.
 *
 *   `scripts/phi-detect.ts` lists exactly which fields each format is read
 *   for, what counts as a hit, and what it does not catch (addresses among
 *   them). A green `pnpm phi-scan` means none of THOSE fields holds a value the
 *   allow-list does not declare synthetic; it is not a proof of no PHI.
 *
 *   The mechanism for declaring genuinely-synthetic identifiers is the
 *   allow-list (`scripts/phi-allow-list.txt`): a positive declaration that a
 *   fixture's identifiers are fake, token by token. Every field detector
 *   consults it. A whole-file bypass (`--allow-fixture <path>`) still exists
 *   and still needs a logged entry in `phi-scan-overrides.md`, but it is
 *   RECORDED AND REFUSED rather than honored: it cannot reach exit 0 in any
 *   mode. Declare the tokens; do not withdraw the file.
 *
 * ===========================================================================
 * EXIT CONTRACT, DEFINED HERE AND NOT INHERITED. A scaffolded parser has no
 * history, so this file STATES its contract rather than acquiring one by
 * accident:
 *
 *   0  the scan ran, READ EVERY TARGET IT ENUMERATED, and found nothing.
 *   1  HITS. Reserved for "this corpus contains something that looks like PHI".
 *      It is NOT exclusive: an allow-list, or an override log, that EXISTS but
 *      cannot be READ throws a plain `Error` and takes node's own exit 1, which
 *      a caller reads as "hits found". The engine names that escape rather than
 *      claiming to have closed it.
 *   2  EVERY STATE THE ENGINE RAISES IN WHICH THE SCAN CANNOT ACCOUNT FOR
 *      SOMETHING. The full list is in the engine's `run()` docblock.
 *
 * 1 IS RESERVED BECAUSE CI AND THE PRE-COMMIT HOOK BRANCH ON THE CODE. A caller
 * must be able to tell "PHI was found here" from "this scan is not trustworthy".
 *
 * DO NOT PORT THESE NUMBERS INTO, OR OUT OF, A SIBLING PARSER. The `@cosyte/*`
 * scanners do not agree on them and are not required to. Carrying a number
 * across a repo boundary is how a caller ends up branching on a meaning that
 * repo never assigned. That is why the engine has no default for them.
 * ===========================================================================
 */

import { exemptsMarkdown, runPhiScan, type DetectContext } from "@cosyte/script-utils/phi-scan";

import { detectFields } from "./phi-detect.js";

// ===========================================================================
// ██  THE FIVE PER-REPO AXES  ███████████████████████████████████████████████
// ===========================================================================
//
// A PORT IS NOT A COPY. Five things genuinely differ between the sibling
// `@cosyte/*` scanners, and every one of them is a PARAMETER of the shared
// engine rather than a fork of it. Re-derive each one HERE:
//
//   1. EXIT CODES        `EXIT_CODES`. No default exists, deliberately.
//   2. ROOTS+EXCLUSIONS  `SCAN_ROOTS`, `EXCLUDED_PATHS`, and the READ filter.
//   3. `--staged` SCOPE  `isStagedReadable`.
//   4. GITLINKS          `regularBlobModes`, defaulted by the engine to git's
//                        two regular-blob modes. Nothing to set here.
//   5. EOL NORMALIZATION No parameter: the engine's walk/index deduplication is
//                        BY CONTENT, so a repo whose index carries LF and whose
//                        working tree carries CRLF scans BOTH forms. It is
//                        listed because a port must CHECK it, not skip it.
// ===========================================================================

/** AXIS 1: this repo's exit contract, stated in the header block above. */
const EXIT_CODES = { clean: 0, hits: 1, refuse: 2 } as const;

/**
 * AXIS 2: the roots `all` mode walks.
 *
 * THE WHOLE REPOSITORY, AND THAT IS A DELIBERATE STARTING POINT RATHER THAN A
 * PLACEHOLDER. This template used to ship `["test/fixtures", "src"]`, which was
 * measured against a fresh scaffold: 35 tracked files, ONE of them in scope, so
 * a tracked `test/leak.test.ts` carrying a dashed SSN exited 0 on the sweep. A
 * scaffolded repo has not yet decided what its corpus is, so the only honest
 * scope is everything, and the engine prunes gitignored directories during
 * descent and skips `.git` by name so that costs nothing on a fresh tree.
 *
 * BE EXACT ABOUT WHAT "EVERYTHING" READS, BECAUSE IT IS NOT EVERY TRACKED FILE.
 * Measured on the same fresh scaffold AFTER the widening: 23 of the 35 tracked
 * files are read by the sweep. The other twelve are the ELEVEN `.md` files the
 * shared read exemption drops on both sweeping routes, and the ONE entry in
 * `EXCLUDED_PATHS` below. The `.md` boundary is the engine's own default and
 * moving it is a decision taken there; it is named here so this constant is not
 * read as a claim that nothing is left out.
 *
 * 🛑 NARROWING THIS IS A SCOPE DECISION AND IT IS THE AXIS MOST LIKELY TO BE
 * WRONG. If you narrow it, measure what the narrowing STOPS reading rather than
 * assuming it stops reading nothing. WHAT IT NO LONGER NARROWS IS THE INDEX:
 * `all` mode reads the bytes git carries at EVERY tracked path, whatever the
 * roots say, because a root list is the WALK's scope and the index answers what
 * this repository CARRIES. So narrowing this stops the sweep opening UNTRACKED
 * files outside the roots, and a sibling that widened its walk found tracked
 * files that had never been opened by either route.
 */
const SCAN_ROOTS: readonly string[] = ["."];

/**
 * AXIS 2 (the subtractive half): repo-relative paths NO route reads: not the
 * walk, not the index union, not `--staged`.
 *
 * 🛑 EXCLUDE A LITERAL PATH, NEVER A CLASS. It is tempting to write a predicate
 * ("skip binary blobs", "skip generated files") because it needs no
 * maintenance. A sibling measured what that costs: two of its hand-written
 * sources embed NUL bytes as HMAC domain separators, so git's own binary
 * heuristic calls them binary and a "binary blob" predicate would have dropped
 * them out of the corpus silently. A literal path is reviewable in a diff; a
 * class quietly grows new members.
 *
 * AN ENTRY HERE IS A FILE THE SCAN HAS NO VERDICT ABOUT, so each one carries a
 * comment saying why.
 */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set<string>([
  // The scanner's OWN unit test. It must carry violator-shaped values to prove
  // the floor catches them, so it is a deliberate violator source rather than a
  // fixture: scanning it would report the test's inputs as findings on every
  // run. It is excluded by literal path so that the exclusion is visible in a
  // diff, and it is the ONLY file this template excludes.
  "test/scripts/phi-scan.test.ts",
]);

/**
 * AXIS 3: the READ half of scope for `--staged`, i.e. which regular blobs a
 * COMMIT is blocked on.
 *
 * IT MIRRORS THE SWEEP'S READ FILTER, WHICH IS A CHANGE FROM THIS TEMPLATE'S
 * EARLIER SHAPE AND HAS ITS OWN ARGUMENT. It used to be
 * `test/fixtures/ | src/**.ts`, which on a fresh scaffold covers ONE file, so a
 * developer could commit a tracked test carrying a dashed SSN and the hook
 * passed it green. Widening `--staged` is normally a hook decision taken
 * separately from the sweep, and a sibling has declined it three times for that
 * reason: it changes what a commit is blocked on. Here there is no established
 * commit flow to change, because the repo is being created, so the two routes
 * are given one boundary from the start.
 *
 * 🛑 THIS KEY DECIDES WHAT THE `--staged` ROUTE REFUSES, NOT ONLY WHAT IT READS.
 * The engine's staged non-regular and unmerged refusals key on THIS predicate,
 * because what a commit is blocked on is a hook decision each repo takes for
 * itself. So a staged symbolic link whose name this filter drops is NOT refused
 * on the pre-commit route, and IS refused by `all` mode twice over: the walk
 * classifies it under a scan root, and the index route refuses the tracked
 * mode-120000 record wherever it sits. Widen this filter if you want the
 * pre-commit route to refuse it too. The `all`-mode refusals still key on the
 * ROOT half of scope and on the index, never on a read filter: a link's name is
 * no evidence about what is on the other side of it.
 */
function isStagedReadable(relPath: string): boolean {
  return exemptsMarkdown(relPath);
}

/**
 * THE STANDARD-SPECIFIC FIELD DETECTION: the half the shared engine deliberately
 * does not own, because it differs per healthcare standard. It lives in
 * `scripts/phi-detect.ts` so the suite can drive it in-process.
 *
 * The engine has already run the cross-cutting floor (SSN + email shapes) over
 * `ctx.text`. Hits go through `ctx.hit`, which fills in the locus, and name a
 * field and a rule, never the value.
 *
 * @param ctx The target's text and bytes, the parsed allow-list, and `hit`.
 */
function detect(ctx: DetectContext): void {
  detectFields(ctx);
}

process.exit(
  runPhiScan({
    exitCodes: EXIT_CODES,
    scanRoots: SCAN_ROOTS,
    excludedPaths: EXCLUDED_PATHS,
    isStagedReadable,
    detect,
    // `isWalkReadable` is deliberately NOT set: the engine's default is the
    // shared Markdown exemption, so if that boundary ever moves it moves for
    // every repo at once through a version bump. Override it here only with a
    // measured reason written down beside the override.
  }),
);
