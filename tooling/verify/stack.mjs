import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// `verify stack up | status | down`: the verify skill's Launch, Doctor and Cleanup as three verbs.
// Every step calls the skill's own scripts (.agents/skills/verify/scripts) through its guard, so
// the guard's rules hold: the run talks only to the declared outer server and its own stack.
//
// `up` is ready when the doctor passes (this run's tunnel and build, healthy now, an inner `mend`
// signed in), not when a port answers. `down` removes only what the run recorded, and waits until
// the outer session has finished saving. The run's names and ids live in .verify/stack/current.json;
// its evidence in ${XDG_STATE_HOME:-~/.local/state}/mend-verify/<worktree>, as the skill keeps it.

const SKILL = ".agents/skills/verify";
const READY = /^verify stack · health answers/m;
const FAILED = /^verify stack: .*/m;

/** Runs a command, appending its output to `log`; resolves { code, stdout }. Injectable. */
export const run = (command, args, { cwd, env, log, input, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (log) appendFileSync(log, chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (log) appendFileSync(log, chunk);
    });
    child.stdin.end(input ?? "");
    child.once("error", (error) => {
      if (log) appendFileSync(log, `\n${String(error)}\n`);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout });
    });
  });

const statePath = (root) => join(root, ".verify/stack/current.json");

export const readRun = (root) =>
  existsSync(statePath(root)) ? JSON.parse(readFileSync(statePath(root), "utf8")) : null;

const saveRun = (root, state) => {
  mkdirSync(join(root, ".verify/stack"), { recursive: true });
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    join(root, ".verify/stack", `${state.run}.json`),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

export const portFree = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => server.close(() => resolve(true)));
  });

/** What a run needs before it starts, as the skill's What you need and Launch set it out. */
export const prerequisites = (env) => {
  const missing = [];
  if (!env.MEND_VERIFY_OUTER_URL) missing.push("MEND_VERIFY_OUTER_URL names no outer server");
  const xdg = env.XDG_CONFIG_HOME;
  if (!xdg || !existsSync(join(xdg, "mend/cli.json")))
    missing.push("XDG_CONFIG_HOME holds no mend/cli.json signed in to the outer server");
  return missing;
};

const OUTER_HINT = [
  ".agents/skills/verify/scripts/local-outer.sh up   # or an outer server whose operator agreed",
  "export MEND_VERIFY_MACHINE_XDG=${XDG_CONFIG_HOME:-}",
  "export XDG_CONFIG_HOME=~/.cache/mend-verify/outer-cli MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105",
];

/** The environment every step runs in: the guard first on PATH, the run's private registry. */
export const runEnv = (root, env, state) => ({
  ...env,
  PATH: `${join(root, SKILL, "scripts/guard")}:${env.PATH}`,
  MEND_VERIFY_PRIVATE: state.private,
  MEND_VERIFY_MACHINE_XDG: env.MEND_VERIFY_MACHINE_XDG ?? "",
});

const loopback = (url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

/** The skill's run name: UTC month, day, hour and minute, then four random hex digits. */
export const runName = (date) => {
  const two = (value) => String(value).padStart(2, "0");
  return `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}-${randomBytes(2).toString("hex")}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch steps 1 to 7, then the doctor. Stops at the first step that does not pass and leaves what
 * it made for `down`, which the result's `next` names.
 */
export const stackUp = async (
  root,
  {
    env = process.env,
    port = 3345,
    project = "mend",
    sources = [],
    expect = {},
    exec = run,
    wait = sleep,
    readyTimeoutMs = 900_000,
    now = Date.now,
  },
) => {
  const steps = [];
  const missing = prerequisites(env);
  if (missing.length > 0) {
    return {
      steps: [
        {
          id: "outer",
          title: "An outer server to run the stack in",
          status: "blocked_by_prerequisite",
          detail: missing.join("; "),
        },
      ],
      next: OUTER_HINT,
    };
  }
  const current = readRun(root);
  if (current && current.phase !== "down") {
    return {
      steps: [
        {
          id: "run",
          title: "One stack per verifier",
          status: "blocked_by_prerequisite",
          detail: `run ${current.run} (${current.worktree}) is still up`,
        },
      ],
      next: ["pnpm verify stack down"],
    };
  }
  if (!(await portFree(port))) {
    return {
      steps: [
        {
          id: "port",
          title: `Port ${port} free here`,
          status: "blocked_by_prerequisite",
          detail: "something already listens on it; the tunnel must own it",
        },
      ],
      next: [`pnpm verify stack up --port <another free port>`],
    };
  }
  const run = runName(new Date(now()));
  const worktree = `st-verify-${run}`;
  const evidence = join(
    env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "mend-verify",
    worktree,
  );
  mkdirSync(join(evidence, "launch"), { recursive: true });
  const state = {
    run,
    worktree,
    port,
    project,
    web: `http://localhost:${port}`,
    evidence,
    private: mkdtempSync(join(tmpdir(), "mend-verify-private-")),
    outer: env.MEND_VERIFY_OUTER_URL,
    sessionId: null,
    phase: "launching",
  };
  saveRun(root, state);
  const stepEnv = runEnv(root, env, state);
  const skill = join(root, SKILL);
  const launch = (name) => join(evidence, "launch", name);
  const step = async (id, title, command, args, options = {}) => {
    const result = await exec(command, args, {
      cwd: root,
      env: stepEnv,
      log: launch(`${id}.log`),
      ...options,
    });
    return {
      id,
      title,
      command: [command, ...args].join(" "),
      code: result.code,
      stdout: result.stdout,
      log: launch(`${id}.log`),
    };
  };
  const done = (extra = {}) => {
    saveRun(root, state);
    const failed = steps.some((s) => s.status !== "passed");
    return {
      steps,
      next: failed ? ["pnpm verify stack down"] : [],
      stack: { run, worktree, web: state.web, sessionId: state.sessionId, evidence },
      cleanup: {
        status: "left",
        left: [
          `outer worktree ${worktree}`,
          ...(state.sessionId ? [`outer session ${state.sessionId}`] : []),
        ],
      },
      ...extra,
    };
  };
  const passFail = (result, ok, detail) => {
    const { code: _code, stdout: _stdout, ...rest } = result;
    steps.push({
      ...rest,
      log: rest.log,
      status: ok ? "passed" : "failed",
      ...(detail ? { detail } : {}),
    });
    return ok;
  };

  // 1. A slot among the machine's verify stacks.
  const slot = await step("slot", "Take a stack slot", "node", [
    join(skill, "scripts/slots.mjs"),
    "--max",
    "4",
    "--max-building",
    "2",
    "--wait",
    "900",
    "--out",
    join(evidence, "launch"),
  ]);
  if (slot.code === 1) {
    steps.push({
      id: "slot",
      title: slot.title,
      status: "blocked_by_prerequisite",
      detail: "no slot after 15 minutes; slots.txt names the stacks holding them",
      log: slot.log,
    });
    return done();
  }
  if (!passFail(slot, slot.code === 0)) return done();

  // 2. The outer session that holds the stack's workspace.
  const session = await step("session", "Start the outer session", "mend", [
    "run",
    "--project",
    project,
    "--name",
    worktree,
    "--detach",
    "--json",
    "--",
    "sleep",
    "86400",
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(session.stdout);
  } catch {
    // Reported below.
  }
  const started = parsed?.data ?? parsed;
  state.sessionId = started?.sessionId ?? null;
  if (
    !passFail(
      session,
      session.code === 0 && started?.status === "running",
      state.sessionId ? `session ${state.sessionId}` : "no session started",
    )
  )
    return done();
  if (loopback(state.outer)) {
    const seed = await step(
      "seed",
      "Seed the session's Docker from this machine",
      join(skill, "scripts/local-outer.sh"),
      ["seed"],
    );
    if (!passFail(seed, seed.code === 0)) return done();
  }

  // 3. The stack, as a Service of that session named for this run.
  const serve = [
    "node",
    "scripts/verify-stack/stack.mjs",
    "serve",
    "--port",
    String(port),
    ...sources,
  ];
  const service = await step("service", "Start the stack's Service", "mend", [
    "service",
    "run",
    state.sessionId,
    "--port",
    String(port),
    "--http",
    "--name",
    worktree,
    "--wait",
    "--no-connect",
    "--",
    ...serve,
  ]);
  if (service.code !== 0) {
    const listed = await exec("mend", ["service", "list"], { cwd: root, env: stepEnv });
    const known = listed.stdout.split("\n").some((line) => line.startsWith(`${worktree} `));
    if (
      !passFail(
        service,
        known,
        known
          ? `--wait exited ${service.code}; the Service is listed and keeps building`
          : "the Service did not start; its log says why",
      )
    )
      return done();
  } else passFail(service, true);

  // 4. Keep the slot, now that this stack is listed.
  const admitted = await step("admitted", "Keep the slot", "node", [
    join(skill, "scripts/slots.mjs"),
    "--max",
    "4",
    "--max-building",
    "2",
    "--mine",
    worktree,
    "--out",
    join(evidence, "launch/admitted"),
  ]);
  if (admitted.code === 1) {
    steps.push({
      id: "admitted",
      title: admitted.title,
      status: "blocked_by_prerequisite",
      detail: "over the limit: take the stack down and try again later",
      log: admitted.log,
    });
    return done();
  }
  if (!passFail(admitted, admitted.code === 0)) return done();

  // 5. Ready when the stack says its check completed, or failed.
  const deadline = now() + readyTimeoutMs;
  let text = "";
  for (;;) {
    const logs = await exec("timeout", ["8", "mend", "service", "logs", worktree], {
      cwd: root,
      env: stepEnv,
    });
    text = logs.stdout.replaceAll("\r", "");
    writeFileSync(launch("stack.log"), text);
    if (READY.test(text) || FAILED.test(text) || now() >= deadline) break;
    await wait(2000);
  }
  const ready = READY.test(text);
  steps.push({
    id: "ready",
    title: "The stack says it is ready",
    status: ready ? "passed" : "failed",
    log: launch("stack.log"),
    detail: ready
      ? "verify stack · health answers"
      : (FAILED.exec(text)?.[0] ?? `not ready after ${Math.round(readyTimeoutMs / 60000)} minutes`),
  });
  if (!ready) return done();

  // 6. The web, here, through a tunnel this run started.
  const tunnel = await step("tunnel", "Bring the web here", "node", [
    join(skill, "scripts/tunnel.mjs"),
    "start",
    "--service",
    worktree,
    "--port",
    String(port),
    "--dir",
    state.private,
    "--log",
    launch("connect.log"),
  ]);
  if (!passFail(tunnel, tunnel.code === 0, state.web)) return done();

  // 7. The stack's first account, sealed to a key only this machine holds.
  const key = await exec(
    "node",
    [join(skill, "scripts/handover.mjs"), "keygen", "--dir", state.private],
    { cwd: root, env: stepEnv },
  );
  const sealed = await exec(
    "mend",
    [
      "run",
      "--project",
      project,
      "--worktree",
      worktree,
      "--",
      "node",
      `${SKILL}/scripts/handover.mjs`,
      "seal",
      "--to",
      key.stdout.trim(),
    ],
    { cwd: root, env: stepEnv },
  );
  const opened = await step(
    "account",
    "Take over the stack's account",
    "node",
    [join(skill, "scripts/handover.mjs"), "open", "--dir", state.private],
    { input: sealed.stdout },
  );
  if (
    !passFail(
      opened,
      key.code === 0 && sealed.code === 0 && opened.code === 0,
      `${state.private}/account.json`,
    )
  )
    return done();

  // The doctor: ready means usable.
  const doctor = await stackDoctor(root, {
    env,
    state,
    expect,
    exec,
    out: join(evidence, "doctor"),
  });
  steps.push(doctor);
  state.phase = doctor.status === "passed" ? "ready" : "unhealthy";
  return done({ evidence: [{ kind: "doctor", path: join(evidence, "doctor/doctor.txt") }] });
};

const stackDoctor = async (root, { env, state, expect = {}, exec, out }) => {
  const args = [
    join(root, SKILL, "scripts/doctor.mjs"),
    "--worktree",
    state.worktree,
    "--web",
    state.web,
    "--out",
    out,
    "--tunnel",
    join(state.private, "tunnel.json"),
  ];
  for (const [name, sha] of Object.entries(expect)) if (sha) args.push(`--expect-${name}`, sha);
  mkdirSync(out, { recursive: true });
  const result = await exec("node", args, {
    cwd: root,
    env: runEnv(root, env, state),
    log: join(out, "doctor.log"),
  });
  const not = result.stdout.split("\n").filter((line) => /\bNOT\b/.test(line));
  return {
    id: "doctor",
    title: "Doctor: this run's tunnel and build, healthy, an inner mend signed in",
    command: `node ${SKILL}/scripts/doctor.mjs …`,
    status: result.code === 0 ? "passed" : "failed",
    log: join(out, "doctor.log"),
    detail: result.code === 0 ? "every line holds" : not.join("; ") || `exit ${result.code}`,
  };
};

export const stackStatus = async (root, { env = process.env, exec = run, expect = {} } = {}) => {
  const state = readRun(root);
  if (state === null || state.phase === "down") {
    return {
      steps: [
        {
          id: "run",
          title: "A stack this verifier started",
          status: "blocked_by_prerequisite",
          detail: "no stack is up",
        },
      ],
      next: ["pnpm verify stack up"],
    };
  }
  const doctor = await stackDoctor(root, {
    env,
    state,
    expect,
    exec,
    out: join(state.evidence, `doctor-${Date.now()}`),
  });
  return {
    steps: [doctor],
    next: doctor.status === "passed" ? [] : ["pnpm verify stack down", "pnpm verify stack up"],
    stack: {
      run: state.run,
      worktree: state.worktree,
      web: state.web,
      sessionId: state.sessionId,
      evidence: state.evidence,
    },
  };
};

/**
 * Cleanup: the tunnel, sibling sessions, the Service and its teardown, the outer session, then the
 * wait until it has saved, and the evidence scan before the private registry goes.
 */
export const stackDown = async (
  root,
  { env = process.env, exec = run, settleAfter = 300 } = {},
) => {
  const state = readRun(root);
  if (state === null || state.phase === "down") {
    return {
      steps: [
        {
          id: "run",
          title: "A stack this verifier started",
          status: "passed",
          detail: "nothing is up",
        },
      ],
      next: [],
    };
  }
  const stepEnv = runEnv(root, env, state);
  const skill = join(root, SKILL);
  const out = join(state.evidence, "cleanup");
  mkdirSync(out, { recursive: true });
  const steps = [];
  const left = [];
  const step = async (id, title, command, args, ok = (code) => code === 0) => {
    const result = await exec(command, args, {
      cwd: root,
      env: stepEnv,
      log: join(out, `${id}.log`),
    });
    const passed = ok(result.code);
    steps.push({
      id,
      title,
      command: [command, ...args].join(" "),
      status: passed ? "passed" : "failed",
      log: join(out, `${id}.log`),
      ...(passed ? {} : { detail: `exit ${result.code}` }),
    });
    return result;
  };

  await step("tunnel", "Stop this run's tunnel", "node", [
    join(skill, "scripts/tunnel.mjs"),
    "stop",
    "--dir",
    state.private,
  ]);
  if (state.sessionId) {
    const sessions = await exec("mend", ["sessions", "--json"], { cwd: root, env: stepEnv });
    let siblings = [];
    try {
      // Off a terminal the CLI may answer in its command contract, `{ v, status, data }`.
      const parsed = JSON.parse(sessions.stdout);
      siblings = (parsed.sessions ?? parsed.data.sessions)
        .filter((s) => s.worktree === state.worktree && s.id !== state.sessionId)
        .map((s) => s.id);
    } catch {
      steps.push({
        id: "siblings",
        title: "Stop the worktree's other sessions",
        status: "failed",
        detail: "mend sessions --json could not be read",
      });
    }
    for (const id of siblings)
      await step(`sibling-${id}`, `Stop sibling session ${id}`, "mend", ["stop", id]);
    await step("services", "Stop the stack's Service", "mend", [
      "stop",
      "--services",
      state.sessionId,
    ]);
    await step("teardown", "Wait for the stack's teardown", join(skill, "scripts/capture.sh"), [
      out,
      "teardown",
      "--",
      "mend",
      "run",
      "--project",
      state.project,
      "--worktree",
      state.worktree,
      "--",
      "sh",
      "-c",
      'for i in $(seq 180); do [ -z "$(docker ps -aq --filter name=^verify-stack-owner$)" ] && ! test -e ~/.cache/mend-verify-stack/stack.json && exec tail -n 100 ~/.cache/mend-verify-stack/logs/watchdog.log; sleep 1; done; exec node scripts/verify-stack/stack.mjs down --force',
    ]);
    await step("session", "Stop the outer session", "mend", ["stop", state.sessionId]);
    await exec("mend", ["wait", state.sessionId, "--timeout", "120", "--json"], {
      cwd: root,
      env: stepEnv,
      log: join(out, "session-end.json"),
    });
    const settle = await step("saved", "Wait until the outer session has saved", "node", [
      join(skill, "scripts/settle.mjs"),
      "--session",
      state.sessionId,
      "--out",
      join(out, "settle"),
      "--after",
      String(settleAfter),
    ]);
    if (settle.code !== 0)
      left.push(`outer session ${state.sessionId}, still saving (cleanup/settle says how far)`);
  }
  const scan = await exec(
    "node",
    [
      join(skill, "scripts/scan-evidence.mjs"),
      "--dir",
      state.evidence,
      "--secrets",
      state.private,
      "--delete-hits",
    ],
    { cwd: root, env: stepEnv, log: join(state.evidence, "scan.log") },
  );
  steps.push({
    id: "scan",
    title: "Scan the evidence for the run's secrets",
    status: scan.code === 0 ? "passed" : "evidence_withheld",
    log: join(state.evidence, "scan.json"),
    ...(scan.code === 0
      ? {}
      : { detail: "a secret was found; those files are deleted (scan.json)" }),
  });
  rmSync(state.private, { recursive: true, force: true });
  state.phase = "down";
  saveRun(root, state);
  left.push(
    `outer worktree ${state.worktree}: it holds the record; mend worktrees rm ${state.worktree} --project ${state.project} --force when its evidence is no longer needed`,
  );
  return {
    steps,
    next: [],
    stack: {
      run: state.run,
      worktree: state.worktree,
      sessionId: state.sessionId,
      evidence: state.evidence,
    },
    evidence: [{ kind: "evidence", path: state.evidence }],
    cleanup: { status: left.length > 1 ? "failed" : "left", left },
  };
};
