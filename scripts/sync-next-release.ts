#!/usr/bin/env tsx
/**
 * The release's `version` script runs this after `changeset version`, from the repo root: it moves
 * each README "In the next release" bullet whose changesets that step consumed up into "What the
 * latest release ships", and names the new version as the one on npm. The rules are in
 * `scripts/next-release-sync.ts`. The report goes to stderr and stdout stays empty; exit 0 for a
 * write or an already-current file, 1 for a refusal.
 */

import { syncNextRelease } from "./next-release-sync.js";

const { code, message } = syncNextRelease(process.cwd());
process.stderr.write(`${message}\n`);
process.exitCode = code;
