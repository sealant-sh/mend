import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("bench.mjs", import.meta.url));
const runId = "live01";
const otherRunId = "other1";
const actorOf = (request) => {
  assert.ok(["Bearer first", "Bearer second"].includes(request.headers.authorization));
  return request.headers.authorization === "Bearer second" ? "joiner" : "owner";
};
const session = (id, ownerUserId) => ({ id, ownerUserId, status: "running", settledAt: null });
const tree = (id, name, sessions) => ({ id, name, sessions });

// Each child invokes the unchanged public CLI, including its real private-state lock,
// 10-second reconciliation grace and 2-second retry delay. Only the HTTP peer is local.
const cleanupFixture = async (t, { mode }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "st-bench-live-cleanup-"));
  let server = null;
  let child = null;
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  const state = path.join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(path.join(directory, "home"), { mode: 0o700 });
  const obligation = path.join(state, `${runId}.json`);
  const unrelated = path.join(state, `${otherRunId}.json`);
  const initial = `${JSON.stringify({ rid: runId, projectId: "project", quietUntil: 0, why: "synthetic settled request", accounts: ["owner", "joiner"] })}\n`;
  const other = `${JSON.stringify({ rid: otherRunId, projectId: "project", quietUntil: 0, why: "different run", accounts: ["owner"] })}\n`;
  writeFileSync(obligation, initial, { mode: 0o600 });
  writeFileSync(unrelated, other, { mode: 0o600 });
  writeFileSync(path.join(directory, "first-token"), "first", { mode: 0o600 });
  writeFileSync(path.join(directory, "second-token"), "second", { mode: 0o600 });
  const worktrees = new Map([
    ["ordinary", tree("ordinary", "ordinary", [session("ordinary-session", "owner")])],
    [
      "other-run",
      tree("other-run", "st-bench-other1-claude-1", [session("other-session", "owner")]),
    ],
  ]);
  if (mode === "foreign") {
    worktrees.set(
      "foreign",
      tree("foreign", "st-bench-live01-foreign", [session("foreign-session", "outsider")]),
    );
    worktrees.set(
      "unknown",
      tree("unknown", "st-bench-live01-unknown", [session("unknown-session", null)]),
    );
    worktrees.set("no-session", tree("no-session", "st-bench-live01-empty", []));
  } else {
    worktrees.set(
      "owned",
      tree("owned", "st-bench-live01-claude-1", [
        session("first-session", "owner"),
        session("second-session", "joiner"),
      ]),
    );
  }
  const requests = [];
  const failures = [];
  const polls = new Map();
  let readAttempts = 0;
  let deleteAttempts = 0;
  let recovering = false;
  const routeRequest = async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text === "" ? null : JSON.parse(text);
    const url = new URL(request.url, "http://fixture");
    const route = url.pathname;
    const actor = actorOf(request);
    requests.push({
      method: request.method,
      route,
      actor,
      body,
      query: Object.fromEntries(url.searchParams),
      at: performance.now(),
    });
    const reply = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET") {
      if (route === "/api/projects")
        return reply([{ id: "project", name: "synthetic", originUrl: null }]);
      if (route === "/api/organization") return reply({ userId: actor });
      if (route === "/api/projects/project/worktrees")
        return reply({ worktrees: [...worktrees.values()].map(({ id, name }) => ({ id, name })) });
      if (route === "/api/me/secret-files") return reply({ files: [] });
    }
    if (route === "/api/projects/project/memory/file" && request.method === "DELETE") {
      assert.equal(actor, "joiner");
      assert.equal(
        url.searchParams.get("path"),
        ".claude/projects/-workspace-repo/memory/st-bench-live01.md",
      );
      return reply({ removed: false });
    }
    const treeRoute = /^\/api\/worktrees\/([^/]+)$/.exec(route);
    if (treeRoute !== null) {
      const row = worktrees.get(treeRoute[1]);
      assert.ok(row, "only an existing fixture worktree is read or removed");
      assert.equal(actor, "owner");
      if (request.method === "GET") {
        readAttempts += 1;
        if (mode === "retry" && readAttempts === 1)
          return reply({ error: "synthetic transient worktree read" }, 503);
        return reply({ worktree: { id: row.id, name: row.name }, sessions: row.sessions });
      }
      if (request.method === "DELETE") {
        deleteAttempts += 1;
        assert.deepEqual(Object.fromEntries(url.searchParams), { force: "true" });
        if (mode === "retry" && deleteAttempts === 1)
          return reply({ error: "synthetic transient worktree removal" }, 503);
        if (mode === "delete-refusal" && !recovering)
          return reply({ error: "synthetic permanent worktree removal refusal" }, 403);
        worktrees.delete(row.id);
        return reply({ removed: true });
      }
    }
    const sessionRoute = /^\/api\/sessions\/([^/]+)(.*)$/.exec(route);
    if (sessionRoute !== null) {
      const [, id, suffix] = sessionRoute;
      const row = [...worktrees.values()]
        .flatMap((worktree) => worktree.sessions)
        .find((candidate) => candidate.id === id);
      assert.ok(row, "only an existing fixture session is read or stopped");
      if (request.method === "POST" && suffix === "/stop") {
        assert.deepEqual(body, {});
        if (actor !== row.ownerUserId)
          return reply({ error: "only the session owner stops it" }, 403);
        if (mode === "stop-refusal" && id === "first-session")
          return reply({ error: "synthetic Stop refusal" }, 409);
        row.status = "stopping";
        polls.set(id, 0);
        return reply(row);
      }
      if (request.method === "GET" && suffix === "") {
        assert.equal(actor, row.ownerUserId, "poll with the token that stopped this session");
        assert.ok(polls.has(id), "poll follows a successful owned Stop");
        polls.set(id, polls.get(id) + 1);
        if (polls.get(id) === 2) {
          row.status = "completed";
          row.settledAt = "2026-10-13T00:00:00.000Z";
        }
        return reply({ session: row });
      }
    }
    throw new Error(`unsupported fixture route ${request.method} ${route}`);
  };
  server = createServer((request, response) => {
    routeRequest(request, response).catch((error) => {
      failures.push(error.message);
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ fixture: error.message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const run = async () => {
    child = spawn(
      process.execPath,
      [
        cli,
        "cleanup",
        "--url",
        `http://127.0.0.1:${server.address().port}`,
        "--token-file",
        path.join(directory, "first-token"),
        "--second-token-file",
        path.join(directory, "second-token"),
        "--project",
        "synthetic",
        "--run",
        runId,
        "--no-host",
      ],
      {
        env: {
          HOME: path.join(directory, "home"),
          TMPDIR: directory,
          ST_BENCH_STATE_DIR: state,
          PATH: "/usr/bin:/bin",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    timer = setTimeout(() => {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
      child.kill("SIGKILL");
    }, 40_000);
    const [status, signal] = await once(child, "close");
    clearTimeout(timer);
    assert.equal(signal, null, stderr);
    assert.deepEqual(failures, []);
    assert.equal(readFileSync(unrelated, "utf8"), other, "another run's obligation remains exact");
    return { status, stderr };
  };
  return {
    run,
    requests,
    worktrees,
    polls,
    obligation,
    initial,
    recover: () => {
      recovering = true;
    },
  };
};

const sessionCalls = (requests) =>
  requests
    .filter(({ route }) => route.startsWith("/api/sessions/"))
    .map(({ method, route, actor }) => ({ method, route, actor }));
const assertNeighbors = (fixture) => {
  assert.deepEqual(
    fixture.worktrees.get("ordinary"),
    tree("ordinary", "ordinary", [session("ordinary-session", "owner")]),
  );
  assert.deepEqual(
    fixture.worktrees.get("other-run"),
    tree("other-run", "st-bench-other1-claude-1", [session("other-session", "owner")]),
  );
  assert.ok(
    fixture.requests.every(
      ({ route }) =>
        !route.includes("ordinary") &&
        !route.includes("other-run") &&
        !route.includes("ordinary-session") &&
        !route.includes("other-session"),
    ),
  );
};
const expectedStops = [
  { method: "POST", route: "/api/sessions/first-session/stop", actor: "owner" },
  { method: "GET", route: "/api/sessions/first-session", actor: "owner" },
  { method: "GET", route: "/api/sessions/first-session", actor: "owner" },
  { method: "POST", route: "/api/sessions/second-session/stop", actor: "owner" },
  { method: "POST", route: "/api/sessions/second-session/stop", actor: "joiner" },
  { method: "GET", route: "/api/sessions/second-session", actor: "joiner" },
  { method: "GET", route: "/api/sessions/second-session", actor: "joiner" },
];

export { cleanupFixture, sessionCalls, assertNeighbors, expectedStops };
