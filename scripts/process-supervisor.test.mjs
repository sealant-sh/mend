import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { ChildProcessFailure, ProcessSupervisor } from "./process-supervisor.mjs";

const withTimeout = (promise, milliseconds = 5_000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("test timed out")), milliseconds).unref(),
    ),
  ]);

const cleanup = async (supervisor, owned) => {
  const failures = [];
  try {
    await supervisor.shutdown("SIGKILL", 0);
  } catch (error) {
    failures.push(error);
  }
  // Each detached group was created by this test. This fallback runs only after the test's
  // observations, so a broken supervisor cannot leave its fixture descendants alive.
  for (const tracked of owned) {
    if (tracked.child?.pid === undefined) continue;
    try {
      if (process.platform === "win32") tracked.child.kill("SIGKILL");
      else process.kill(-tracked.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failures.push(error);
    }
  }
  const exits = await Promise.allSettled(owned.map((tracked) => withTimeout(tracked.exited)));
  for (const exit of exits) if (exit.status === "rejected") failures.push(exit.reason);
  if (failures.length > 0) throw new AggregateError(failures, "fixture processes did not clean up");
};

test("an unexpected child exit becomes fatal and shutdown observes its sibling exit", async () => {
  const supervisor = new ProcessSupervisor();
  const owned = [];
  try {
    const sibling = await supervisor.start({
      name: "sibling",
      command: [process.execPath, "-e", "setInterval(()=>{}, 1000)"],
      env: process.env,
      stdio: "ignore",
    });
    owned.push(sibling);
    const failed = await supervisor.start({
      name: "failure",
      command: [process.execPath, "-e", "setTimeout(()=>process.exit(7), 50)"],
      env: process.env,
      stdio: "ignore",
    });
    owned.push(failed);
    const failure = await withTimeout(supervisor.failure);
    assert.deepEqual(failure, { name: "failure", code: 7, signal: null });
    assert.deepEqual(await withTimeout(failed.exited), failure);
    await supervisor.shutdown("SIGTERM", 2_000);
    assert.deepEqual(await withTimeout(sibling.exited), {
      name: "sibling",
      code: null,
      signal: "SIGTERM",
    });
  } finally {
    await cleanup(supervisor, owned);
  }
});

test("an optional process kept running is started again, and its exit is never fatal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-keep-"));
  const starts = path.join(directory, "starts");
  const supervisor = new ProcessSupervisor();
  const logged = [];
  try {
    await supervisor.keepRunning(
      {
        name: "optional",
        command: [
          process.execPath,
          "-e",
          `require("node:fs").appendFileSync(${JSON.stringify(starts)}, "x"); setTimeout(()=>process.exit(3), 20)`,
        ],
        env: process.env,
        stdio: "ignore",
      },
      { backoffMs: 20, maxBackoffMs: 40, log: (line) => logged.push(line) },
    );
    await withTimeout(
      (async () => {
        for (;;) {
          const count = (await readFile(starts, "utf8").catch(() => "")).length;
          if (count >= 3) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
    );
    // Nothing fatal: the set's failure never settled.
    const settled = await Promise.race([
      supervisor.failure.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(settled, false);
    assert.ok(logged.some((line) => line.includes("optional ended (exit code 3)")));
  } finally {
    await supervisor.shutdown("SIGTERM", 2_000);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an optional process that cannot even start the first time never stops a required one", async () => {
  // Review 643-2: the first spawn's failure escaped the retry, ended the bundle's start, and the
  // supervisor stopped every healthy sibling with exit code 1.
  const supervisor = new ProcessSupervisor();
  const logged = [];
  try {
    const required = await supervisor.start({
      name: "mend",
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      env: process.env,
      stdio: "ignore",
    });
    await supervisor.keepRunning(
      {
        name: "optional",
        command: ["/nonexistent/mend-t3-gateway"],
        env: process.env,
        stdio: "ignore",
      },
      { backoffMs: 20, maxBackoffMs: 40, log: (line) => logged.push(line) },
    );
    await withTimeout(
      (async () => {
        while (logged.filter((line) => line.includes("optional did not start")).length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
    );
    // Tried again, nothing fatal, and the required process still runs.
    const settled = await Promise.race([
      supervisor.failure.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(settled, false);
    assert.equal(required.child.exitCode, null);
    assert.equal(required.child.signalCode, null);
  } finally {
    await supervisor.shutdown("SIGTERM", 2_000);
  }
});

test("a check before each start that fails is a failed start: logged, tried again, never fatal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-ready-"));
  const ready = path.join(directory, "ready");
  const supervisor = new ProcessSupervisor();
  const logged = [];
  let checks = 0;
  try {
    await supervisor.keepRunning(
      {
        name: "optional",
        command: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "running"); setInterval(() => {}, 1000)`,
        ],
        env: process.env,
        stdio: "ignore",
      },
      {
        backoffMs: 20,
        maxBackoffMs: 40,
        log: (line) => logged.push(line),
        beforeStart: async () => {
          checks += 1;
          if (checks < 3) throw new Error("its root is not root's alone");
        },
      },
    );
    await withTimeout(
      supervisor.waitFor(
        "the optional process after two refused checks",
        async () => (await readFile(ready, "utf8").catch(() => "")) === "running",
        { intervalMs: 10, timeoutMs: 3_000 },
      ),
    );
    assert.equal(checks, 3);
    assert.equal(await readFile(ready, "utf8"), "running");
    assert.ok(logged.some((line) => line.includes("optional did not start: Error: its root")));
    const settled = await Promise.race([
      supervisor.failure.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(settled, false);
  } finally {
    try {
      await supervisor.shutdown("SIGTERM", 2_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a one-shot failure reports its process and exit code", async () => {
  const supervisor = new ProcessSupervisor();
  await assert.rejects(
    supervisor.run({
      name: "migration",
      command: [process.execPath, "-e", "process.exit(4)"],
      env: process.env,
      stdio: "ignore",
    }),
    (error) =>
      error instanceof ChildProcessFailure &&
      error.result.name === "migration" &&
      error.result.code === 4,
  );
  await supervisor.shutdown();
});

test("shutdown signals the child and its grandchild, and observes both exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-group-"));
  const parentReady = path.join(directory, "parent-ready");
  const childReady = path.join(directory, "grandchild-ready");
  const parentTerm = path.join(directory, "parent-term");
  const childTerm = path.join(directory, "grandchild-term");
  const childExit = path.join(directory, "grandchild-exit");
  const supervisor = new ProcessSupervisor();
  const owned = [];
  try {
    const grandchild = `const fs=require("node:fs"); process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(childTerm)}, "TERM");process.exit(0)}); fs.writeFileSync(${JSON.stringify(childReady)}, String(process.pid));setInterval(()=>{},1000);`;
    const parent = `const fs=require("node:fs"); const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"}); child.once("exit",(code,signal)=>{fs.writeFileSync(${JSON.stringify(childExit)},JSON.stringify({pid:child.pid,code,signal}));process.exit(code===0?0:1)});process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(parentTerm)}, "TERM")});fs.writeFileSync(${JSON.stringify(parentReady)},String(process.pid));setInterval(()=>{},1000);`;
    const tracked = await supervisor.start({
      name: "signal-target",
      command: [process.execPath, "-e", parent],
      env: process.env,
      stdio: "ignore",
    });
    owned.push(tracked);
    await withTimeout(
      supervisor.waitFor(
        "both signal handlers installed",
        async () =>
          Boolean(await readFile(parentReady, "utf8").catch(() => "")) &&
          Boolean(await readFile(childReady, "utf8").catch(() => "")),
        { intervalMs: 10, timeoutMs: 3_000 },
      ),
    );
    const grandchildPid = Number(await readFile(childReady, "utf8"));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    await supervisor.shutdown("SIGTERM", 2_000);
    assert.deepEqual(await withTimeout(tracked.exited), {
      name: "signal-target",
      code: 0,
      signal: null,
    });
    assert.equal(await readFile(parentTerm, "utf8"), "TERM");
    assert.equal(await readFile(childTerm, "utf8"), "TERM");
    assert.deepEqual(JSON.parse(await readFile(childExit, "utf8")), {
      pid: grandchildPid,
      code: 0,
      signal: null,
    });
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    try {
      await cleanup(supervisor, owned);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("shutdown kills a TERM-resistant child after the grace deadline", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-kill-"));
  const ready = path.join(directory, "ready");
  const term = path.join(directory, "term");
  const supervisor = new ProcessSupervisor();
  const owned = [];
  try {
    const tracked = await supervisor.start({
      name: "term-resistant",
      command: [
        process.execPath,
        "-e",
        `const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(term)},"TERM"));fs.writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000);`,
      ],
      env: process.env,
      stdio: "ignore",
    });
    owned.push(tracked);
    await withTimeout(
      supervisor.waitFor(
        "the TERM-resistant handler",
        async () => (await readFile(ready, "utf8").catch(() => "")) === "ready",
        { intervalMs: 10, timeoutMs: 3_000 },
      ),
    );
    const graceMs = 250;
    const startedAt = performance.now();
    await withTimeout(supervisor.shutdown("SIGTERM", graceMs));
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(await withTimeout(tracked.exited), {
      name: "term-resistant",
      code: null,
      signal: "SIGKILL",
    });
    assert.equal(await readFile(term, "utf8"), "TERM");
    // Real timers may round and the two monotonic readings may straddle that rounding.
    // A 25 ms tolerance still rejects an immediate kill against the 250 ms grace.
    const toleranceMs = 25;
    assert.ok(
      elapsed >= graceMs - toleranceMs,
      `shutdown killed before its ${graceMs} ms grace: ${elapsed}`,
    );
    assert.ok(elapsed < graceMs + 2_000, `shutdown exceeded its kill deadline: ${elapsed}`);
  } finally {
    try {
      await cleanup(supervisor, owned);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an optional retry already scheduled does not restart after shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-shutdown-"));
  const starts = path.join(directory, "starts");
  const supervisor = new ProcessSupervisor();
  const owned = [];
  let checks = 0;
  const retryScheduled = Promise.withResolvers();
  try {
    const first = await supervisor.keepRunning(
      {
        name: "optional",
        command: [
          process.execPath,
          "-e",
          `require("node:fs").appendFileSync(${JSON.stringify(starts)},"started");process.exit(3);`,
        ],
        env: process.env,
        stdio: "ignore",
      },
      {
        backoffMs: 100,
        maxBackoffMs: 100,
        beforeStart: async () => {
          checks += 1;
        },
        log: (line) => {
          if (line.includes("again in 100 ms")) retryScheduled.resolve();
        },
      },
    );
    owned.push(first);
    await withTimeout(retryScheduled.promise);
    assert.deepEqual(await withTimeout(first.exited), { name: "optional", code: 3, signal: null });
    await supervisor.shutdown("SIGTERM", 2_000);
    assert.equal(supervisor.stopping, true);
    const count = checks;
    const before = await readFile(starts, "utf8");
    // Cross the pending retry deadline; a restart must neither check nor spawn again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(checks, count);
    assert.equal(await readFile(starts, "utf8"), before);
    await assert.rejects(
      supervisor.start({
        name: "after-shutdown",
        command: [process.execPath, "-e", "process.exit(0)"],
        stdio: "ignore",
      }),
      /shutdown has begun/,
    );
  } finally {
    try {
      await cleanup(supervisor, owned);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
