#!/usr/bin/env node
// The verify skill's watch on a Stop: does the outer session settle, and if it stays saving, what
// does the outer server say about its seal?
//
//   node .claude/skills/verify/scripts/settle.mjs --session <id> --out <dir> \
//     [--after 300] [--logs-cmd '<command that prints the outer server's logs>']
//
// It reads `mend sessions --all --json` every 10 s and writes the session's last entry to
// <out>/session.json. Exit 0: the session left `stopping` (its status and capture line are said).
// Exit 1: it was still `stopping` after --after seconds (default 300). Then, with --logs-cmd, it
// runs that command (for example `docker logs --since 1h mend-mend-1` on the server's machine),
// redacts its output (every value in the run's registry, $MEND_VERIFY_PRIVATE, then every shape
// redact.mjs knows), and writes <out>/outer-server.log. <out>/capture-seals.txt
// then keeps every log entry (from its `[hh:mm:ss.mmm]` line to the next) that names the session
// or its worktree and says one of: `capture seals` (a seal withheld: its code and until time),
// `final seal` (refused, or registered without a section: its reason), `capture flush · final`
// (why the final flush is incomplete), `git section failed` (the capture's git section did not
// verify). It prints a count per kind and the last entry of each. Without --logs-cmd it says whose
// logs to ask for. Exit 2: the session could not be read. `mend` is the first one on PATH.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redact } from "./redact.mjs";
import { loadSecrets, redactValues } from "./secrets.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const session = flag("session");
const out = flag("out");
const after = Number(flag("after", "300"));
const logsCmd = flag("logs-cmd");
if (!session || !out || !Number.isFinite(after)) {
  process.stderr.write(
    "usage: settle.mjs --session <id> --out <dir> [--after 300] [--logs-cmd '<command>']\n",
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const read = () => {
  const run = spawnSync("mend", ["sessions", "--all", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (run.status !== 0) return null;
  try {
    return JSON.parse(run.stdout).sessions.find((item) => item.id.startsWith(session)) ?? null;
  } catch {
    return null;
  }
};

const started = Date.now();
let entry = read();
if (entry === null) {
  process.stderr.write(`settle: session ${session} could not be read\n`);
  process.exit(2);
}
while (entry.status === "stopping" && Date.now() - started < after * 1000) {
  await new Promise((done) => setTimeout(done, 10_000));
  entry = read() ?? entry;
}
writeFileSync(join(out, "session.json"), `${JSON.stringify(entry, null, 2)}\n`);
const seconds = Math.round((Date.now() - started) / 1000);
const line = entry.capture?.line ?? "no capture line";
if (entry.status !== "stopping") {
  process.stdout.write(
    `settle · ${entry.id.slice(0, 8)} · ${entry.status} · ${line} · after ${seconds} s\n`,
  );
  process.exit(0);
}
process.stdout.write(
  `settle · ${entry.id.slice(0, 8)} · still stopping after ${seconds} s · ${line}\n`,
);
if (!logsCmd) {
  process.stdout.write(
    `settle · ask the outer server's operator for its log entries about session ${entry.id}: "capture seals", "final seal", "capture flush · final", "git section failed"\n`,
  );
  process.exit(1);
}

const logs = spawnSync("sh", ["-c", logsCmd], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 512 * 1024 * 1024,
  timeout: 300_000,
});
// By value (the run's registry, $MEND_VERIFY_PRIVATE), then by shape.
const secrets = process.env.MEND_VERIFY_PRIVATE
  ? loadSecrets(process.env.MEND_VERIFY_PRIVATE)
  : new Map();
const text = redact(redactValues(`${logs.stdout ?? ""}${logs.stderr ?? ""}`, secrets));
writeFileSync(join(out, "outer-server.log"), text);

// Entries, not lines: the server prints an entry's fields on the lines after its message.
const entries = [];
for (const item of text.split("\n")) {
  if (entries.length === 0 || /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(item)) entries.push(item);
  else entries[entries.length - 1] += `\n${item}`;
}
// The session's worktree: the entries that name the session name it too.
const worktrees = new Set();
for (const item of entries)
  if (item.includes(entry.id))
    for (const match of item.matchAll(/worktreeId: '([^']+)'/g)) worktrees.add(match[1]);
const ours = (item) =>
  item.includes(entry.id) || [...worktrees].some((worktree) => item.includes(worktree));
const KINDS = ["capture seals", "final seal", "capture flush · final", "git section failed"];
const kept = entries.filter((item) => ours(item) && KINDS.some((kind) => item.includes(kind)));
writeFileSync(join(out, "capture-seals.txt"), kept.length > 0 ? `${kept.join("\n")}\n` : "");
process.stdout.write(
  `settle · outer server's logs (exit ${logs.status}) · worktree ${[...worktrees].join(", ") || "not named"} · ${kept.length} entr(ies) kept · ${join(out, "capture-seals.txt")}\n`,
);
for (const kind of KINDS) {
  const ofKind = kept.filter((item) => item.includes(kind));
  if (ofKind.length === 0) continue;
  process.stdout.write(`  ${ofKind.length} × ${kind} · last:\n`);
  for (const row of ofKind.at(-1).split("\n")) process.stdout.write(`    ${row}\n`);
}
process.exit(1);
