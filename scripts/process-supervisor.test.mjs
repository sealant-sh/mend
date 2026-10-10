import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ChildProcessFailure, ProcessSupervisor } from "./process-supervisor.mjs";

const withTimeout = (promise, milliseconds = 5_000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("test timed out")), milliseconds).unref(),
    ),
  ]);

test("an unexpected child exit becomes fatal and shutdown stops its sibling", async () => {
  const supervisor = new ProcessSupervisor();
  await supervisor.start({
    name: "sibling",
    command: [process.execPath, "-e", "setInterval(()=>{}, 1000)"],
    env: process.env,
    stdio: "ignore",
  });
  await supervisor.start({
    name: "failure",
    command: [process.execPath, "-e", "setTimeout(()=>process.exit(7), 50)"],
    env: process.env,
    stdio: "ignore",
  });

  const failure = await withTimeout(supervisor.failure);
  assert.equal(failure.name, "failure");
  assert.equal(failure.code, 7);
  await supervisor.shutdown("SIGTERM", 2_000);
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
  const supervisor = new ProcessSupervisor();
  const logged = [];
  let checks = 0;
  try {
    await supervisor.keepRunning(
      {
        name: "optional",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
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
      (async () => {
        while (checks < 3) await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
    );
    assert.ok(logged.some((line) => line.includes("optional did not start: Error: its root")));
    const settled = await Promise.race([
      supervisor.failure.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(settled, false);
  } finally {
    await supervisor.shutdown("SIGTERM", 2_000);
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

test("shutdown propagates SIGTERM to the child process group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-supervisor-"));
  const ready = path.join(directory, "ready");
  const stopped = path.join(directory, "stopped");
  const supervisor = new ProcessSupervisor();
  try {
    await supervisor.start({
      name: "signal-target",
      command: [
        process.execPath,
        "-e",
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'1');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'1');process.exit(0)});setInterval(()=>{},1000)`,
      ],
      env: process.env,
      stdio: "ignore",
    });
    await withTimeout(
      (async () => {
        for (;;) {
          if (await readFile(ready, "utf8").catch(() => undefined)) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
    );

    await supervisor.shutdown("SIGTERM", 2_000);
    assert.equal(await readFile(stopped, "utf8"), "1");
  } finally {
    await supervisor.shutdown("SIGKILL", 0);
    await rm(directory, { recursive: true, force: true });
  }
});
