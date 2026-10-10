#!/usr/bin/env node
// The verify skill's tunnel: `mend service connect` for this run's stack, held in the background,
// and stopped by its identity, never by a pid alone (a pid can be reused once the process is gone).
//
//   node .claude/skills/verify/scripts/tunnel.mjs start --service <name> --port <port> --dir <private dir> --log <file>
//   node .claude/skills/verify/scripts/tunnel.mjs stop --dir <private dir>
//
// `start` runs `mend service connect <name> --port <port>` in a session of its own, writes
// <dir>/tunnel.json (pid, its start time as `ps` reports it, service, port), and
// waits up to 60 s for http://localhost:<port>/api/health. Exit 0: it answers. Exit 1: the tunnel
// exited (its log says why, a taken port for one) or never answered. `stop` signals the recorded pid
// only when `ps` still reports the same start time for it; otherwise it says so
// and signals nothing. doctor.mjs reads the same file. `mend` is the first one on PATH.

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const fail = (message, code = 1) => {
  process.stderr.write(`tunnel: ${message}\n`);
  process.exit(code);
};

/**
 * The process's start time as `ps` reports it, or null once it is gone. The start time, not the
 * command line: `mend` may be a wrapper that execs node, which changes the command line, never the
 * start time. A reused pid has another one.
 */
const identityOf = (pid) => {
  const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const line = run.status === 0 ? run.stdout.trim() : "";
  return line === "" ? null : line;
};

const dir = flag("dir") ?? fail("needs --dir", 2);
const file = join(dir, "tunnel.json");

if (command === "start") {
  const service = flag("service") ?? fail("start needs --service", 2);
  const port = flag("port") ?? fail("start needs --port", 2);
  const log = flag("log") ?? fail("start needs --log", 2);
  const out = openSync(log, "a");
  const child = spawn("mend", ["service", "connect", service, "--port", port], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  const identity = identityOf(child.pid);
  writeFileSync(file, JSON.stringify({ pid: child.pid, identity, service, port }), { mode: 0o600 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const answered = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) {
      process.stdout.write(`tunnel · ${service} → 127.0.0.1:${port} · pid ${child.pid}\n`);
      process.exit(0);
    }
    if (identityOf(child.pid) !== identity) fail(`the tunnel exited; read ${log}`);
    if (Date.now() >= deadline) fail(`localhost:${port} did not answer within 60 s; read ${log}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
} else if (command === "stop") {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    process.stdout.write("tunnel · none recorded; nothing signalled\n");
    process.exit(0);
  }
  const now = identityOf(recorded.pid);
  if (now === null) process.stdout.write(`tunnel · pid ${recorded.pid} already ended\n`);
  else if (now !== recorded.identity)
    process.stdout.write(
      `tunnel · pid ${recorded.pid} is another process now; nothing signalled\n`,
    );
  else {
    process.kill(recorded.pid, "SIGTERM");
    process.stdout.write(`tunnel · stopped pid ${recorded.pid} (${recorded.service})\n`);
  }
} else {
  fail(
    "usage: tunnel.mjs start --service <name> --port <port> --dir <dir> --log <file> | stop --dir <dir>",
    2,
  );
}
