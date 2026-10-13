import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("bench.mjs", import.meta.url));
const binaryFrame = (text) => {
  const bytes = Buffer.from(text);
  assert.ok(bytes.length < 126);
  return Buffer.concat([Buffer.from([0x82, bytes.length]), bytes]);
};

const actorOf = (request) => {
  assert.ok(["Bearer first", "Bearer second"].includes(request.headers.authorization));
  return request.headers.authorization === "Bearer second" ? "joiner" : "owner";
};

// Real HTTP, real ticketed WebSocket and executable observations; no harness, Git command or
// Docker daemon is invoked. Expected lifecycle/records below are independent of benchmark helpers.
const lifecycleRun = async (t, { fault = null, clockOffsetMs = 0 } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "st-bench-lifecycle-"));
  const sockets = new Set();
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
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
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
else if (args[0] === "logs") {
 const since = args.indexOf("--since"), until = args.indexOf("--until");
 const lower = since < 0 ? -Infinity : Date.parse(args[since + 1]);
 const upper = until < 0 ? Infinity : Date.parse(args[until + 1]);
 const lines = fs.readFileSync(process.env.FIXTURE_LOG, "utf8").split("\\n").filter(line => line && Date.parse(line.slice(0, 24)) >= lower && Date.parse(line.slice(0, 24)) <= upper);
 process.stdout.write(lines.join("\\n") + "\\n");
} else if (args[0] === "exec" && args.includes("printenv")) console.log("person");
else if (args[0] === "inspect" && args.at(-1).includes("revision")) console.log("abcdef1234567890");
else if (args[0] === "inspect" && args.at(-1).includes("Config.Image")) console.log("mend-fixture sha256:aabb");
else { console.error("unsupported owned Docker observation", args); process.exit(1); }
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, "bin/date"),
    `#!${process.execPath}
if (process.argv.slice(2).join(" ") !== "+%s%N") throw Error("unexpected date observation");
console.log(String(BigInt(Date.now() + Number(process.env.FIXTURE_CLOCK_OFFSET)) * 1000000n));
`,
    { mode: 0o755 },
  );
  const project = { id: "project", name: "synthetic", visibility: "shared", originUrl: null };
  const sessions = new Map();
  const processes = new Map();
  const worktrees = new Map([
    ["ordinary-tree", { id: "ordinary-tree", name: "ordinary", ownerUserId: "outsider" }],
  ]);
  const requests = [];
  const upgrades = [];
  const frames = [];
  const failures = [];
  const tickets = new Map();
  let nextSession = 0;
  let nextProcess = 0;
  let nextTicket = 0;
  const logLine = (entry, message, at, extra = "") => {
    const stamp = new Date(at).toISOString();
    const line = `${stamp} [${stamp.slice(11, 23)}] INFO: session engine: ${message} { sessionId: '${entry.session.id}', workspaceId: '${entry.session.sealantWorkspaceId}'${extra} }\n`;
    writeFileSync(logFile, readFileSync(logFile, "utf8") + line);
  };
  const launch = async (entry, resumed) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const started = Date.now() + clockOffsetMs;
    const joined = entry.session.id !== "session-1";
    logLine(
      entry,
      resumed ? "dependency tree observed for this platform" : "dependency install did not run",
      started,
    );
    if (joined) logLine(entry, "joining the lease holder", started + 1);
    logLine(entry, "agent memory · already in place", started + 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    entry.session.status = "running";
    entry.session.settledAt = null;
    entry.agent = {
      id: `process-${++nextProcess}`,
      createdAt: new Date(started + 10).toISOString(),
      firstOutputAt: new Date(Date.now() + clockOffsetMs).toISOString(),
      runsAs:
        fault === "layout" && entry.session.id === "session-1" && !resumed
          ? null
          : entry.session.ownerUserId,
    };
    processes.set(entry.agent.id, { type: "agent", entry });
  };
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
    });
    const reply = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET") {
      if (route === "/api/health") return reply({ version: "0.0.0-fixture" });
      if (route === "/api/projects") return reply([project]);
      if (route === "/api/projects/project") return reply(project);
      if (route === "/api/organization") return reply({ userId: actor });
      if (route === "/api/me/secret-files") return reply({ files: [] });
      if (route === "/api/projects/project/memory") return reply({ files: [] });
      if (route === "/api/projects/project/worktrees")
        return reply({ worktrees: [...worktrees.values()] });
      if (route === "/api/sessions")
        return fault === "api"
          ? reply({ error: "synthetic API read refusal" }, 503)
          : reply([...sessions.values()].map((entry) => entry.session));
    }
    if (route === "/api/projects/project/memory/import" && request.method === "POST")
      return reply({ saved: true });
    if (route === "/api/projects/project/memory/file" && request.method === "DELETE")
      return reply({ removed: false });
    if (route === "/api/projects/project/sessions" && request.method === "POST") {
      let worktree = [...worktrees.values()].find((tree) => tree.name === body.name);
      if (worktree === undefined) {
        worktree = { id: "benchmark-tree", name: body.name, layout: body.harnessLayout };
        worktrees.set(worktree.id, worktree);
      }
      const session = {
        id: `session-${++nextSession}`,
        harness: body.harness,
        ownerUserId: actor,
        projectId: project.id,
        worktree: body.name,
        worktreeId: worktree.id,
        sealantWorkspaceId: "workspace",
        status: "starting",
        settledAt: null,
        summary: null,
      };
      sessions.set(session.id, { session, agent: null });
      return reply(session);
    }
    const sessionRoute = /^\/api\/sessions\/([^/]+)(.*)$/.exec(route);
    if (sessionRoute !== null) {
      const [, id, suffix] = sessionRoute;
      const entry = sessions.get(id);
      assert.ok(entry, `known session ${id}`);
      if (suffix === "" && request.method === "GET")
        return reply({ session: entry.session, currentAgent: entry.agent });
      if (suffix === "/launch" && request.method === "POST") {
        assert.equal(actor, entry.session.ownerUserId);
        await launch(entry, false);
        return reply(entry.session);
      }
      if (suffix === "/resume" && request.method === "POST") {
        assert.equal(actor, entry.session.ownerUserId);
        if (fault === "resume") return reply({ error: "synthetic resume refusal" }, 409);
        assert.notEqual(entry.session.settledAt, null);
        await launch(entry, true);
        return reply(entry.session);
      }
      if (suffix === "/stop" && request.method === "POST") {
        assert.equal(actor, entry.session.ownerUserId);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const started = Date.now() + clockOffsetMs;
        logLine(entry, "capture drain · saved · terminating", started);
        logLine(entry, "capture flush · final · completed", started, ", uploadedBytes: 77");
        entry.session.status = "completed";
        entry.session.settledAt = new Date(started).toISOString();
        return reply(entry.session);
      }
      if (suffix === "/shell" && request.method === "POST") {
        assert.equal(actor, entry.session.ownerUserId);
        const process = { id: `process-${++nextProcess}`, type: "shell", entry };
        processes.set(process.id, process);
        return reply({ id: process.id });
      }
      if (suffix === "/checkpoints" && request.method === "POST")
        return reply({ id: "checkpoint-1" });
    }
    const processRoute = /^\/api\/processes\/([^/]+)(.*)$/.exec(route);
    if (processRoute !== null) {
      const [, id, suffix] = processRoute;
      const process = processes.get(id);
      assert.ok(process, `known process ${id}`);
      if (suffix === "/logs" && request.method === "GET")
        return reply({
          chunks: [
            {
              dataBase64: Buffer.from(
                fault === "limit"
                  ? "Claude Code v1.2.3\nUsage limit reached\n"
                  : "Claude Code v1.2.3\n5048\n",
              ).toString("base64"),
            },
          ],
          nextFrom: "1",
          status: "running",
        });
      if (suffix === "/stop" && request.method === "POST") {
        process.stopped = true;
        return reply({ status: "exited" });
      }
    }
    if (route === "/api/upgrade-tickets" && request.method === "POST") {
      const process = processes.get(body.process);
      assert.ok(process);
      assert.equal(process.entry.session.ownerUserId, actor);
      const ticket = `synthetic-ticket-${++nextTicket}`;
      tickets.set(ticket, { process: body.process, actor });
      return reply({ ticket });
    }
    const treeRoute = /^\/api\/worktrees\/([^/]+)$/.exec(route);
    if (treeRoute !== null) {
      assert.equal(treeRoute[1], "benchmark-tree");
      if (request.method === "GET")
        return reply({
          worktree: worktrees.get(treeRoute[1]),
          sessions: [...sessions.values()].map((entry) => entry.session),
        });
      if (request.method === "DELETE") {
        worktrees.delete(treeRoute[1]);
        return reply({ removed: true });
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
  server.on("upgrade", (request, socket, initial) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const url = new URL(request.url, "http://fixture");
    const ticket = tickets.get(url.searchParams.get("ticket"));
    assert.ok(ticket);
    assert.equal(url.pathname, "/api/tty");
    assert.equal(url.searchParams.get("process"), ticket.process);
    assert.equal(url.searchParams.get("from"), "0");
    tickets.delete(url.searchParams.get("ticket"));
    upgrades.push({ process: ticket.process, actor: ticket.actor });
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    if (fault === "ticket") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(binaryFrame("synthetic prompt$ "));
    let buffered = initial;
    const receive = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 15;
        assert.equal(
          buffered[0] & 128,
          128,
          "fixture requires a complete unfragmented client frame",
        );
        assert.equal(buffered[1] & 128, 128, "client frames are masked");
        let length = buffered[1] & 127;
        let header = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          header = 4;
        }
        assert.notEqual(length, 127, "fixture messages are bounded below64KiB");
        if (buffered.length < header + 4 + length) return;
        const mask = buffered.subarray(header, header + 4);
        const payload = Buffer.from(buffered.subarray(header + 4, header + 4 + length));
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        buffered = buffered.subarray(header + 4 + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        const text = payload.toString("utf8");
        frames.push({ process: ticket.process, opcode, text });
        if (opcode === 1) {
          assert.equal(JSON.parse(text).t, "resize");
          continue;
        }
        assert.equal(opcode, 2);
        if (text === "x") {
          socket.write(binaryFrame("x"));
          continue;
        }
        if (text === "\u0015") continue;
        const marker = /DONE([a-z0-9]+) \$\?/.exec(text);
        assert.ok(marker, "real runCommand completion tag");
        if (text.startsWith("for h in")) socket.write(binaryFrame("ver:claude=1.2.3\n"));
        socket.write(binaryFrame(`ST-BENCH-DONE${marker[1]}-0\n`));
      }
    };
    socket.on("data", receive);
    if (initial.length > 0) receive(Buffer.alloc(0));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const output = path.join(directory, "record.json");
  writeFileSync(path.join(directory, "first-token"), "first");
  writeFileSync(path.join(directory, "second-token"), "second");
  child = spawn(
    process.execPath,
    [
      cli,
      "run",
      "--url",
      `http://127.0.0.1:${server.address().port}`,
      "--token-file",
      path.join(directory, "first-token"),
      "--second-token-file",
      path.join(directory, "second-token"),
      "--project",
      "synthetic",
      "--out",
      output,
      "--layout",
      "person",
      "--harnesses",
      "claude",
      "--runs",
      "1",
      "--only",
      "new,join-same,join-other,resume,interactive,api",
      "--joins-per-run",
      "1",
      "--resumes-per-run",
      "1",
      "--interactive-runs",
      "1",
      "--typing-runs",
      "1",
      "--api-runs",
      "1",
    ],
    {
      env: {
        HOME: path.join(directory, "home"),
        TMPDIR: directory,
        ST_BENCH_STATE_DIR: path.join(directory, "state"),
        PATH: `${directory}/bin:/usr/bin:/bin`,
        FIXTURE_LOG: logFile,
        FIXTURE_DOCKER: dockerFile,
        FIXTURE_CLOCK_OFFSET: String(clockOffsetMs),
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
  }, 30_000);
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(signal, null, stderr);
  assert.deepEqual(failures, []);
  const record = JSON.parse(readFileSync(output, "utf8"));
  return {
    status,
    stderr,
    record,
    requests,
    upgrades,
    frames,
    sessions,
    processes,
    worktrees,
    tickets,
    docker: readFileSync(dockerFile, "utf8"),
  };
};

const series = (record, name, unit, budget = null) => {
  const measure = record.measures[name];
  assert.ok(measure, `recorded ${name}`);
  assert.equal(measure.unit, unit, name);
  assert.equal(measure.budget, budget, name);
  assert.equal(measure.layout, "person", name);
  assert.equal(measure.harness, "claude", name);
  assert.equal(measure.harnessVersion, "1.2.3", name);
  assert.equal(measure.samples.length, 1, name);
  assert.ok(Number.isFinite(measure.samples[0]) && measure.samples[0] >= 0, name);
  return measure.samples[0];
};

const assertOrdinaryPreserved = (result) => {
  assert.deepEqual(
    [...result.worktrees.values()],
    [{ id: "ordinary-tree", name: "ordinary", ownerUserId: "outsider" }],
  );
  assert.ok(
    result.requests.some(
      ({ method, route }) => method === "DELETE" && route === "/api/worktrees/benchmark-tree",
    ),
  );
  assert.ok(result.requests.every(({ route }) => !route.includes("ordinary-tree")));
  assert.equal(result.tickets.size, 0);
};

const assertLifecycle = (result) => {
  const { record } = result;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.blocked, []);
  assert.deepEqual(record.checks, [
    {
      check: "new.claude.layout",
      passed: 1,
      failed: 0,
      skipped: 0,
      detail: "asked person, the agent runs as the person",
      failures: [],
    },
    {
      check: "join.other.runs_as",
      passed: 1,
      failed: 0,
      skipped: 0,
      detail: "the joiner's agent runs as the person",
      failures: [],
    },
  ]);
  // These are the specified independent scenario names and budget classes, not requiredOf().
  for (const [name, budget] of [
    ["new.claude.first_output", null],
    ["new.claude.create_call", null],
    ["new.claude.launch_call", null],
    ["new.claude.first_turn", null],
    ["new.claude.output_to_answer", null],
    ["new.claude.agent_to_output", null],
    ["new.claude.first_output_excl_install", "start"],
    ["new.claude.first_turn_excl_install", "start"],
    ["stop.claude.call", null],
    ["stop.claude.save", "start"],
    ["stop.claude.settled", "start"],
    ["resume.call", null],
    ["resume.first_output", null],
    ["resume.tree_restored.first_output", "start"],
    ["resume.tree_restored.agent_to_output", null],
    ["join.same.first_output", "start"],
    ["join.same.stop_settled", null],
    ["join.other.first_output", "join-other"],
    ["shell.open", "interactive"],
    ["shell.open_call", null],
    ["terminal.attach", "interactive"],
    ["terminal.echo", "interactive"],
    ["checkpoint.save", "start"],
    ["api.session_list", "api"],
    ["api.session_view", "api"],
    ["stop.after_resume.call", null],
    ["stop.after_resume.save", null],
    ["stop.after_resume.settled", null],
  ])
    series(record, name, "ms", budget);
  for (const name of [
    "new.claude.launch_call_capped",
    "new.claude.execs",
    "join.same.execs",
    "join.other.execs",
    "shell.open_credential_writes",
  ])
    assert.equal(series(record, name, "count"), 0);
  for (const name of [
    "stop.claude.final_flush_uploaded_bytes",
    "stop.after_resume.final_flush_uploaded_bytes",
  ])
    assert.equal(series(record, name, "bytes"), 77);
  for (const name of [
    "new.claude.step.agent memory · already in place",
    "resume.tree_restored.step.agent memory · already in place",
  ])
    assert.equal(series(record, name, "ms"), 2);
  for (const prefix of ["join.same", "join.other"]) {
    assert.equal(series(record, `${prefix}.step.joining the lease holder`, "ms"), 1);
    assert.equal(series(record, `${prefix}.step.agent memory · already in place`, "ms"), 1);
  }
  // No-install is zero: derived comparable samples must retain the measured first-output value.
  assert.deepEqual(
    record.measures["new.claude.first_output_excl_install"].samples,
    record.measures["new.claude.first_output"].samples,
  );
  assert.deepEqual(
    record.measures["new.claude.first_turn_excl_install"].samples,
    record.measures["new.claude.first_turn"].samples,
  );
  assert.equal(record.measures["new.claude.launch_call"].cappedAtMs, 30_000);
  assert.ok(
    Object.keys(record.measures).every(
      (name) =>
        !name.startsWith("executor.") &&
        !name.includes(".cold.") &&
        !name.startsWith("resume.unclassified"),
    ),
  );
  assert.equal(record.measures["git.fetch"], undefined);
  assert.equal(record.measures["git.push"], undefined);
  // A gross clock-mixing regression makes these near-60-second or negative despite an 85ms launch.
  for (const name of [
    "new.claude.first_output",
    "resume.tree_restored.first_output",
    "join.same.first_output",
    "join.other.first_output",
    "stop.claude.save",
  ])
    assert.ok(record.measures[name].samples[0] < 5000, name);
  assert.equal(record.target.version, "0.0.0-fixture");
  assert.equal(record.target.flag, "person");

  const posts = result.requests.filter(
    ({ method, route }) => method === "POST" && route === "/api/projects/project/sessions",
  );
  assert.equal(posts.length, 3);
  const name = `st-bench-${record.rid}-claude-1`;
  assert.deepEqual(
    posts.map(({ actor, body }) => ({ actor, body })),
    [
      {
        actor: "owner",
        body: {
          harness: "claude",
          label: name,
          name,
          base: null,
          autoLand: false,
          harnessLayout: "person",
        },
      },
      {
        actor: "owner",
        body: { harness: "claude", label: `${name}-join`, name, base: null, autoLand: false },
      },
      {
        actor: "joiner",
        body: { harness: "claude", label: `${name}-other`, name, base: null, autoLand: false },
      },
    ],
  );
  assert.deepEqual(
    result.requests
      .filter(
        ({ method, route }) =>
          method === "POST" && /^\/api\/sessions\/session-\d\/(launch|resume|stop)$/.test(route),
      )
      .map(({ route, actor }) => ({ route, actor })),
    [
      { route: "/api/sessions/session-1/launch", actor: "owner" },
      { route: "/api/sessions/session-1/stop", actor: "owner" },
      { route: "/api/sessions/session-1/resume", actor: "owner" },
      { route: "/api/sessions/session-2/launch", actor: "owner" },
      { route: "/api/sessions/session-2/stop", actor: "owner" },
      { route: "/api/sessions/session-3/launch", actor: "joiner" },
      { route: "/api/sessions/session-3/stop", actor: "joiner" },
      { route: "/api/sessions/session-1/stop", actor: "owner" },
    ],
  );
  const launch = result.requests.find(({ route }) => route === "/api/sessions/session-1/launch");
  assert.deepEqual(launch.body, {
    prompt: "What is 2037 + 3011? Reply with only the number. Do not use any tools.",
  });
  assert.deepEqual(
    result.requests.find(({ route }) => route === "/api/sessions/session-1/resume").body,
    { harness: null },
  );
  assert.equal(result.sessions.get("session-1").agent.id, "process-2");
  assert.deepEqual(
    [...result.sessions.values()].map(({ session }) => [
      session.id,
      session.ownerUserId,
      session.status,
    ]),
    [
      ["session-1", "owner", "completed"],
      ["session-2", "owner", "completed"],
      ["session-3", "joiner", "completed"],
    ],
  );
  assert.deepEqual(result.upgrades, [
    { process: "process-5", actor: "owner" },
    { process: "process-2", actor: "owner" },
  ]);
  assert.equal(result.processes.get("process-5").stopped, true);
  const binary = result.frames.filter(({ opcode }) => opcode === 2);
  assert.deepEqual(
    binary
      .filter(({ text }) => text === "x" || text === "\u0015")
      .map(({ process, text }) => ({ process, text })),
    [
      { process: "process-5", text: "x" },
      { process: "process-5", text: "\u0015" },
    ],
  );
  assert.equal(binary.filter(({ text }) => text.startsWith("for h in")).length, 1);
  assert.equal(
    binary.filter(({ text }) => text.startsWith("echo 1 > .st-bench-checkpoint-1;")).length,
    1,
  );
  assert.equal(
    binary.filter(({ text }) => text.startsWith("rm -f .st-bench-checkpoint-*;")).length,
    1,
  );
  assert.equal(result.frames.filter(({ opcode }) => opcode === 1).length, 2);
  assert.ok(result.frames.every(({ process }) => ["process-5", "process-2"].includes(process)));
  const checkpoint = result.requests.find(
    ({ route }) => route === "/api/sessions/session-1/checkpoints",
  );
  assert.equal(checkpoint.actor, "owner");
  assert.deepEqual(checkpoint.body, { trigger: "user-mark" });
  const imported = result.requests.find(
    ({ route }) => route === "/api/projects/project/memory/import",
  );
  assert.equal(imported.actor, "joiner");
  assert.deepEqual(imported.body.files, [
    {
      path: `.claude/projects/-workspace-repo/memory/st-bench-${record.rid}.md`,
      encoding: "utf8",
      contents: `# st-bench\n\nA memory file of benchmark run ${record.rid}, so a join by this person delivers memory.\n`,
    },
  ]);
  assert.equal(
    result.requests.filter(
      ({ method, route }) => method === "DELETE" && route === "/api/projects/project/memory/file",
    ).length,
    1,
  );
  assertOrdinaryPreserved(result);
};

for (const clockOffsetMs of [0, 60_000]) {
  test(`public benchmark run records exact lifecycle and wire evidence with server clock offset ${clockOffsetMs}ms`, async (t) => {
    assertLifecycle(await lifecycleRun(t, { clockOffsetMs }));
  });
}

for (const fault of ["resume", "layout", "ticket", "api"]) {
  test(`public benchmark run records ${fault} refusal and preserves ordinary worktree`, async (t) => {
    const result = await lifecycleRun(t, { fault });
    assert.equal(result.status, 1, result.stderr);
    assertOrdinaryPreserved(result);
    if (fault === "layout") {
      assert.equal(
        result.record.checks.find(({ check }) => check === "new.claude.layout").failed,
        1,
      );
      assert.deepEqual(result.record.errors, []);
    } else if (fault === "resume") {
      assert.deepEqual(
        result.record.errors.map(({ scenario }) => scenario),
        ["claude #1"],
      );
      assert.equal(result.record.measures["resume.first_output"], undefined);
      assert.equal(result.sessions.get("session-1").agent.id, "process-1");
      assert.deepEqual(result.upgrades, []);
    } else if (fault === "api") {
      assert.deepEqual(
        result.record.errors.map(({ scenario }) => scenario),
        ["api"],
      );
      assert.equal(result.record.measures["api.session_list"], undefined);
      assert.equal(result.record.measures["api.session_view"], undefined);
      series(result.record, "checkpoint.save", "ms", "start");
    } else {
      assert.deepEqual(
        result.record.errors.map(({ scenario }) => scenario),
        ["interactive"],
      );
      assert.equal(result.record.measures["shell.open"], undefined);
      assert.equal(result.record.measures["terminal.echo"], undefined);
      series(result.record, "api.session_list", "ms", "api");
      assert.deepEqual(result.upgrades, [{ process: "process-5", actor: "owner" }]);
    }
  });
}

test("public benchmark run keeps an account usage refusal separate from successful timing samples", async (t) => {
  const result = await lifecycleRun(t, { fault: "limit" });
  // run reports observations; compare enforces complete timing coverage separately.
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.record.errors, []);
  for (const name of [
    "new.claude.first_turn",
    "new.claude.first_turn_excl_install",
    "new.claude.output_to_answer",
  ]) {
    assert.equal(result.record.measures[name], undefined);
    assert.ok(
      result.record.notRun.some(
        ({ measure, reason }) =>
          measure === name &&
          reason === 'the harness\'s account hit its usage limit ("Usage limit reached")',
      ),
    );
  }
  series(result.record, "new.claude.first_output_excl_install", "ms", "start");
  series(result.record, "resume.tree_restored.first_output", "ms", "start");
  assertOrdinaryPreserved(result);
});
