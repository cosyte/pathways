#!/usr/bin/env bash
# The cold start, run by hand on a GitHub runner: the published package from the npm registry, in
# empty folders, as a new team meets it. It follows the install page and the quickstart word for
# word, builds one channel of each source and destination kind that runs on one machine with
# nothing else installed, runs every command the command reference names, and upgrades a project
# from the release before the latest. It never stops on a failure: each command it runs is printed
# with its exit code and output, and each one that did not do what the docs say is listed as a
# stall at the end. Every message is the starter's own synthetic one.
set -u

ROOT="$(mktemp -d)"
STALLS="$ROOT/stalls.txt"
: >"$STALLS"
export NO_UPDATE_NOTIFIER=1 npm_config_fund=false npm_config_audit=false

stall() {
  printf '%s\n' "$*" >>"$STALLS"
  printf 'STALL: %s\n' "$*"
}

# run <expected exit> <command...>: runs it in the current folder, prints it, its exit and output.
run() {
  local want="$1"
  shift
  printf '::group::$ %s (in %s)\n' "$*" "${PWD#"$ROOT"/}"
  local out code
  out="$("$@" 2>&1)"
  code=$?
  printf '%s\n' "$out" | head -c 8000
  printf '\nexit %s\n::endgroup::\n' "$code"
  LAST="$out"
  if [ "$code" != "$want" ]; then stall "\`$*\` exited $code, expected $want"; fi
}

check() {
  if eval "$2"; then printf 'ok: %s\n' "$1"; else stall "$1"; fi
}

# Waits up to $2 seconds for the test $1.
wait_for() {
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    if eval "$1"; then return 0; fi
    sleep 0.5
  done
  return 1
}

old_file() { touch -d '-1 minute' "$@"; }

echo "## The registry"
mkdir -p "$ROOT/registry" && cd "$ROOT/registry" || exit 1
run 0 npm view @cosyte/pathways dist-tags versions time --json
LATEST="$(npm view @cosyte/pathways version 2>/dev/null)"
PREVIOUS="$(npm view @cosyte/pathways versions --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const i=v.indexOf(process.argv[1]);console.log(i>0?v[i-1]:"")})' "$LATEST")"
echo "latest: $LATEST, previous: $PREVIOUS, node $(node --version), npm $(npm --version)"

echo "## Install page: a new project"
mkdir -p "$ROOT/tutorial" && cd "$ROOT/tutorial" || exit 1
run 0 npx @cosyte/pathways init my-project
cd my-project || exit 1
run 0 npm install
run 0 npx pathways --version
check "npx pathways --version prints the latest, $LATEST" '[ "$LAST" = "$LATEST" ]'

echo "## Quickstart"
run 0 find . -path ./node_modules -prune -o -type f -print
run 0 npm test
check "npm test prints the two PASS lines and the summary the quickstart shows" \
  'grep -q "PASS adt-to-lab/tests/a01.hl7" <<<"$LAST" && grep -q "2 passed, 0 failed" <<<"$LAST"'
npm start >"$ROOT/engine-1.log" 2>&1 &
ENGINE=$!
sleep 3
mkdir -p data/adt-to-lab/in
cp channels/adt-to-lab/tests/a01.hl7 channels/adt-to-lab/tests/a08.hl7 data/adt-to-lab/in/
check "within 15 seconds the admission is data/adt-to-lab/out/1-1.hl7" \
  'wait_for "[ -f data/adt-to-lab/out/1-1.hl7 ]" 15'
check "1-1.hl7 matches tests/a01.expected.hl7" \
  'cmp -s data/adt-to-lab/out/1-1.hl7 channels/adt-to-lab/tests/a01.expected.hl7'
check "the inbox is empty again" '[ -z "$(ls -A data/adt-to-lab/in | grep -v "^\.")" ]'
kill -INT "$ENGINE"
wait "$ENGINE"
echo "npm start exited $? after SIGINT; its log:"
cut -c1-300 "$ROOT/engine-1.log"
check "the log has received, transformed, filtered and delivered lines" \
  'grep -q received "$ROOT/engine-1.log" && grep -q transformed "$ROOT/engine-1.log" && grep -q filtered "$ROOT/engine-1.log" && grep -q delivered "$ROOT/engine-1.log"'
run 0 npx pathways status
check "status matches the quickstart's three lines" \
  'grep -q "adt-to-lab: ok" <<<"$LAST" && grep -q "0 received, 1 transformed, 1 filtered, 0 failed, 0 cleared" <<<"$LAST" && grep -q "0 pending (0 retrying), 1 delivered, 0 failed, 0 cleared" <<<"$LAST"'
run 0 npx pathways messages
check "messages lists delivered and filtered" 'grep -q delivered <<<"$LAST" && grep -q filtered <<<"$LAST"'

echo "## One channel of each kind that runs on one machine"
# http-in (HTTP source) -> MLLP destination -> mllp-in (MLLP source) -> TCP destination ->
# tcp-in (TCP source) -> HTTP destination -> http-sink (HTTP source) -> file destination.
# export-in: the module source and module destination of "Write custom connectors".
mkdir -p channels/http-in channels/mllp-in channels/tcp-in channels/http-sink channels/export-in
cat >channels/http-in/channel.yaml <<'YAML'
format: hl7v2
source:
  http: { port: 18080, plaintext: true, auth: none, response: ack }
destinations:
  - mllp: { host: 127.0.0.1, port: 18575, plaintext: true }
YAML
cat >channels/mllp-in/channel.yaml <<'YAML'
format: hl7v2
source:
  mllp: { port: 18575, plaintext: true }
destinations:
  - tcp:
      host: 127.0.0.1
      port: 18600
      plaintext: true
      framing: { startEnd: { start: "02", end: "03" } }
YAML
cat >channels/tcp-in/channel.yaml <<'YAML'
format: text
source:
  tcp:
    port: 18600
    plaintext: true
    framing: { startEnd: { start: "02", end: "03" } }
destinations:
  - http: { url: "http://127.0.0.1:18081/", plaintext: true }
YAML
cat >channels/http-sink/channel.yaml <<'YAML'
format: text
source:
  http: { port: 18081, plaintext: true, auth: none }
destinations:
  - file: { dir: ../../data/http-sink/out }
YAML
cat >channels/export-in/channel.yaml <<'YAML'
format: json
source:
  module: ./ndjson-source.ts
  options:
    dir: ../../data/export-in/in
destinations:
  - module: ./ndjson-destination.ts
    options:
      file: ../../data/export-in/out.ndjson
YAML
# The two connectors exactly as docs-content/write-custom-connectors.md gives them.
cat >channels/export-in/ndjson-source.ts <<'TS'
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { MessageSink, SourceFactory } from "@cosyte/pathways";

export default ((options, context) => {
  const inbox = resolve(context.dir, options.dir);
  const taken = join(inbox, ".taken");

  async function storeLines(name: string, sink: MessageSink, resumed: boolean): Promise<void> {
    const path = join(taken, name);
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
    for (const [index, line] of lines.entries()) {
      await sink.receive(Buffer.from(line), { idempotencyKey: `${name}:${index}`, resumed });
    }
    // Every line is stored: now the file can go.
    await rm(path);
  }

  return {
    async poll(sink) {
      await mkdir(taken, { recursive: true });
      // Files an earlier run took and did not finish: their lines may be stored already.
      for (const name of (await readdir(taken)).sort()) await storeLines(name, sink, true);
      for (const name of (await readdir(inbox)).filter((n) => n.endsWith(".ndjson")).sort()) {
        const claimed = `${Date.now()}-${name}`;
        await rename(join(inbox, name), join(taken, claimed));
        await storeLines(claimed, sink, false);
      }
    },
  };
}) satisfies SourceFactory<{ dir: string }>;
TS
cat >channels/export-in/ndjson-destination.ts <<'TS'
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DeliveryRejected, type DestinationFactory } from "@cosyte/pathways";

export default ((options, context) => {
  const file = resolve(context.dir, options.file);
  return {
    async deliver(message) {
      const line = Buffer.from(message.body).toString("utf8");
      // A line cannot hold a newline, and sending it again will not change that.
      if (line.includes("\n")) throw new DeliveryRejected("MULTILINE_OUTPUT");
      // Anything else that fails here (a full disk) throws as it is, and is retried.
      await appendFile(file, `${line}\n`);
    },
  };
}) satisfies DestinationFactory<{ file: string }>;
TS
cat >>pathways.yaml <<'YAML'
health: { port: 18090, plaintext: true, auth: none }
probes: { port: 18091, plaintext: true }
YAML
mkdir -p data/export-in/in
run 0 npx pathways validate
run 0 npx pathways validate --print
run 0 npx pathways secrets check
run 0 npx pathways secrets check --json
run 0 npx pathways test
npx pathways start >"$ROOT/engine-2.log" 2>&1 &
ENGINE=$!
check "the engine's probe listener answers within 20 seconds" \
  'wait_for "npx pathways probe >/dev/null 2>&1" 20'
run 0 npx pathways probe
run 0 npx pathways probe --ready
run 0 npx pathways probe --if-configured
run 0 curl -sS -i http://127.0.0.1:18090/
run 0 curl -sS -i -X POST --data-binary @channels/adt-to-lab/tests/a01.hl7 \
  -H "Content-Type: x-application/hl7-v2+er7" http://127.0.0.1:18080/
check "an HL7 ACK came back" 'grep -q "MSA" <<<"$LAST"'
check "the message went HTTP -> MLLP -> TCP -> HTTP -> file within 20 seconds" \
  'wait_for "[ -n \"\$(ls data/http-sink/out 2>/dev/null)\" ]" 20'
check "the delivered file holds the admission's MSH" 'grep -q "^MSH" data/http-sink/out/* 2>/dev/null'
printf '{"id":"synthetic-1","kind":"demo"}\n{"id":"synthetic-2","kind":"demo"}\n' >data/export-in/in/a.ndjson
check "the module source and destination moved two lines within 20 seconds" \
  'wait_for "[ \"\$(wc -l <data/export-in/out.ndjson 2>/dev/null)\" = 2 ]" 20'
run 0 npx pathways status
run 0 npx pathways status --json
run 0 npx pathways nodes
run 0 npx pathways nodes --json
run 0 npx pathways lease status
run 0 npx pathways lease status --json
run 0 npx pathways channel pause http-sink
run 0 npx pathways channel resume http-sink --json
run 0 npx pathways channel reload adt-to-lab
run 0 npx pathways channel stop export-in --deadline 5s
run 0 npx pathways channel resume export-in
run 0 npx pathways channel halt export-in --deadline 5s --json
run 0 npx pathways channel resume export-in
run 1 npx pathways start --once
kill -TERM "$ENGINE"
wait "$ENGINE"
echo "pathways start exited $? after SIGTERM; its log, levels and events:"
cut -c1-300 "$ROOT/engine-2.log"
check "the second engine logged no error" '! grep -q "\"level\":\"error\"" "$ROOT/engine-2.log"'
run 1 npx pathways channel pause http-sink

echo "## The rest of the commands, on the stored messages"
run 0 npx pathways --help
run 0 npx pathways messages --json
run 0 npx pathways messages --channel adt-to-lab --status delivered --since 1d --limit 5
run 0 npx pathways messages show 1
run 0 npx pathways messages show 1 --content --json
run 0 npx pathways replay 1
run 0 npx pathways replay 1 --resend --json
run 0 npx pathways replay --status failed --yes
run 1 npx pathways clear 1
run 0 npx pathways retention --dry-run
run 0 npx pathways retention --json
run 0 npx pathways audit --limit 10
run 0 npx pathways audit --action content-view --json
run 0 npx pathways rekey
run 1 npx pathways lease release --force
run 1 npx pathways nodes forget 0000000000000000
run 0 npx pathways migrate --dry-run
run 0 npx pathways migrate
run 0 npx pathways migrate --contract --json
mkdir -p "$ROOT/samples/adt-to-lab"
cp channels/adt-to-lab/tests/* "$ROOT/samples/adt-to-lab/"
run 0 npx pathways verify --samples "$ROOT/samples"
run 0 npx pathways verify --since 7d
run 0 npx pathways verify --channel adt-to-lab --ids 1 --json
run 0 npx pathways test adt-to-lab --update
run 0 npx pathways start --once --no-migrate
run 0 npx pathways start --once --dry-run
run 1 npx pathways start --standby
run 0 npx pathways -C . status adt-to-lab

echo "## Upgrade from the release before the latest"
if [ -z "$PREVIOUS" ]; then
  stall "no release before $LATEST on the registry to upgrade from"
else
  mkdir -p "$ROOT/upgrade" && cd "$ROOT/upgrade" || exit 1
  run 0 npx "@cosyte/pathways@$PREVIOUS" init app
  cd app || exit 1
  run 0 npm install
  run 0 npx pathways --version
  check "the project runs $PREVIOUS" '[ "$LAST" = "$PREVIOUS" ]'
  mkdir -p data/adt-to-lab/in
  cp channels/adt-to-lab/tests/a01.hl7 channels/adt-to-lab/tests/a08.hl7 data/adt-to-lab/in/
  old_file data/adt-to-lab/in/*
  run 0 npx pathways start --once
  cp .pathways/pathways.db "$ROOT/backup.db"
  run 0 npm install "@cosyte/pathways@latest"
  run 0 npx pathways --version
  check "the project now runs $LATEST" '[ "$LAST" = "$LATEST" ]'
  run 0 npx pathways migrate --dry-run
  run 0 npx pathways migrate
  cp channels/adt-to-lab/tests/a01.hl7 data/adt-to-lab/in/again.hl7
  old_file data/adt-to-lab/in/again.hl7
  run 0 npx pathways start --once --no-migrate
  run 0 npx pathways status
  check "after the upgrade both admissions are delivered" '[ "$(ls data/adt-to-lab/out | wc -l)" = 2 ]'
  run 0 npx pathways validate
  run 0 npx pathways test
fi

echo "## Stalls"
if [ -s "$STALLS" ]; then cat "$STALLS"; else echo "none"; fi
{
  echo "### Cold start: latest $LATEST, previous $PREVIOUS"
  if [ -s "$STALLS" ]; then sed 's/^/- /' "$STALLS"; else echo "No stalls."; fi
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
