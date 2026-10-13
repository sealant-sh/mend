import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scenarios = new URL("scenarios.mjs", import.meta.url).href;
const peerProgram = `
import { cleanupAll } from ${JSON.stringify(scenarios)};
const stateDir = process.argv[1];
const requests = [];
const errors = [];
const api = {
  get: async (route) => {
    requests.push(["GET", route]);
    if (route === "/organization") return { userId: "bench-owner" };
    if (route === "/projects/synthetic-project/worktrees") return { worktrees: [] };
    if (route === "/me/secret-files") return { files: [] };
    throw new Error("unexpected fixture route " + route);
  },
};
const ctx = {
  rid: "kill01", stateDir, project: { id: "synthetic-project" }, api, api2: null,
  result: { errors }, pending: new Set(), created: { remoteRefs: new Set() },
  cleanupWaits: { pending: 0, final: 0, grace: 0, retry: 0, quiet: 0 },
  rec: { error: (scenario, error) => errors.push({ scenario, message: error.message }), note: () => {} },
  log: (line) => {
    if (line.includes("an interrupted run") && line.endsWith(": waiting"))
      process.send({ type: "quiet-wait", pid: process.pid, requests });
  },
};
try {
  await cleanupAll(ctx, { reconcile: true });
  process.send({ type: "finished", pid: process.pid, requests, errors });
} catch (error) {
  process.send({ type: "failed", message: error.message });
  process.exitCode = 1;
} finally { process.disconnect(); }
`;

const startPeer = (directory) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", peerProgram, directory], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = [];
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("message", (message) => messages.push(message));
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  // Keep teardown bounded even if cleanup returns but an owned child retains a timer/descriptor.
  const lifetime = setTimeout(() => {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      Number.isSafeInteger(child.pid) &&
      child.pid > 0
    )
      child.kill("SIGKILL");
  }, 10_000);
  closed.then(() => clearTimeout(lifetime));
  const waitFor = async (type) => {
    let timer;
    let receive;
    let fail;
    try {
      return await new Promise((resolve, reject) => {
        receive = (message) => {
          if (message.type === type) resolve(message);
          else if (message.type === "failed") reject(new Error(message.message));
        };
        fail = (error) => reject(error);
        child.on("message", receive);
        child.on("error", fail);
        closed.then((status) => {
          if (!messages.some((message) => message.type === type))
            reject(
              new Error(`cleanup peer closed before ${type}: ${JSON.stringify(status)} ${stderr}`),
            );
          return undefined;
        });
        timer = setTimeout(
          () => reject(new Error(`cleanup peer did not report ${type} within 8s: ${stderr}`)),
          8_000,
        );
      });
    } finally {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("error", fail);
    }
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      assert.ok(
        Number.isSafeInteger(child.pid) && child.pid > 0,
        "only an owned positive PID may be killed",
      );
      child.kill("SIGKILL");
    }
    return closed;
  };
  return { child, closed, waitFor, stop, output: () => ({ stdout, stderr }) };
};

test(
  "actual cleanupAll releases its acquired state lock after the owned process is killed",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "st-bench-killed-cleanup-"));
    const peers = [];
    const stateFile = path.join(directory, "kill01.json");
    const obligation = {
      rid: "kill01",
      projectId: "synthetic-project",
      accounts: ["bench-owner"],
      quietUntil: Date.now() + 60_000,
    };
    try {
      writeFileSync(stateFile, JSON.stringify(obligation), { mode: 0o600 });
      const holding = startPeer(directory);
      peers.push(holding);
      const acknowledgment = await holding.waitFor("quiet-wait");
      assert.equal(acknowledgment.pid, holding.child.pid);
      assert.deepEqual(
        acknowledgment.requests,
        [],
        "no cleanup API operation runs before the owned quiet period expires",
      );
      // The acknowledgment comes from cleanupAll after its lock acquisition. Independently confirm
      // that this is a real held lock, so removing production locking cannot leave this test green.
      const contention = spawnSync("flock", ["-x", "-n", path.join(directory, ".lock"), "true"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      assert.equal(contention.status, 1, contention.stderr);
      assert.equal(contention.signal, null);
      assert.deepEqual(await holding.stop(), { code: null, signal: "SIGKILL" });
      assert.deepEqual(holding.output(), { stdout: "", stderr: "" });
      assert.deepEqual(
        JSON.parse(readFileSync(stateFile, "utf8")),
        obligation,
        "SIGKILL did not falsely settle the interrupted state",
      );

      // Retry the same state entry in a genuinely fresh cleanup process. Only its owned quiet
      // deadline is expired; the obligation and account checks must still be reconciled.
      writeFileSync(stateFile, JSON.stringify({ ...obligation, quietUntil: 0 }));
      const retrying = startPeer(directory);
      peers.push(retrying);
      const result = await retrying.waitFor("finished");
      assert.notEqual(result.pid, acknowledgment.pid);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.requests, [
        ["GET", "/organization"],
        ["GET", "/projects/synthetic-project/worktrees"],
        ["GET", "/me/secret-files"],
        ["GET", "/projects/synthetic-project/worktrees"],
        ["GET", "/me/secret-files"],
      ]);
      assert.deepEqual(await retrying.closed, { code: 0, signal: null });
      assert.deepEqual(retrying.output(), { stdout: "", stderr: "" });
      assert.equal(existsSync(stateFile), false, "actual retry clears the reconciled state entry");
    } finally {
      for (const peer of peers) await peer.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
