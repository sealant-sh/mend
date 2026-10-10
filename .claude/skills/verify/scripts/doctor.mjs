#!/usr/bin/env node
// The verify skill's doctor: is the stack at <web> this run's, at the expected refs, and healthy?
//
//   node .claude/skills/verify/scripts/doctor.mjs --worktree <wt> --web <url> --out <dir> \
//     --tunnel <private dir>/tunnel.json \
//     [--project mend] [--expect-mend <sha>] [--expect-sealant <sha>] [--expect-sealantd <sha>]
//
// One sibling `mend run` in the stack's worktree (the same workspace and Docker daemon) runs
// `stack.mjs report --json`, one authenticated inner CLI call (`mend projects`) and
// `sealantd --version` (the daemon the workspace image carries: its version, the binary's sha256
// and its offline capabilities, since a `-next` build reports version 0.0.0); then the tunnelled
// web is asked for /api/health. The tunnel is tunnel.mjs's record: the same pid, with the same
// start time. It starts, stops and writes nothing of the stack (`report` writes nothing back). Its
// traces: the sibling session is a record on the outer server, and `report` runs a short-lived
// probe container on the session's Docker. It writes report.json, health.json and doctor.txt into
// --out and exits 0 only when every `ok`/`NOT` line of doctor.txt holds. `mend` is the first one on
// PATH.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const worktree = flag("worktree");
const web = flag("web");
const out = flag("out");
const tunnelFile = flag("tunnel");
const project = flag("project", "mend");
if (!worktree || !web || !out || !tunnelFile) {
  process.stderr.write(
    "usage: doctor.mjs --worktree <wt> --web <url> --out <dir> --tunnel <file> [--project p] [--expect-<repo> <sha>]\n",
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const lines = [];
let held = true;
const observe = (ok, text) => {
  held &&= ok;
  lines.push(`${ok ? "ok  " : "NOT "} ${text}`);
};
const say = (text) => lines.push(`     ${text}`);

// The tunnel: tunnel.mjs's process, still the same one (a pid alone could be reused), bound for
// this port. `mend service connect` exits when the port is taken, so a live one holds it.
const origin = new URL(web);
const tunnel = JSON.parse(readFileSync(tunnelFile, "utf8"));
const identity = (() => {
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(tunnel.pid)], { encoding: "utf8" });
  return ps.status === 0 ? ps.stdout.trim() : "";
})();
const same = identity !== "" && identity === tunnel.identity;
observe(
  same && String(tunnel.port) === origin.port,
  `tunnel pid ${tunnel.pid} ${same ? "the one this run started" : identity === "" ? "gone" : "another process now"} · ${tunnel.service} → :${tunnel.port}`,
);

// The report and an authenticated inner call, through the session. stdout is the command's
// terminal: CRLF, stderr folded in. The script is one argv word with no leading whitespace.
const marker = "verify-doctor inner-cli-exit";
const daemonMarker = "verify-doctor sealantd";
const script = `node scripts/verify-stack/stack.mjs report --json; node scripts/verify-stack/stack.mjs mend projects > /dev/null 2>&1; echo "${marker} $?"; echo "${daemonMarker} $(sealantd --version 2>&1 | head -n 1) · sha256 $(sha256sum "$(command -v sealantd)" | cut -c1-16) · $(sealantd capabilities --json 2>&1 | head -n 1)"`;
const run = spawnSync(
  "mend",
  ["run", "--project", project, "--worktree", worktree, "--", "sh", "-c", script],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000 },
);
const text = (run.stdout ?? "").replaceAll("\r", "");
const at = text.lastIndexOf(marker);
const daemonAt = text.lastIndexOf(daemonMarker);
const workspaceSealantd =
  daemonAt === -1
    ? "unknown"
    : text
        .slice(daemonAt + daemonMarker.length)
        .split("\n")[0]
        .trim() || "unknown";
const firstMarker = [at, daemonAt].filter((index) => index !== -1);
const reportText = firstMarker.length === 0 ? text : text.slice(0, Math.min(...firstMarker));
writeFileSync(join(out, "report.json"), reportText);
writeFileSync(join(out, "report.stderr"), `${run.error?.message ?? ""}${run.stderr ?? ""}`);
let report = null;
try {
  report = JSON.parse(reportText.slice(reportText.indexOf("{")));
} catch {
  observe(
    false,
    `stack.mjs report --json: no report (mend run exit ${run.status}; see report.json)`,
  );
}
const innerExit =
  at === -1
    ? null
    : Number(
        text
          .slice(at + marker.length)
          .trim()
          .split(/\s/)[0],
      );
observe(
  innerExit === 0,
  `inner mend projects, signed in as the stack's first account · exit ${innerExit ?? "?"}`,
);

let health = null;
try {
  const response = await fetch(new URL("/api/health", web), {
    signal: AbortSignal.timeout(10_000),
  });
  health = await response.json();
  writeFileSync(join(out, "health.json"), JSON.stringify(health, null, 2));
  observe(
    response.ok && health.status === "ok",
    `${web}/api/health · HTTP ${response.status} · ${health.status}`,
  );
} catch (error) {
  observe(false, `${web}/api/health · no answer (${error.message})`);
}

if (report !== null) {
  // The same build: the version the stack stamped on what it built (`-verify.t<digest>`, which no
  // release carries) is what the tunnelled web reports. The tunnel line above says whose it is.
  const version = report.images?.version;
  observe(
    health !== null && version !== undefined && health.version === version,
    `web version ${health?.version ?? "?"} · this session's stack built ${version ?? "?"}`,
  );
  observe(report.url === origin.origin, `stack origin ${report.url} · tunnel ${origin.origin}`);
  observe(Boolean(report.readyAt), `ready at ${report.readyAt ?? "never"}`);
  observe(
    report.check?.status === "completed",
    `check ${report.check?.command ?? "mend run -- true"} · ${report.check?.status ?? "not run yet"}`,
  );
  for (const name of ["mend", "sealant", "sealantd"]) {
    const source = report.sources?.[name];
    const expected = flag(`expect-${name}`);
    const commit = source?.commit ?? "pinned";
    if (expected === undefined) say(source?.description ?? `${name} pinned`);
    else
      observe(
        commit.startsWith(expected),
        `${name} at ${commit.slice(0, 12)} · expected ${expected}`,
      );
  }
  // The daemon the outer session's workspace image carries, beside the refs the stack builds: a
  // daemon older than bound upload links keeps a Stop saving (capture seals withheld).
  say(`workspace sealantd · ${workspaceSealantd}`);
  // `report` looks for the session's credential (its environment, or the per-person token file) in
  // every container. When it could read none there was nothing to compare: said, never counted.
  const findings = report.isolation?.findings ?? [];
  const checked = report.isolation?.checked ?? 0;
  if (findings.length > 0) observe(false, `isolation · found in ${findings.join(", ")}`);
  else if (checked === 0)
    say("isolation · not compared: report could read no credential of the session");
  else observe(true, `isolation · no container holds the session's ${checked} credential(s)`);
  if (report.memory)
    say(
      `memory · ${(report.memory.totalKb / 1024 / 1024).toFixed(1)} GiB · ${report.memory.method}`,
    );
}

writeFileSync(join(out, "doctor.txt"), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(held ? 0 : 1);
