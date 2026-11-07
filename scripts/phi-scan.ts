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
 * the STANDARD-SPECIFIC FIELD DETECTION in `detect` at the bottom of this file.
 * ===========================================================================
 *
 * ===========================================================================
 * ██  STARTER: READ BEFORE YOU RELY ON THIS  ████████████████████████████████
 * ===========================================================================
 *
 *   As shipped, this scanner detects EXACTLY TWO cross-cutting PHI shapes that
 *   apply to ANY format, both of them from the shared floor:
 *
 *       (1) a dashed Social Security Number
 *       (2) an email at a domain the allow-list does not declare
 *
 *   That is a FLOOR, not a gate. It does NOT understand Pathways. It will NOT
 *   catch a patient name, a date of birth, an MRN / member id, an address, or a
 *   phone number sitting in a structured Pathways field: the PHI that a real
 *   Pathways message actually carries.
 *
 *   ⚠  A scanner that silently ships SSN/email-only detection is a FALSE-
 *      CONFIDENCE RISK: it reports green on fixtures stuffed with real names and
 *      DOBs. Before you trust `pnpm phi-scan` as a safety gate for Pathways,
 *      YOU MUST add structured, field-level detection for THIS standard's PHI
 *      in the clearly-fenced TODO section in `detect` below.
 *
 *   Worked examples of structured, format-aware detection live in the sibling
 *   parsers: read one before you start:
 *       ../hl7/scripts/phi-scan.ts     (segment -> field -> component aware)
 *       ../x12/scripts/phi-scan.ts     (ISA-delimited NM1 / DMG / PER aware)
 *       ../dicom/scripts/phi-scan.ts   (binary tag-aware)
 *       ../ccda/scripts/phi-scan.ts    (XML element aware)
 *       ../ncpdp/scripts/phi-scan.ts   (fixed-field aware)
 *
 *   The mechanism for declaring genuinely-synthetic identifiers is the
 *   allow-list (`scripts/phi-allow-list.txt`): a positive declaration that a
 *   fixture's identifiers are fake. Byte-strict formats cannot carry an inline
 *   `# synthetic: true` header, so the allow-list is the proven substitute. A
 *   whole-file bypass (`--allow-fixture <path>`) still exists and still needs a
 *   logged entry in `phi-scan-overrides.md`, but it is RECORDED AND REFUSED
 *   rather than honored: it cannot reach exit 0 in any mode.
 *
 *   🛑 A DETECTOR YOU ADD BELOW THAT DOES NOT CONSULT `allow` HAS NO REMEDY AT
 *   ALL, because the bypass is closed. A sibling shipped a phone detector and a
 *   dashed-SSN branch that consulted nothing, and its own reviewer caught the
 *   footer claiming the allow-list was the only remedy: it was not a remedy for
 *   those two at all. Check every PHI-bearing field against `allow` as you add
 *   it, or a developer meeting your detector has nowhere to go.
 * ===========================================================================
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
 * does not own, because it differs per healthcare standard.
 *
 * The engine has already run the cross-cutting floor (SSN + email shapes) over
 * `ctx.text` and reported any hits against the correct locus. Everything below
 * is yours.
 *
 * @param ctx The target's text and bytes, the parsed allow-list, and `hit`.
 */
function detect(ctx: DetectContext): void {
  // ── TODO: add Pathways-specific structured field-level PHI detection here ──
  //
  //   The floor ONLY catches SSN/email shapes. Before you rely on this scanner
  //   as a real safety gate you MUST add structured, field-level detection for
  //   Pathways's PHI (at minimum: person NAMES, DATE OF BIRTH, MRN / MEMBER ID,
  //   ADDRESS, and PHONE) parsing `ctx.text` according to the Pathways wire
  //   format and checking each PHI-bearing field against the allow-list
  //   (`ctx.allow.names` / `.dobs` / `.ids`), raising a hit for anything not
  //   positively declared synthetic.
  //
  //   Parse the format properly (delimiters / segments / elements / tags): do
  //   NOT bolt on a blind text regex for names. Coded values (`CBC^Complete
  //   Blood Count`, `Boston^MA`) produce false confidence. See the sibling
  //   parsers named in the STARTER banner for worked, spec-aware examples:
  //
  //     const d = detectPathwaysDelimiters(ctx.text);       // if applicable
  //     for (const record of splitPathways(ctx.text, d)) {
  //       // check name / dob / id / address / phone fields against ctx.allow
  //       // ctx.hit({ segment: "<field>", reason: "<why>" });
  //     }
  //
  //   🛑 A HIT IS A POSITION AND A RULE, NEVER THE VALUE. `segment` is where in
  //   the record it sits and `reason` is why it was raised; the engine reports
  //   both beside the path and prints no token, because stderr is a CI log. The
  //   `value` field is still accepted so an existing detector compiles, and it
  //   is dropped rather than stored. Do not route around that with a value
  //   interpolated into `segment` or `reason`.
  //
  //   🛑 CHECK `ctx.allow` IN EVERY DETECTOR YOU ADD. The `--allow-fixture`
  //   bypass cannot reach a clean run, so a detector that consults nothing
  //   leaves a developer with a hit they cannot answer and a gate they will
  //   route around.
  //
  //   Until this section is implemented, treat a green `pnpm phi-scan` as
  //   "no SSN/email shapes found", NOT as "no PHI".
  //
  //   Raise hits through `ctx.hit`, which fills in the locus. Never build a
  //   path yourself: the index union scans bytes that may not be the ones on
  //   disk, and a hit naming an undecorated path a developer then opens and
  //   finds clean is its own defect.
  // ───────────────────────────────────────────────────────────────────────────
  void ctx;
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
