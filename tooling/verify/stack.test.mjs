import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRun, runName, stackDown, stackStatus, stackUp } from "./stack.mjs";

// A machine with an outer CLI config, and a fake of the skill's scripts and the mend CLI that
// records each call and answers as a healthy run would, unless told otherwise.
const world = (t, answers = {}) => {
  const root = mkdtempSync(join(tmpdir(), "mend-verify-stack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "outer-cli/mend"), { recursive: true });
  writeFileSync(join(root, "outer-cli/mend/cli.json"), "{}");
  const env = {
    PATH: "/usr/bin",
    XDG_CONFIG_HOME: join(root, "outer-cli"),
    XDG_STATE_HOME: join(root, "state"),
    MEND_VERIFY_OUTER_URL: "https://outer.example.invalid",
  };
  const calls = [];
  const answer = (name, fallback) => (answers[name] === undefined ? fallback : answers[name]);
  const exec = async (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push({ line, env: options.env, input: options.input });
    const is = (pattern) => pattern.test(line);
    if (is(/slots\.mjs.*--mine/)) return { code: answer("admitted", 0), stdout: "" };
    if (is(/slots\.mjs/)) return { code: answer("slot", 0), stdout: "" };
    if (is(/^mend run .*--detach/))
      return { code: 0, stdout: JSON.stringify({ sessionId: "s-outer", status: "running" }) };
    if (is(/^mend service run/)) return { code: answer("service", 0), stdout: "" };
    if (is(/^mend service list/)) return { code: 0, stdout: answer("listed", "") };
    if (is(/^timeout 8 mend service logs/)) {
      const logs = answer("logs", ["verify stack · building\nverify stack · health answers\n"]);
      return { code: 124, stdout: logs.length > 1 ? logs.shift() : logs[0] };
    }
    if (is(/handover\.mjs keygen/)) return { code: 0, stdout: "PUBLIC-KEY\n" };
    if (is(/handover\.mjs seal --to PUBLIC-KEY/)) return { code: 0, stdout: "CIPHERTEXT" };
    if (is(/doctor\.mjs/))
      return answer("doctor", { code: 0, stdout: "ok · tunnel\nok · health\n" });
    if (is(/^mend sessions --json/))
      // Off a terminal the CLI wraps its answer in its command contract.
      return {
        code: 0,
        stdout: JSON.stringify({
          v: 1,
          status: "done",
          data: {
            sessions: [
              { id: "s-outer", worktree: answer("worktree", "") },
              { id: "s-sibling", worktree: answer("worktree", "") },
              { id: "s-someone-else", worktree: "st-verify-other" },
            ],
          },
        }),
      };
    if (is(/settle\.mjs/)) return { code: answer("settle", 0), stdout: "" };
    if (is(/scan-evidence\.mjs/)) return { code: answer("scan", 0), stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { root, env, exec, calls };
};

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const up = async (w, extra = {}) =>
  stackUp(w.root, {
    env: w.env,
    exec: w.exec,
    port: await freePort(),
    wait: async () => {},
    ...extra,
  });

test("the run name is the skill's: UTC month, day, hour, minute and four hex digits", () => {
  assert.match(runName(new Date("2026-11-14T23:05:00Z")), /^1114-2305-[0-9a-f]{4}$/);
});

test("without an outer server and its CLI config, up is blocked and says how to get one", async (t) => {
  const w = world(t);
  const result = await up(w, { env: { PATH: "/usr/bin" } });
  assert.equal(result.steps[0].status, "blocked_by_prerequisite");
  assert.ok(result.next.some((line) => line.includes("local-outer.sh up")));
  assert.equal(w.calls.length, 0);
});

test("up walks Launch through the guard and is ready only when the doctor passes", async (t) => {
  const w = world(t);
  const result = await up(w);
  assert.deepEqual(
    result.steps.map((step) => [step.id, step.status]),
    [
      ["slot", "passed"],
      ["session", "passed"],
      ["service", "passed"],
      ["admitted", "passed"],
      ["ready", "passed"],
      ["tunnel", "passed"],
      ["account", "passed"],
      ["doctor", "passed"],
    ],
  );
  for (const call of w.calls) {
    assert.ok(
      call.env.PATH.startsWith(join(w.root, ".agents/skills/verify/scripts/guard:")),
      call.line,
    );
    assert.ok(call.env.MEND_VERIFY_PRIVATE, call.line);
  }
  const worktree = result.stack.worktree;
  assert.ok(
    w.calls.some(
      (call) =>
        call.line.includes(`service run s-outer --port`) &&
        call.line.includes(`--name ${worktree}`),
    ),
  );
  assert.equal(w.calls.find((call) => /handover\.mjs open/.test(call.line)).input, "CIPHERTEXT");
  assert.equal(readRun(w.root).phase, "ready");
  assert.ok(
    !w.calls.some((call) => /local-outer\.sh seed/.test(call.line)),
    "only a local outer is seeded",
  );
});

test("a port that answers is not ready: up waits for the stack's own word, then the doctor", async (t) => {
  const notYet = world(t, { logs: ["verify stack · listening on 3345\n"] });
  let clock = 0;
  const waiting = await up(notYet, {
    now: () => clock,
    wait: async () => {
      clock += 60_000;
    },
    readyTimeoutMs: 600_000,
  });
  assert.equal(waiting.steps.at(-1).id, "ready");
  assert.equal(waiting.steps.at(-1).status, "failed");
  assert.ok(
    !notYet.calls.some((call) => /tunnel\.mjs start/.test(call.line)),
    "no tunnel to a stack that is not ready",
  );
  assert.deepEqual(waiting.next, ["pnpm verify stack down"]);

  const failing = world(t, { logs: ["verify stack: sealantd build failed\n"] });
  const failed = await up(failing);
  assert.equal(failed.steps.at(-1).detail, "verify stack: sealantd build failed");

  const sick = world(t, { doctor: { code: 1, stdout: "ok · tunnel\nNOT · health · 502\n" } });
  const unhealthy = await up(sick);
  assert.equal(unhealthy.steps.at(-1).id, "doctor");
  assert.equal(unhealthy.steps.at(-1).status, "failed");
  assert.equal(unhealthy.steps.at(-1).detail, "NOT · health · 502");
});

test("no slot, or over the limit once listed, is blocked; a second up waits for down", async (t) => {
  const full = world(t, { slot: 1 });
  assert.equal((await up(full)).steps.at(-1).status, "blocked_by_prerequisite");
  assert.ok(!full.calls.some((call) => /--detach/.test(call.line)), "no session without a slot");

  const over = world(t, { admitted: 1 });
  assert.equal((await up(over)).steps.at(-1).status, "blocked_by_prerequisite");

  const twice = world(t);
  await up(twice);
  const second = await up(twice);
  assert.equal(second.steps[0].id, "run");
  assert.equal(second.steps[0].status, "blocked_by_prerequisite");
});

test("down stops only what this run recorded, waits for the save, and drops the private registry", async (t) => {
  const w = world(t);
  const launched = await up(w);
  const worktree = launched.stack.worktree;
  const privateDir = readRun(w.root).private;
  const down = world(t, { worktree });
  const result = await stackDown(w.root, { env: w.env, exec: down.exec });
  const stopped = down.calls
    .filter((call) => /^mend stop /.test(call.line))
    .map((call) => call.line);
  assert.deepEqual(stopped, [
    "mend stop s-sibling",
    "mend stop --services s-outer",
    "mend stop s-outer",
  ]);
  assert.ok(down.calls.some((call) => /settle\.mjs --session s-outer/.test(call.line)));
  assert.equal(result.cleanup.status, "left", "only the worktree, which holds the record, stays");
  assert.ok(!existsSync(privateDir));
  assert.equal(readRun(w.root).phase, "down");
  assert.equal(
    (await stackStatus(w.root, { env: w.env, exec: down.exec })).steps[0].status,
    "blocked_by_prerequisite",
  );
});

test("a Stop that never saves, or a secret in the evidence, is reported, not passed", async (t) => {
  const w = world(t);
  await up(w);
  const down = world(t, { settle: 1, scan: 1 });
  const result = await stackDown(w.root, { env: w.env, exec: down.exec });
  assert.equal(result.steps.find((step) => step.id === "saved").status, "failed");
  assert.equal(result.steps.find((step) => step.id === "scan").status, "evidence_withheld");
  assert.equal(result.cleanup.status, "failed");
  assert.ok(result.cleanup.left.some((line) => line.includes("still saving")));
});

test("a stack reports to Sentry only when this machine names the projects", async () => {
  const { telemetryFlags } = await import("./stack.mjs");
  assert.deepEqual(telemetryFlags({}), []);
  assert.deepEqual(telemetryFlags({ MEND_VERIFY_SENTRY_DSN: "  " }), []);
  assert.deepEqual(
    telemetryFlags({
      MEND_VERIFY_SENTRY_DSN: "https://m@sentry.example/3",
      MEND_VERIFY_SEALANT_SENTRY_DSN: " https://s@sentry.example/2 ",
      MEND_VERIFY_SEALANTD_SENTRY_DSN: "https://d@sentry.example/10",
    }),
    [
      "--sentry-dsn",
      "https://m@sentry.example/3",
      "--sealant-sentry-dsn",
      "https://s@sentry.example/2",
      "--sealantd-sentry-dsn",
      "https://d@sentry.example/10",
      "--sentry-environment",
      "verify-stack",
    ],
  );
});
