import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("bench.mjs", import.meta.url));
const measure = "join.other.first_output";
const companionName = "configs: personal";

// A real HTTP peer for the benchmark's public API. Docker is an owned executable fixture:
// it supplies build/log observations only, never accesses Docker or launches an executor.
const fixture = async (
  t,
  {
    slow = false,
    wrongPerson = false,
    launchFailure = false,
    mainMiss = false,
    missingCompanion = false,
    mixedCarrier = false,
    unknownMeasure = false,
  } = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "st-bench-companion-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "bin"));
  mkdirSync(path.join(directory, "home"));
  const logFile = path.join(directory, "engine.log");
  const dockerFile = path.join(directory, "docker.jsonl");
  writeFileSync(logFile, "");
  writeFileSync(dockerFile, "");
  writeFileSync(
    path.join(directory, "bin/docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER, JSON.stringify(args) + "\\n");
if (args[0] === "version") console.log("27.0.0");
else if (args[0] === "ps") process.stdout.write("");
else if (args[0] === "logs") process.stdout.write(fs.readFileSync(process.env.FIXTURE_LOG));
else if (args[0] === "exec" && args.includes("printenv")) console.log("person");
else if (args[0] === "inspect" && args.at(-1).includes("revision")) console.log("abcdef1234567890");
else if (args[0] === "inspect" && args.at(-1).includes("Config.Image")) console.log("mend-fixture sha256:aabb");
else { console.error("unsupported fixture docker args", args); process.exit(1); }
`,
    { mode: 0o755 },
  );
  const projects = [
    { id: "main-id", name: "mend" },
    { id: "companion-id", name: companionName },
    { id: "other-id", name: "other" },
  ].map((project) => ({ ...project, visibility: "shared" }));
  const requests = [];
  const sessions = new Map();
  const worktrees = new Map();
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text === "" ? null : JSON.parse(text);
    const url = new URL(request.url, "http://fixture");
    const route = url.pathname;
    const actor = request.headers.authorization === "Bearer second" ? "joiner" : "owner";
    requests.push({ method: request.method, route, actor, body });
    const reply = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (route === "/api/projects") return reply(projects);
    if (route === "/api/health") return reply({ version: "0.0.0-fixture" });
    if (route === "/api/organization") return reply({ userId: actor });
    if (route === "/api/sessions")
      return reply([...sessions.values()].map((entry) => entry.session));
    if (route === "/api/me/secret-files") return reply({ files: [] });
    const projectRoute = /^\/api\/projects\/([^/]+)(.*)$/.exec(route);
    if (projectRoute !== null) {
      const [, projectId, suffix] = projectRoute;
      if (suffix === "") return reply(projects.find((project) => project.id === projectId));
      if (suffix === "/memory") return reply({ files: [{ path: "existing.md" }] });
      if (suffix === "/memory/file") return reply({ removed: false });
      if (suffix === "/worktrees") return reply({ worktrees: [...worktrees.values()] });
      if (suffix === "/sessions" && request.method === "POST") {
        const worktree = [...worktrees.values()].find((entry) => entry.name === body.name) ?? {
          id: `worktree-${worktrees.size + 1}`,
          name: body.name,
          layout: body.harnessLayout,
        };
        worktrees.set(worktree.id, worktree);
        const session = {
          id: `session-${sessions.size + 1}`,
          harness: body.harness,
          ownerUserId: actor,
          projectId,
          worktree: body.name,
          worktreeId: worktree.id,
          sealantWorkspaceId: `workspace-${worktree.id}`,
          status: "running",
          settledAt: null,
        };
        sessions.set(session.id, { session, body, answer: "" });
        return reply(session);
      }
    }
    const sessionRoute = /^\/api\/sessions\/([^/]+)(.*)$/.exec(route);
    if (sessionRoute !== null) {
      const [, id, suffix] = sessionRoute;
      const entry = sessions.get(id);
      assert.ok(entry, `known fixture session ${id}`);
      if (suffix === "/launch") {
        if (launchFailure && entry.session.ownerUserId === "joiner")
          return reply({ error: "synthetic launch failure" }, 500);
        const question = /What is (\d+) \+ (\d+)\?/.exec(body.prompt ?? "");
        entry.answer = question === null ? "" : String(Number(question[1]) + Number(question[2]));
        const now = Date.now();
        const stamp = new Date(now).toISOString();
        const joined = entry.session.ownerUserId === "joiner";
        entry.agent = {
          id: `process-${id}`,
          createdAt: new Date(now + 50).toISOString(),
          firstOutputAt: new Date(now + (joined && slow ? 50_000 : 100)).toISOString(),
          runsAs:
            worktrees.get(entry.session.worktreeId).layout === "person"
              ? wrongPerson && joined
                ? "owner"
                : entry.session.ownerUserId
              : null,
        };
        const fields = ` { sessionId: '${id}', workspaceId: '${entry.session.sealantWorkspaceId}' }`;
        writeFileSync(
          logFile,
          `${stamp} [${stamp.slice(11, 23)}] INFO: Workspace image plan unchanged (hash abcdef); reusing sha256:ccdd\n` +
            `${stamp} [${stamp.slice(11, 23)}] INFO: session engine: joining the lease holder${fields}\n`,
        );
        return reply(entry.session);
      }
      if (suffix === "/stop") {
        entry.session.status = "completed";
        entry.session.settledAt = new Date().toISOString();
        return reply(entry.session);
      }
      if (suffix === "")
        return reply({ session: entry.session, currentAgent: entry.agent ?? null });
    }
    const processRoute = /^\/api\/processes\/process-(session-\d+)\/logs$/.exec(route);
    if (processRoute !== null) {
      const entry = sessions.get(processRoute[1]);
      const version =
        entry.session.harness === "codex" ? "OpenAI Codex (v1.2.3)" : "Claude Code v1.2.3";
      return reply({
        chunks: [{ dataBase64: Buffer.from(`${version}\n${entry.answer}\n`).toString("base64") }],
        nextFrom: "1",
        status: "running",
      });
    }
    const worktreeRoute = /^\/api\/worktrees\/([^/]+)$/.exec(route);
    if (worktreeRoute !== null) {
      const worktree = worktrees.get(worktreeRoute[1]);
      if (request.method === "DELETE") {
        worktrees.delete(worktreeRoute[1]);
        return reply({ removed: true });
      }
      return reply({
        worktree,
        sessions: [...sessions.values()]
          .map((entry) => entry.session)
          .filter((session) => session.worktreeId === worktreeRoute[1]),
      });
    }
    return reply({ unsupported: route }, 500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const record = (project, value) => ({
    schema: 1,
    kind: "mend-bench",
    startedAt: "2026-01-01T00:00:00.000Z",
    target: {
      url,
      layout: "person",
      commit: "abcdef1234567890",
      mendImage: "mend-fixture sha256:aabb",
      workspaceImage: "sha256:ccdd",
      project,
      harnessVersions: { claude: "1.2.3", codex: "1.2.3", opencode: "1.18.34" },
    },
    options: { layout: "person", only: ["join-other"], harnesses: ["codex"], runs: 1 },
    method: { firstHarness: "codex" },
    measures: {
      [measure]: {
        unit: "ms",
        budget: "join-other",
        samples: Array(10).fill(value),
        layout: "person",
        harness: "codex",
        harnessVersion: "1.2.3",
      },
      "sentinel.unrelated": { unit: "count", samples: [91] },
      "new.opencode.output_to_answer": {
        unit: "ms",
        samples: [11, 22],
        sampleSources: ["opencode record", "terminal screen"],
        layout: "person",
        harness: "opencode",
        harnessVersion: "1.18.34",
      },
    },
    checks: [{ check: "join.other.runs_as", passed: 1, failed: 0, skipped: 0 }],
    errors: [],
    notes: ["original note"],
    notRun: [],
  });
  const main = record(projects[0], 10_000);
  main.options.only = [];
  main.companions = {
    [companionName]: record(projects[1], 10_000),
    other: record(projects[2], 10_000),
  };
  const before = structuredClone(main);
  const after = structuredClone(main);
  after.companions[companionName].measures[measure].samples = Array(10).fill(900_000);
  if (mainMiss) after.measures[measure].samples = Array(10).fill(800_000);
  if (missingCompanion) delete after.companions[companionName];
  if (unknownMeasure) {
    after.companions[companionName].measures[measure].samples = Array(10).fill(10_000);
    for (const [fixtureRecord, value] of [
      [before, 1000],
      [after, 900_000],
    ]) {
      fixtureRecord.companions["api.alias"] = structuredClone(
        fixtureRecord.companions[companionName],
      );
      fixtureRecord.companions["api.alias"].measures["unknown.quantity"] = {
        unit: "ms",
        budget: "api",
        samples: Array(10).fill(value),
      };
    }
  }
  if (mixedCarrier) {
    for (const [fixtureRecord, value] of [
      [before, 1000],
      [after, 900_000],
    ]) {
      fixtureRecord.companions[companionName].measures["api.session_list"] = {
        unit: "ms",
        budget: "api",
        samples: Array(10).fill(value),
        layout: "person",
        harness: "claude",
        harnessVersion: "1.2.3",
      };
    }
  }
  const beforeFile = path.join(directory, "before.json");
  const afterFile = path.join(directory, "after.json");
  const output = path.join(directory, "output.json");
  writeFileSync(beforeFile, JSON.stringify(before));
  writeFileSync(afterFile, JSON.stringify(after));
  writeFileSync(path.join(directory, "first-token"), "first");
  writeFileSync(path.join(directory, "second-token"), "second");
  const child = spawn(
    process.execPath,
    [
      cli,
      "compare",
      beforeFile,
      afterFile,
      "--rerun",
      "--url",
      url,
      "--token-file",
      path.join(directory, "first-token"),
      "--second-token-file",
      path.join(directory, "second-token"),
      "--project",
      "mend",
      "--harnesses",
      "claude",
      "--runs",
      "1",
      "--api-runs",
      "1",
      "--out",
      output,
    ],
    {
      env: {
        HOME: path.join(directory, "home"),
        PATH: `${directory}/bin:/usr/bin:/bin`,
        FIXTURE_LOG: logFile,
        FIXTURE_DOCKER: dockerFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(signal, null, stderr);
  const merged = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
  return {
    status,
    stdout,
    stderr,
    requests,
    merged,
    after,
    worktrees,
    docker: readFileSync(dockerFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};

test("compare --rerun replaces a companion's entire failed series on its project, layout and harness", async (t) => {
  const result = await fixture(t);
  assert.equal(result.status, 0, result.stderr);
  const creates = result.requests.filter(
    (request) => request.method === "POST" && request.route.endsWith("/sessions"),
  );
  assert.equal(creates.length, 20, "ten launches and ten joins, even with --runs 1");
  for (const request of creates) {
    assert.equal(request.route, "/api/projects/companion-id/sessions");
    assert.equal(request.body.harness, "codex");
    if (request.actor === "owner") assert.equal(request.body.harnessLayout, "person");
    assert.equal(request.body.autoLand, false);
  }
  assert.deepEqual(
    { ...result.merged, companions: undefined },
    { ...result.after, companions: undefined },
  );
  assert.deepEqual(result.merged.companions.other, result.after.companions.other);
  const companion = result.merged.companions[companionName];
  assert.equal(companion.measures[measure].samples.length, 10);
  assert.ok(companion.measures[measure].samples.every((sample) => sample < 13_000));
  assert.equal(companion.measures[measure].harness, "codex");
  assert.equal(companion.measures[measure].layout, "person");
  assert.deepEqual(
    companion.measures["new.opencode.output_to_answer"],
    result.after.companions[companionName].measures["new.opencode.output_to_answer"],
  );
  assert.deepEqual(companion.measures["sentinel.unrelated"], {
    ...result.after.companions[companionName].measures["sentinel.unrelated"],
    layout: "person",
  });
  assert.deepEqual(companion.options, result.after.companions[companionName].options);
  assert.equal(companion.checks.find((check) => check.check === "join.other.runs_as").passed, 11);
  assert.equal(companion.merged.length, 1);
  assert.notEqual(companion.merged[0].startedAt, companion.startedAt);
  assert.deepEqual(companion.merged[0].only, ["join-other"]);
  assert.deepEqual(companion.merged[0].measures, [measure]);
  assert.match(result.stdout, /after the re-run/);
  assert.match(result.stderr, /verdict .* passed/);
  assert.equal(result.worktrees.size, 0);
  assert.ok(result.docker.length > 0);
});

test("compare --rerun fails when the companion's second series is still over its limit", async (t) => {
  const result = await fixture(t, { slow: true });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.merged.companions[companionName].measures[measure].samples.length, 10);
  assert.ok(
    result.merged.companions[companionName].measures[measure].samples.every(
      (sample) => sample > 13_000,
    ),
  );
  assert.match(result.stderr, /verdict .* FAILED/);
});

test("compare --rerun includes companion correctness failures even when the new timing is fast", async (t) => {
  const result = await fixture(t, { wrongPerson: true });
  assert.equal(result.status, 1, result.stderr);
  const checks = result.merged.companions[companionName].checks;
  assert.equal(checks.find((check) => check.check === "join.other.runs_as").failed, 10);
  assert.match(result.stdout, /configs: personal: join.other.runs_as/);
});

test("compare --rerun keeps companion rerun errors and does not replace a series with absent samples", async (t) => {
  const result = await fixture(t, { launchFailure: true });
  assert.equal(result.status, 1, result.stderr);
  const companion = result.merged.companions[companionName];
  assert.deepEqual(companion.measures[measure].samples, Array(10).fill(900_000));
  assert.equal(
    companion.errors.filter((error) => error.message.includes("synthetic launch failure")).length,
    10,
  );
  assert.match(result.stdout, /Errors in the run under test/);
  assert.equal(result.worktrees.size, 0);
});

test("compare --rerun routes simultaneous main and companion misses separately", async (t) => {
  const result = await fixture(t, { mainMiss: true });
  assert.equal(result.status, 0, result.stderr);
  const creates = result.requests.filter(
    (request) => request.method === "POST" && request.route.endsWith("/sessions"),
  );
  assert.equal(
    creates.filter((request) => request.route === "/api/projects/main-id/sessions").length,
    20,
  );
  assert.equal(
    creates.filter((request) => request.route === "/api/projects/companion-id/sessions").length,
    20,
  );
  assert.equal(creates.length, 40);
  assert.equal(result.merged.measures[measure].samples.length, 10);
  assert.equal(result.merged.companions[companionName].measures[measure].samples.length, 10);
  assert.deepEqual(result.merged.options, result.after.options);
  assert.deepEqual(result.merged.companions.other, result.after.companions.other);
  assert.deepEqual(
    result.merged.measures["new.opencode.output_to_answer"],
    result.after.measures["new.opencode.output_to_answer"],
  );
  assert.equal(result.worktrees.size, 0);
});

test("compare --rerun refuses a baseline-only companion before contacting any server", async (t) => {
  const result = await fixture(t, { missingCompanion: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no unambiguous record under test owns/);
  assert.equal(result.merged, null);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.docker, []);
});

test("compare --rerun keeps differently carried companion series paired with their own harness", async (t) => {
  const result = await fixture(t, { mixedCarrier: true });
  assert.equal(result.status, 0, result.stderr);
  const companion = result.merged.companions[companionName];
  assert.equal(companion.measures[measure].samples.length, 10);
  assert.ok(companion.measures[measure].samples.every((value) => value < 13_000));
  assert.equal(companion.measures[measure].harness, "codex");
  assert.equal(companion.measures["api.session_list"].samples.length, 10);
  assert.ok(companion.measures["api.session_list"].samples.every((value) => value < 1020));
  assert.equal(companion.measures["api.session_list"].harness, "claude");
  assert.equal(result.requests.filter((request) => request.route === "/api/sessions").length, 10);
  assert.equal(companion.merged.length, 2);
  assert.deepEqual(
    companion.merged.map((entry) => entry.only),
    [["join-other"], ["api"]],
  );
  assert.deepEqual(result.merged.companions.other, result.after.companions.other);
  assert.equal(result.worktrees.size, 0);
});

test("compare --rerun refuses an unmapped companion measure without treating its prefix as a main scenario", async (t) => {
  const result = await fixture(t, { unknownMeasure: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no unambiguous record under test owns api.alias: unknown.quantity/);
  assert.equal(result.merged, null);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.docker, []);
});
