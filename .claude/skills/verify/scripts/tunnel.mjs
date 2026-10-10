#!/usr/bin/env node
// The verify skill's tunnel: `mend service connect` for this run's stack, held in the background,
// and stopped by its identity, never by a pid alone (a pid can be reused once the process is gone).
//
//   node .claude/skills/verify/scripts/tunnel.mjs start --service <name> --port <port> --dir <private dir> --log <file>
//   node .claude/skills/verify/scripts/tunnel.mjs stop --dir <private dir>
//
// `start` refuses a port anything already listens on (127.0.0.1 or [::1]: the owner's own
// `mend service connect stack --port 3305` is one), then runs `mend service connect <name> --port
// <port>` in a session of its own, writes <dir>/tunnel.json (pid, its start time as `ps` reports it,
// service, port, `bound: false`), and waits up to 60 s until its own child, or a process under it,
// is the one listener on 127.0.0.1:<port> (`ss -ltnp`) and http://localhost:<port>/api/health
// answers. Only then does tunnel.json say `bound: true`, which is what guard/policy.mjs allows.
// Exit 0: bound and answering. Exit 1: the port was taken, the tunnel exited (its log says why) or
// another process holds the port, or it never answered. `stop` signals the recorded pid
// only when `ps` still reports the same start time for it; otherwise it says so
// and signals nothing. doctor.mjs reads the same file. `mend` is the first one on PATH.

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
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

/** Whether this process can bind host:port: false when anything already listens there. */
const free = (host, port) =>
  new Promise((done) => {
    const probe = net.createServer();
    probe.once("error", (error) =>
      done(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
    );
    probe.listen({ host, port: Number(port), exclusive: true }, () =>
      probe.close(() => done(true)),
    );
  });

/** The pids listening on a TCP port, with their local addresses (`ss -ltnp`, this user's only). */
const listeners = (port) => {
  const run = spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  if (run.status !== 0) return null;
  return run.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      address: line.trim().split(/\s+/)[3],
      pids: [...line.matchAll(/pid=(\d+)/g)].map(([, pid]) => Number(pid)),
    }));
};

/** Whether `pid` is `root` or a process under it (/proc's parent links). */
const under = (pid, root) => {
  for (let at = pid, hops = 0; at > 1 && hops < 64; hops += 1) {
    if (at === root) return true;
    try {
      at = Number(
        readFileSync(`/proc/${at}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[1],
      );
    } catch {
      return false;
    }
  }
  return false;
};

const dir = flag("dir") ?? fail("needs --dir", 2);
const file = join(dir, "tunnel.json");

if (command === "start") {
  const service = flag("service") ?? fail("start needs --service", 2);
  const port = flag("port") ?? fail("start needs --port", 2);
  const log = flag("log") ?? fail("start needs --log", 2);
  if (!(await free("127.0.0.1", port)) || !(await free("::1", port)))
    fail(
      `port ${port} is taken on this machine (another tunnel, or the owner's own); pick another`,
    );
  const out = openSync(log, "a");
  const child = spawn("mend", ["service", "connect", service, "--port", port], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  const identity = identityOf(child.pid);
  const record = (bound) =>
    writeFileSync(file, JSON.stringify({ pid: child.pid, identity, service, port, bound }), {
      mode: 0o600,
    });
  record(false);
  const deadline = Date.now() + 60_000;
  const stopChild = () => {
    if (identityOf(child.pid) === identity) process.kill(child.pid, "SIGTERM");
  };
  for (;;) {
    if (identityOf(child.pid) !== identity) fail(`the tunnel exited; read ${log}`);
    // Only the child's own listener counts: anything else on the port ends the start.
    const held = listeners(port);
    if (held === null) {
      stopChild();
      fail("ss cannot list this machine's listeners; the tunnel cannot be proven to be this run's");
    }
    // A listener another process visibly owns, or on another address, ends the start at once. One
    // whose owner `ss` cannot see yet (it maps sockets to pids by walking /proc, and can miss a
    // listener just made) is only waited on: health counts once every listener is the child's, and
    // one that never shows an owner (another user's process) runs out the deadline.
    const foreign = held.filter(
      (at) =>
        at.address !== `127.0.0.1:${port}` ||
        (at.pids.length > 0 && !at.pids.some((pid) => under(pid, child.pid))),
    );
    if (foreign.length > 0) {
      stopChild();
      fail(
        `another process listens on ${foreign.map((at) => `${at.address}${at.pids.length > 0 ? ` (pid ${at.pids.join(", ")})` : ""}`).join(", ")}; not this run's tunnel (pid ${child.pid})`,
      );
    }
    const ours =
      held.length > 0 && held.every((at) => at.pids.some((pid) => under(pid, child.pid)));
    const answered =
      ours &&
      (await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      }).then(
        (response) => response.ok,
        () => false,
      ));
    if (answered) {
      record(true);
      process.stdout.write(`tunnel · ${service} → 127.0.0.1:${port} · pid ${child.pid}\n`);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      stopChild();
      fail(
        `127.0.0.1:${port} did not answer as this run's tunnel within 60 s (its listener's owner may not be visible); read ${log}`,
      );
    }
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
