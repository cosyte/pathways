#!/usr/bin/env tsx
/**
 * The release's `version` script runs this after `changeset version`, from the repo root: it writes
 * `package.json`'s version into `src/version.ts`. The rules are in `scripts/version-sync.ts`. The
 * report goes to stderr and stdout stays empty; exit 0 for a write or an already-synced file, 1 for a
 * refusal.
 */

import { syncVersion } from "./version-sync.js";

const { code, message } = syncVersion(process.cwd());
process.stderr.write(`${message}\n`);
process.exitCode = code;
