# phi-scan bypass log

This file logs every `--allow-fixture <path>` bypass invocation of
`scripts/phi-scan.ts`. The scanner refuses to honor a `--allow-fixture <path>`
flag UNLESS this file contains a `### <path>` subsection referencing the same
path. The committed log is intentionally annoying. It discourages bypass and
creates an audit trail.

> **A BYPASS IS RECORDED AND THEN REFUSED. IT CANNOT PRODUCE A CLEAN RUN, IN ANY
> MODE.** `--allow-fixture` withdraws a file from the read set, and the scanner
> refuses (**exit 2**) over a target it enumerated and never read: a scan that
> did not open a file has no clean verdict to give about it. Three gates stand
> between the flag and a clean run, and each refuses on its own: an **unlogged**
> path is rejected at the argument tier; a logged path the run **does not
> enumerate** is refused because the flag would subtract nothing; and a logged
> path the run **does** enumerate is admitted, recorded, withdrawn, and then
> refused by the completeness rule. Reaching for this flag to get a green run is
> following a remedy to exit 2.
>
> **The remedy that reaches a clean run is `scripts/phi-allow-list.txt`**: a
> token-level, reviewed declaration that specific identifiers are synthetic. It
> is narrower than a whole-file bypass by construction, because the file still
> gets opened and every check still runs over it. Add the tokens; do not withdraw
> the file. The full reasoning, including the four argv shapes that used to exit
> 0 over an unopened corpus, is in the docblock of `scripts/phi-scan.ts` under
> THE COMPLETENESS RULE.

> **This is the STARTER template.** `scripts/phi-scan.ts` ships with the shared
> machinery and a cross-cutting SSN/email floor ONLY. Before you rely on
> `pnpm phi-scan` as a real PHI gate for this standard, add structured,
> field-level detection (names, DOB, MRN / member id, address, phone) in the
> fenced TODO section of `scripts/phi-scan.ts`: see the sibling parsers
> (`hl7` / `dicom` / `x12` / `ccda` / `ncpdp`) for worked examples.

## Format

Each entry is a markdown subsection:

```
### <path>

- **Date:** <YYYY-MM-DD>
- **Reason:** <one-line justification>
- **Approved by:** <committer name>
- **Expires:** <YYYY-MM-DD or "permanent">
```

## Entries

(none yet)
