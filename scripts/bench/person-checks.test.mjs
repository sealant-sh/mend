import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("bench.mjs", import.meta.url));
const first = { account: "owner", uid: 41001, home: "/home/mend-owner", digest: "a".repeat(64) };
const second = { account: "joiner", uid: 41002, home: "/home/mend-joiner", digest: "b".repeat(64) };

// The external peer exposes real HTTP and executable argv boundaries. Its account facts are
// independent of the benchmark's verdict helpers; it never executes Docker or reads a real home.
const personRun = async (t, fault = null) => {
  const directory = mkdtempSync(path.join(tmpdir(), "st-bench-person-"));
  let server = null;
  let child = null;
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const closing = once(child, "close");
      child.kill("SIGKILL");
      await closing;
    }
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(path.join(directory, "bin"));
  mkdirSync(path.join(directory, "home"));
  const stateFile = path.join(directory, "state.json");
  const dockerFile = path.join(directory, "docker.jsonl");
  const sessions = new Map();
  const worktrees = new Map();
  const requests = [];
  const save = () =>
    writeFileSync(
      stateFile,
      JSON.stringify({
        sessions: [...sessions.values()],
        worktrees: [...worktrees.values()],
        fault,
        first,
        second,
      }),
    );
  save();
  writeFileSync(dockerFile, "");
  writeFileSync(
    path.join(directory, "bin/docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.PERSON_STATE, "utf8"));
fs.appendFileSync(process.env.PERSON_DOCKER, JSON.stringify(args) + "\\n");
if (args[0] === "version") console.log("27.0.0");
else if (args[0] === "ps") console.log(state.worktrees.map(x => "sealant-" + x.id).join("\\n"));
else if (args[0] === "inspect" && args.at(-1).includes("revision")) console.log("abcdef1234567890");
else if (args[0] === "inspect" && args.at(-1).includes("Config.Image")) console.log("fixture sha256:aabb");
else if (args[0] === "inspect" && args.at(-1).includes("Config.Env")) {
 const session = state.sessions.find(x => "sealant-" + x.session.worktreeId === args[1]);
 if (session) console.log("MEND_SESSION_ID=" + session.session.id);
}
else if (args[0] === "exec" && args.includes("printenv")) console.log("person");
else if (args[0] === "exec" && args.includes("stat")) {
 const account = args.at(-1).split("/").at(-1);
 console.log(account === "owner" ? state.first.uid : state.second.uid);
}
else if (args[0] === "exec" && args.some(x => x.includes("--version"))) console.log("1.2.3");
else if (args[0] === "exec" && args.includes("st-bench")) {
 const account = args.at(-1);
 const person = account === "owner" ? state.first : state.second;
 const userIndex = args.indexOf("-u");
 if (userIndex < 0 || Number(args[userIndex + 1]) !== person.uid) throw Error("probe was not run as its saved-directory owner");
 const container = args[userIndex + 2];
 const session = state.sessions.find(x => "sealant-" + x.session.worktreeId === container);
 if (!session) throw Error("unknown fixture container");
 const harness = session.session.harness;
 const script = args[args.indexOf("-c") + 1];
 if (!script.includes("probe uid") || !script.includes("ST_BENCH_PASSWD")) throw Error("not the real person probe command");
 const uid = state.fault === "joinedIdentity" && account === "joiner" ? state.first.uid : person.uid;
 console.log("probe uid " + uid);
 console.log("probe user mend-" + account + " " + person.home);
 console.log("probe home-stat " + uid + " " + (state.fault === "homeMode" && harness === "claude" ? "755" : "700"));
 console.log("probe proc " + harness);
 const absent = state.fault === "missingLogin" && harness === "opencode";
 if (absent) console.log("probe login openai absent");
 else {
  const owner = state.fault === "loginOwner" && harness === "opencode" ? state.second.uid : uid;
  const readable = state.fault === "loginUnreadable" && harness === "opencode" ? "unreadable" : "1";
  console.log("probe login openai present " + owner + " 600 " + readable + " " + person.home + "/.local/share/opencode/auth.json");
 }
 console.log("probe login openai-codex present " + uid + " 600 1 " + person.home + "/.pi/agent/auth.json");
 const digest = state.fault === "profileDigest" && account === "owner" ? state.second.digest
  : state.fault === "joinedProfile" && account === "joiner" ? state.first.digest : person.digest;
 console.log("probe pi-profile present " + uid + " 700 1 " + digest);
}
else { console.error("unsupported fixture docker args", args); process.exit(1); }
`,
    { mode: 0o755 },
  );
  const project = { id: "project", name: "mend", visibility: "shared" };
  server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text === "" ? null : JSON.parse(text);
    const url = new URL(request.url, "http://fixture");
    const route = url.pathname;
    const actor = request.headers.authorization === "Bearer second" ? second : first;
    requests.push({ method: request.method, route, actor: actor.account, body });
    const reply = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (route === "/api/projects") return reply([project]);
    if (route === "/api/health") return reply({ version: "0.0.0-fixture" });
    if (route === "/api/organization") return reply({ userId: actor.account });
    if (route === "/api/me/secret-files") return reply({ files: [] });
    if (route === "/api/me/pi-profile") return reply({ profile: { digest: actor.digest } });
    if (route === "/api/me/sealant") {
      const current = [...sessions.values()].at(-1);
      return reply({
        accounts:
          fault === "missingLogin" && current.session.harness === "opencode"
            ? []
            : [{ provider: "codex", status: "active" }],
      });
    }
    if (route === "/api/projects/project/worktrees")
      return reply({ worktrees: [...worktrees.values()] });
    if (route === "/api/projects/project/memory/file") return reply({ removed: false });
    if (route === "/api/projects/project/sessions" && request.method === "POST") {
      const worktree = [...worktrees.values()].find((entry) => entry.name === body.name) ?? {
        id: `tree-${sessions.size + 1}`,
        name: body.name,
      };
      worktrees.set(worktree.id, worktree);
      const session = {
        id: `session-${sessions.size + 1}`,
        harness: body.harness,
        ownerUserId: actor.account,
        worktree: body.name,
        worktreeId: worktree.id,
        sealantWorkspaceId: `workspace-${worktree.id}`,
        status: "running",
        settledAt: null,
        summary: null,
      };
      sessions.set(session.id, { session, actor });
      save();
      return reply(session);
    }
    const sessionRoute = /^\/api\/sessions\/([^/]+)(.*)$/.exec(route);
    if (sessionRoute !== null) {
      const [, id, suffix] = sessionRoute;
      const entry = sessions.get(id);
      if (suffix === "/launch") {
        entry.prompt = body.prompt;
        entry.agent = {
          id: `process-${id}`,
          createdAt: new Date().toISOString(),
          firstOutputAt: new Date().toISOString(),
          runsAs:
            fault === "runsAs" && entry.session.harness === "codex"
              ? "joiner"
              : entry.actor.account,
        };
        save();
        return reply(entry.session);
      }
      if (suffix === "/stop") {
        entry.session.status = "completed";
        entry.session.settledAt = new Date().toISOString();
        save();
        return reply(entry.session);
      }
      if (suffix === "")
        return reply({ session: entry.session, currentAgent: entry.agent ?? null });
    }
    const logs = /^\/api\/processes\/process-(session-\d+)\/logs$/.exec(route);
    if (logs !== null) {
      const entry = sessions.get(logs[1]);
      const missing = fault === "missingLogin" && entry.session.harness === "opencode";
      const uid =
        fault === "agentIdentity" && entry.session.harness === "claude"
          ? second.uid
          : entry.actor.uid;
      return reply({
        chunks: missing
          ? []
          : [
              {
                dataBase64: Buffer.from(`ST-BENCH-ID ${uid} ${entry.actor.home}`).toString(
                  "base64",
                ),
              },
            ],
        nextFrom: "1",
        status: missing ? "exited" : "running",
      });
    }
    const tree = /^\/api\/worktrees\/([^/]+)$/.exec(route);
    if (tree !== null) {
      if (request.method === "DELETE") {
        worktrees.delete(tree[1]);
        save();
        return reply({ removed: true });
      }
      return reply({
        worktree: worktrees.get(tree[1]),
        sessions: [...sessions.values()]
          .map((entry) => entry.session)
          .filter((session) => session.worktreeId === tree[1]),
      });
    }
    return reply({ unsupported: route }, 500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const output = path.join(directory, "record.json");
  writeFileSync(path.join(directory, "first-token"), "first");
  writeFileSync(path.join(directory, "second-token"), "second");
  child = spawn(
    process.execPath,
    [
      cli,
      "run",
      "--only",
      "person-checks",
      "--layout",
      "person",
      "--url",
      url,
      "--token-file",
      path.join(directory, "first-token"),
      "--second-token-file",
      path.join(directory, "second-token"),
      "--out",
      output,
      ...(fault === "hostUnavailable" ? ["--no-host"] : []),
    ],
    {
      env: {
        HOME: path.join(directory, "home"),
        PATH: `${directory}/bin:/usr/bin:/bin`,
        PERSON_STATE: stateFile,
        PERSON_DOCKER: dockerFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(signal, null, stderr);
  const record = JSON.parse(readFileSync(output, "utf8"));
  const docker = readFileSync(dockerFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status, stderr, record, docker, requests, sessions, worktrees };
};

const requiredObservations = [
  ...["claude", "codex", "pi", "opencode"].flatMap((harness) =>
    ["runs_as", "answers", "uid", "home", "agent_process", "agent_identity"].map(
      (name) => `person.${harness}.${name}`,
    ),
  ),
  "person.pi.chatgpt_login",
  "person.pi.pi_profile",
  "person.opencode.chatgpt_login",
  ...[
    "runs_as",
    "answers",
    "uid",
    "home",
    "agent_process",
    "agent_identity",
    "chatgpt_login",
    "pi_profile",
    "pi_profile_not_other",
  ].map((name) => `person.pi.joined.${name}`),
];

test("public person-checks run observes all four people and the other person's own pi login/profile", async (t) => {
  const result = await personRun(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.record.errors, []);
  assert.deepEqual(result.record.blocked, []);
  assert.deepEqual(
    result.record.checks.map((check) => check.check).toSorted(),
    requiredObservations.toSorted(),
  );
  for (const check of result.record.checks) {
    assert.equal(check.passed, 1, check.check);
    assert.equal(check.failed, 0, check.check);
    assert.equal(check.skipped, 0, check.check);
  }
  const creates = result.requests.filter(
    (request) => request.method === "POST" && request.route.endsWith("/sessions"),
  );
  assert.deepEqual(
    creates.map((request) => [request.actor, request.body.harness]),
    [
      ["owner", "claude"],
      ["owner", "codex"],
      ["owner", "pi"],
      ["joiner", "pi"],
      ["owner", "opencode"],
    ],
  );
  for (const request of creates) {
    assert.equal(request.body.autoLand, false);
    if (request.actor === "owner") assert.equal(request.body.harnessLayout, "person");
  }
  const launches = result.requests.filter((request) => request.route.endsWith("/launch"));
  assert.equal(launches.length, 5);
  for (const request of launches)
    assert.equal(
      request.body.prompt,
      "Run this shell command and reply with only its output, on one line: echo ST-BENCH-ID $(id -u) $HOME",
    );
  const probes = result.docker.filter((args) => args.includes("st-bench"));
  assert.equal(probes.length, 5);
  assert.deepEqual(
    probes.map((args) => [args[args.indexOf("-u") + 1], args.at(-1)]),
    [
      ["41001", "owner"],
      ["41001", "owner"],
      ["41001", "owner"],
      ["41002", "joiner"],
      ["41001", "owner"],
    ],
  );
  assert.equal(result.worktrees.size, 0);
  assert.ok([...result.sessions.values()].every((entry) => entry.session.settledAt !== null));
  assert.deepEqual(
    result.requests
      .filter((request) => request.route.endsWith("/stop"))
      .map((request) => [request.actor, request.route]),
    [
      ["owner", "/api/sessions/session-1/stop"],
      ["owner", "/api/sessions/session-2/stop"],
      ["joiner", "/api/sessions/session-4/stop"],
      ["owner", "/api/sessions/session-3/stop"],
      ["owner", "/api/sessions/session-5/stop"],
    ],
  );
  assert.deepEqual(
    result.requests
      .filter((request) => request.route === "/api/me/pi-profile")
      .map((request) => request.actor),
    ["owner", "joiner"],
  );
});

for (const [fault, failures] of [
  ["runsAs", ["person.codex.runs_as"]],
  ["agentIdentity", ["person.claude.agent_identity"]],
  ["homeMode", ["person.claude.home"]],
  ["loginOwner", ["person.opencode.chatgpt_login"]],
  ["loginUnreadable", ["person.opencode.chatgpt_login"]],
  ["profileDigest", ["person.pi.pi_profile"]],
  ["joinedProfile", ["person.pi.joined.pi_profile", "person.pi.joined.pi_profile_not_other"]],
  ["joinedIdentity", ["person.pi.joined.uid", "person.pi.joined.agent_identity"]],
]) {
  test(`public person-checks refuses ${fault} with the named observation and cleans up`, async (t) => {
    const result = await personRun(t, fault);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.record.errors, []);
    assert.deepEqual(
      result.record.checks
        .filter((check) => check.failed > 0)
        .map((check) => check.check)
        .toSorted(),
      failures.toSorted(),
    );
    assert.equal(result.worktrees.size, 0);
    assert.ok([...result.sessions.values()].every((entry) => entry.session.settledAt !== null));
  });
}

test("public person-checks records absent login and identity as unverified, not held", async (t) => {
  const result = await personRun(t, "missingLogin");
  // run reports this partial scenario; the independent compare policy decides which held
  // observations a complete gate needs. Do not turn a skip into a successful identity check.
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.record.errors, []);
  for (const name of ["answers", "agent_identity", "chatgpt_login"]) {
    const check = result.record.checks.find((entry) => entry.check === `person.opencode.${name}`);
    assert.ok(check, name);
    assert.equal(check.passed, 0, name);
    assert.equal(check.skipped, 1, name);
    assert.match(check.detail, /no ChatGPT login/);
  }
  const nobodyElse = result.record.checks.find(
    (check) => check.check === "person.opencode.chatgpt_login_nobody_else",
  );
  assert.equal(nobodyElse.passed, 1);
  assert.equal(result.worktrees.size, 0);
});

test("public person-checks refuses unavailable host and retains each skipped executor observation", async (t) => {
  const result = await personRun(t, "hostUnavailable");
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.docker, []);
  assert.equal(result.record.blocked.length, 1);
  assert.equal(result.record.blocked[0].scenario, "person-checks");
  for (const name of requiredObservations.filter(
    (entry) => !entry.endsWith(".runs_as") && !entry.endsWith(".answers"),
  )) {
    const check = result.record.checks.find((entry) => entry.check === name);
    assert.ok(check, name);
    assert.equal(check.passed, 0, name);
    assert.equal(check.skipped, 1, name);
    assert.match(check.detail, /no access to the server's host/);
  }
  assert.equal(result.worktrees.size, 0);
});
