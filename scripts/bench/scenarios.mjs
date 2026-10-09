// The scenarios of docs/adr/0016's "What is measured", driven against a live instance. Each
// records samples into the result; a scenario that cannot run records why, and the rest go on.
// Everything created is named `st-bench-…` and removed, whatever happened.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ApiError,
  attachTerminal,
  executorOf,
  executorResources,
  imageOfExecutor,
  mendLogBetween,
} from "./host.mjs";
import {
  agentIdentityOf,
  asPersonCommand,
  chatGptLoginSkipOf,
  builtWithin,
  classifySavedFiles,
  deliveryWindow,
  execCount,
  harnessVersionOf,
  liveAgents,
  firstExecAt,
  milestonesOf,
  parseContainerDisk,
  parseDockerTime,
  parseDrainLine,
  parseImageLine,
  parseMemUsage,
  parseMendLog,
  parseSealantdLog,
  parsePersonProbe,
  PERSON_PROBE_SH,
  PERSON_SCENARIOS,
  personVerdicts,
  restoreOf,
  SAVED_SIZES_SH,
  sshRemoteOf,
  stagedBytesOf,
  stepsOf,
  stripAnsi,
  tallyCheck,
  turnEnded,
  turnTimes,
  turnVerdicts,
  usageLimitOf,
} from "./lib.mjs";

export const HARNESSES = ["claude", "codex", "pi", "opencode"];
export const PREFIX = "st-bench-";
const SECRET_PATH = ".st-bench-secret";

const runLocal = (command) =>
  promisify(execFile)("sh", ["-c", command], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error));

// ─── the recorder ───────────────────────────────────────────────────────────

export const makeRecorder = (result, log) => ({
  sample: (name, value, unit, budget = null) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const measure = (result.measures[name] ??= { unit, budget, samples: [] });
    measure.samples.push(Math.round(value * 10) / 10);
  },
  note: (text) => {
    result.notes.push(text);
    log(`note · ${text}`);
  },
  notRun: (measure, reason) => {
    if (!result.notRun.some((entry) => entry.measure === measure)) {
      result.notRun.push({ measure, reason });
    }
  },
  error: (scenario, error) => {
    result.errors.push({ scenario, message: errorText(error), at: new Date().toISOString() });
    log(`error · ${scenario} · ${errorText(error)}`);
  },
  /**
   * A correctness observation, never a timing: tallied per check, failures logged. `ok` null is a
   * check that could not be made, with its reason.
   */
  check: (name, ok, detail = null) => {
    tallyCheck((result.checks ??= []), name, ok, detail);
    if (ok === false) log(`check failed · ${name}${detail === null ? "" : ` · ${detail}`}`);
    if (ok === null) log(`check skipped · ${name}${detail === null ? "" : ` · ${detail}`}`);
  },
});

// ─── the session helpers ────────────────────────────────────────────────────

/** Server time as this machine's (`clockOffsetMs` = server minus local). */
const local = (ctx, iso) =>
  iso === null || iso === undefined ? null : Date.parse(iso) - ctx.clockOffsetMs;

/**
 * A session in the worktree `name`: a new worktree, or a join of the live one. `layout` is the
 * operator's `harnessLayout` (docs/adr/0016, decision 14), sent only for a start that makes its
 * worktree; a join takes the worktree's.
 */
const createSession = async (ctx, { harness, name, label, api = ctx.api, layout = null }) => {
  const started = Date.now();
  const { value: session, ms } = await api.call("POST", `/projects/${ctx.project.id}/sessions`, {
    harness,
    label,
    name,
    base: null,
    autoLand: false,
    ...(layout === null ? {} : { harnessLayout: layout }),
  });
  ctx.created.sessions.add(session.id);
  ctx.created.worktrees.set(session.worktree, session.worktreeId);
  return { session, startedAt: started, createMs: ms };
};

/** Polls the session until an agent process started after `sinceMs` has drawn its first screen. */
const waitForAgent = async (ctx, sessionId, sinceMs, timeoutMs = 600_000, api = ctx.api) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await api.get(`/sessions/${sessionId}`);
    const agent = detail.currentAgent;
    if (
      agent !== null &&
      agent.firstOutputAt !== null &&
      local(ctx, agent.createdAt) >= sinceMs - 2000
    ) {
      return { detail, agent };
    }
    if (detail.session.status === "failed" || detail.session.settledAt !== null) {
      throw new Error(
        `the session ${detail.session.status} before its agent drew: ${detail.session.summary ?? "no summary"}`,
      );
    }
    if (Date.now() > deadline) throw new Error("no agent output within the timeout");
    await sleep(250);
  }
};

/**
 * Reads the agent's recorded output until `answer` shows: the local time it was seen (`at`), or
 * null. A harness that says its account hit a usage or rate limit will not answer: the wait ends
 * there, with its words in `limit`.
 */
const waitForAnswer = async (ctx, processId, answer, timeoutMs = 180_000, api = ctx.api) =>
  waitForOutput(
    ctx,
    processId,
    (plain) => plain.includes(answer) || plain.replace(/\s+/g, "").includes(answer),
    timeoutMs,
    api,
  );

/**
 * Reads the agent's recorded output until `seen(plain text)` returns something truthy: the local
 * time it was seen (`at`) and what `seen` returned (`value`), or `at` null. A usage limit ends the
 * wait, with its words in `limit`.
 */
const waitForOutput = async (ctx, processId, seen, timeoutMs = 180_000, api = ctx.api) => {
  const deadline = Date.now() + timeoutMs;
  let from = "0";
  let text = "";
  while (Date.now() < deadline) {
    const page = await api.get(`/processes/${processId}/logs?from=${from}&limit=500`);
    for (const chunk of page.chunks ?? []) {
      text += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
    }
    if (page.nextFrom !== null && page.nextFrom !== undefined) from = String(page.nextFrom);
    const plain = stripAnsi(text);
    const version = harnessVersionOf(plain);
    if (version !== null) ctx.result.target.harnessVersions[version.harness] = version.version;
    const value = seen(plain);
    if (value) return { at: Date.now(), value, limit: null };
    const limit = usageLimitOf(plain);
    if (limit !== null) return { at: null, value: null, limit };
    if (page.status === "exited") return { at: null, value: null, limit: null };
    await sleep(250);
  }
  return { at: null, value: null, limit: null };
};

/**
 * The workspace image a launch's executor runs, when Docker on the host says it was made during
 * the launch (its request to its first output): that launch waited for the build, and its start
 * numbers are not a launch's. Every image made since the run started goes in the record's
 * `imageBuilds`, whichever launch saw it first. Null without the host, or when it was made before.
 */
const imageBuiltDuring = async (ctx, container, label, fromMs, toMs) => {
  if (ctx.host === null || container === null) return null;
  const image = await imageOfExecutor(ctx.host, container).catch(() => null);
  if (image === null) return null;
  const createdMs = parseDockerTime(image.created);
  const createdAt = createdMs === null ? null : createdMs - ctx.clockOffsetMs;
  const during = builtWithin(createdAt, fromMs, toMs);
  const builds = (ctx.result.imageBuilds ??= []);
  if (
    createdAt !== null &&
    createdAt >= Date.parse(ctx.result.startedAt) &&
    !builds.some((build) => build.image === image.id)
  ) {
    builds.push({ image: image.id, createdAt: image.created, seenBy: label, duringLaunch: during });
    ctx.rec.note(
      `the workspace image ${image.id.slice(0, 19)} was built during the run (created ${image.created}, first run by ${label})`,
    );
  }
  return during ? image : null;
};

const stopAndSettle = async (ctx, sessionId, timeoutMs = 1_200_000, api = ctx.api) => {
  const startedAt = Date.now();
  const { ms } = await api.call("POST", `/sessions/${sessionId}/stop`, {});
  const deadline = Date.now() + timeoutMs;
  let again = false;
  for (;;) {
    const detail = await api.get(`/sessions/${sessionId}`);
    if (detail.session.settledAt !== null) {
      return { startedAt, callMs: ms, settledAt: local(ctx, detail.session.settledAt), detail };
    }
    if (Date.now() > deadline) throw new Error("the Stop did not settle within the timeout");
    // A Stop that ended the agent leaves shells running; a second one takes them too.
    if (!again && detail.session.status !== "stopping" && Date.now() - startedAt > 15_000) {
      again = true;
      await api.post(`/sessions/${sessionId}/stop`).catch(() => null);
    }
    await sleep(500);
  }
};

/** Mend's log for a window, parsed; empty when the host is out of reach. */
const mendBlocks = async (ctx, fromMs, toMs) => {
  if (ctx.host === null) return [];
  // The server's log stamps are its clock; the window is asked in its time.
  const text = await mendLogBetween(
    ctx.host,
    ctx.opts.mendContainer,
    fromMs + ctx.clockOffsetMs,
    toMs + ctx.clockOffsetMs,
  );
  return parseMendLog(text).map((block) => ({ ...block, at: block.at - ctx.clockOffsetMs }));
};

const sealantdEvents = (ctx, text) =>
  parseSealantdLog(text).map((event) => ({ ...event, at: event.at - ctx.clockOffsetMs }));

/**
 * One launch (new, join or resume) as steps: the engine's milestones between the request and the
 * agent's first output, the executor's first command, the commands run, the image, and the
 * delivery window (warm-up read → the last of memory and secret files; skills, which log nothing
 * of their own, fall inside it).
 */
const recordLaunch = async (ctx, prefixOf, { startedAt, sessionId, detail, agent }) => {
  const { rec } = ctx;
  const agentAt = local(ctx, agent.createdAt);
  const outputAt = local(ctx, agent.firstOutputAt);
  if (ctx.host === null) {
    const prefix = typeof prefixOf === "function" ? prefixOf(null) : prefixOf;
    rec.sample(`${prefix}.agent_to_output`, outputAt - agentAt, "ms");
    rec.notRun(`${prefix}.step.*`, "no access to the server's host (pass --ssh or run there)");
    return { prefix, milestones: null };
  }
  const workspaceId = detail.session.sealantWorkspaceId;
  const blocks = await mendBlocks(ctx, startedAt, outputAt + 1000);
  const milestones = milestonesOf(blocks, {
    sessionId,
    workspaceId,
    fromMs: startedAt,
    toMs: agentAt,
  });
  // The prefix may depend on what the launch turned out to be (a join that launched cold).
  const prefix = typeof prefixOf === "function" ? prefixOf(milestones) : prefixOf;
  rec.sample(`${prefix}.agent_to_output`, outputAt - agentAt, "ms");
  const executorUp = workspaceId === null ? null : firstExecAt(blocks, workspaceId, startedAt);
  const marks = [...milestones];
  if (executorUp !== null) marks.push({ name: "executor up · first command", at: executorUp });
  marks.push({ name: "agent process created", at: agentAt });
  for (const step of stepsOf(startedAt, marks)) {
    rec.sample(`${prefix}.step.${step.name}`, step.ms, "ms");
  }
  if (workspaceId !== null) {
    rec.sample(`${prefix}.execs`, execCount(blocks, workspaceId, startedAt, agentAt), "count");
  }
  const delivery = deliveryWindow(milestones);
  if (delivery !== null) {
    // A join that launched cold, or a launch that waited for an image build, is kept apart,
    // unbudgeted, like its first output.
    const apart = prefix.endsWith(".cold") || prefix.endsWith(".image_built");
    rec.sample(`${prefix}.delivery`, delivery, "ms", apart ? null : "delivery");
  } else {
    rec.notRun(`${prefix}.delivery`, "the delivery milestones were not in the log");
  }
  const memory = milestones.find((m) => m.name === "agent memory · delivered");
  if (memory !== undefined && typeof memory.fields.written === "number") {
    rec.sample(`${prefix}.memory_files_written`, memory.fields.written, "count");
  }
  const image = blocks.map((block) => parseImageLine(block.message)).find((line) => line !== null);
  if (image !== null && image !== undefined) ctx.result.target.workspaceImage ??= image.image;
  return { prefix, milestones };
};

/**
 * Whether a join went into the live executor: it joined the lease holder and neither waited for a
 * previous executor to end nor started a new one (a harness warm-up is a new executor's first
 * step). After a replacement the worktree has no live executor and a "join" is a cold launch.
 */
const joinedLiveExecutor = (milestones) =>
  milestones === null ||
  (milestones.some((m) => m.name.includes("joining the lease holder")) &&
    !milestones.some(
      (m) =>
        m.name.includes("previous executor has not ended") || m.name.startsWith("harness warm-up"),
    ));

/**
 * One join measured: into a live executor (budgeted, under `prefix`), or a launch that found none
 * and went cold (`prefix.cold`, kept apart). Returns the prefix it was recorded under.
 */
const recordJoin = async (ctx, prefix, budget, { startedAt, session, detail, agent, run }) => {
  const firstOutput = local(ctx, agent.firstOutputAt) - startedAt;
  const recorded = await recordLaunch(
    ctx,
    (milestones) => (joinedLiveExecutor(milestones) ? prefix : `${prefix}.cold`),
    { startedAt, sessionId: session.id, detail, agent },
  );
  if (recorded.prefix === prefix) {
    ctx.rec.sample(`${prefix}.first_output`, firstOutput, "ms", budget);
  } else {
    ctx.rec.sample(`${recorded.prefix}.first_output`, firstOutput, "ms");
    ctx.rec.note(
      `${prefix} #${run} found no live executor (replaced or replacing) and launched cold (${(firstOutput / 1000).toFixed(1)} s); kept apart`,
    );
  }
  ctx.log(`${recorded.prefix} #${run} · first output ${(firstOutput / 1000).toFixed(1)} s`);
  return recorded.prefix;
};

const recordResources = async (ctx, name, container, budget) => {
  if (ctx.host === null || container === null) return;
  const resources = await executorResources(ctx.host, container);
  ctx.rec.sample(`${name}.disk_bytes`, parseContainerDisk(resources.mainDisk), "bytes", budget);
  ctx.rec.sample(`${name}.memory_bytes`, parseMemUsage(resources.mainMemory), "bytes", budget);
  ctx.rec.sample(`${name}.sidecar_memory_bytes`, parseMemUsage(resources.sidecarMemory), "bytes");
};

/** A Stop, as steps: the save (the drain's "saved · terminating"), the settle, what was uploaded. */
const recordStop = async (ctx, prefix, { stop, sessionId, container, follower }, budgeted) => {
  const { rec } = ctx;
  const settled = stop.settledAt - stop.startedAt;
  rec.sample(`${prefix}.call`, stop.callMs, "ms");
  if (ctx.host === null) {
    rec.sample(`${prefix}.settled`, settled, "ms", budgeted ? "start" : null);
    return;
  }
  const blocks = await mendBlocks(ctx, stop.startedAt, stop.settledAt + 2000);
  const milestones = milestonesOf(blocks, {
    sessionId,
    fromMs: stop.startedAt,
    toMs: stop.settledAt + 2000,
  });
  for (const step of stepsOf(stop.startedAt, milestones)) {
    rec.sample(`${prefix}.step.${step.name}`, step.ms, "ms");
  }
  const saved = milestones.find((m) => m.name === "capture drain · saved · terminating");
  if (saved !== undefined) {
    rec.sample(`${prefix}.settled`, settled, "ms", budgeted ? "start" : null);
    rec.sample(`${prefix}.save`, saved.at - stop.startedAt, "ms", budgeted ? "start" : null);
  } else {
    // No executor saved for this Stop (one was already replaced or gone): a settle, not a save.
    rec.sample(`${prefix}.settled_without_save`, settled, "ms");
    rec.note(
      `${prefix}: a Stop with no save of its own (${(settled / 1000).toFixed(1)} s); kept apart`,
    );
  }
  const flush = milestones.find((m) => m.name.startsWith("capture flush · final · completed"));
  if (flush !== undefined && typeof flush.fields.uploadedBytes === "number") {
    rec.sample(`${prefix}.final_flush_uploaded_bytes`, flush.fields.uploadedBytes, "bytes");
  }
  if (container !== null) {
    const executor = container.replace(/^sealant-/, "");
    const drain = blocks
      .map((block) => parseDrainLine(block.message))
      .find((line) => line !== null && line.executor === executor);
    if (drain !== undefined) {
      rec.sample(`${prefix}.executor_uploaded_bytes`, drain.uploadedBytes, "bytes");
    }
  }
  if (follower !== null) {
    const text = await follower.stop();
    const staged = stagedBytesOf(sealantdEvents(ctx, text));
    for (const [kind, bytes] of Object.entries(staged)) {
      rec.sample(`${prefix}.executor_staged_${kind}_bytes`, bytes, "bytes");
    }
  }
};

// ─── the terminal helpers ───────────────────────────────────────────────────

let commandCounter = 0;

/** Runs one command at the shell's prompt; its time to the completion marker and its exit code. */
const runCommand = async (terminal, command, timeoutMs = 120_000) => {
  commandCounter += 1;
  const tag = `${commandCounter}x${Math.random().toString(36).slice(2, 8)}`;
  const index = terminal.frames.length;
  const started = performance.now();
  // The marker is assembled by printf, so the echoed command line never contains it.
  terminal.send(`${command}; printf 'ST-BENCH-%s-%s\\n' DONE${tag} $?\r`);
  const match = await terminal.waitFor(
    new RegExp(`ST-BENCH-DONE${tag}-(\\d+)`),
    index,
    timeoutMs,
    stripAnsi,
  );
  if (match === null) throw new Error(`no completion marker for: ${command}`);
  const exit = Number(new RegExp(`ST-BENCH-DONE${tag}-(\\d+)`).exec(stripAnsi(match.text))?.[1]);
  return { ms: match.frame.at - started, exit, text: stripAnsi(match.text) };
};

const openShell = async (ctx, sessionId) => {
  const started = performance.now();
  const { value: process, ms } = await ctx.api.call("POST", `/sessions/${sessionId}/shell`, {});
  const terminal = await attachTerminal(ctx.api, { process: process.id });
  const first = await terminal.firstFrame(0, 30_000);
  return { process, terminal, callMs: ms, openMs: first === null ? null : first.at - started };
};

// ─── the scenarios ──────────────────────────────────────────────────────────

/**
 * A new session to its first output and its first answer. Its executor's size is taken at its first
 * output, a fixed point of every launch; what it holds once the answer is in is kept beside it.
 */
const newSession = async (ctx, harness, run) => {
  const a = 2000 + 37 * run + HARNESSES.indexOf(harness);
  const b = 3000 + 11 * run;
  const answer = String(a + b);
  const prompt = `What is ${a} + ${b}? Reply with only the number. Do not use any tools.`;
  const name = `${PREFIX}${ctx.rid}-${harness}-${run}`;
  const { session, startedAt, createMs } = await createSession(ctx, {
    harness,
    name,
    label: name,
    layout: ctx.opts.layout,
  });
  ctx.log(`${harness} #${run} · created ${session.id.slice(0, 8)} · worktree ${name}`);
  const { ms: launchMs } = await ctx.api.call("POST", `/sessions/${session.id}/launch`, { prompt });
  const { detail, agent } = await waitForAgent(ctx, session.id, startedAt);
  const outputAt = local(ctx, agent.firstOutputAt);
  // A launch that ran in another layout than the one asked for (a person launch the server put
  // in a shared home, say) is not a launch of that layout: kept apart, and the check fails.
  const ran = agent.runsAs === null || agent.runsAs === undefined ? "shared" : "person";
  const otherLayout = ctx.opts.layout !== null && ran !== ctx.opts.layout;
  if (ctx.opts.layout !== null) {
    ctx.rec.check(
      `new.${harness}.layout`,
      !otherLayout,
      `asked ${ctx.opts.layout}, the agent runs as ${agent.runsAs ?? "root (shared)"}`,
    );
  }
  // The answer is watched for from here, while the executor is sized beside it: the sampling
  // never delays when the answer is seen.
  const answering = waitForAnswer(ctx, agent.id, answer);
  answering.catch(() => {});
  // Never after the answer wait: its length depends on the answer, and a missing one moved the
  // sample 3 minutes on, into the capture's staging (0.36.0-next.628, Claude at its weekly limit).
  const container = ctx.host === null ? null : await executorOf(ctx.host, session.id);
  await recordResources(ctx, `executor.${harness}`, container, "resource");
  const built = await imageBuiltDuring(ctx, container, `${harness} #${run}`, startedAt, outputAt);
  // A launch that waited for its workspace image to be built is kept apart, unbudgeted.
  const prefix = otherLayout
    ? `new.${harness}.other_layout`
    : built === null
      ? `new.${harness}`
      : `new.${harness}.image_built`;
  const budget = built === null && !otherLayout ? "start" : null;
  const firstOutput = outputAt - startedAt;
  ctx.rec.sample(`${prefix}.first_output`, firstOutput, "ms", budget);
  ctx.rec.sample(`new.${harness}.create_call`, createMs, "ms");
  ctx.rec.sample(`new.${harness}.launch_call`, launchMs, "ms");
  if (built !== null) {
    ctx.rec.note(
      `${harness} #${run} waited for its workspace image to be built (${built.id.slice(0, 19)}, created ${built.created}): ${(firstOutput / 1000).toFixed(1)} s, kept apart under ${prefix}`,
    );
  }
  ctx.log(`${harness} #${run} · first output ${(firstOutput / 1000).toFixed(1)} s`);
  const answered = await answering;
  if (answered.at !== null) {
    ctx.rec.sample(`${prefix}.first_turn`, answered.at - startedAt, "ms", budget);
    ctx.rec.sample(`${prefix}.output_to_answer`, answered.at - outputAt, "ms");
    if (ctx.host !== null && container !== null) {
      const after = await executorResources(ctx.host, container);
      ctx.rec.sample(
        `executor.${harness}.memory_after_answer_bytes`,
        parseMemUsage(after.mainMemory),
        "bytes",
      );
    }
  } else if (answered.limit !== null) {
    const reason = `the harness's account hit its usage limit ("${answered.limit}")`;
    ctx.rec.note(`${harness} #${run}: no answer, ${reason}`);
    ctx.rec.notRun(`${prefix}.first_turn`, reason);
    ctx.rec.notRun(`${prefix}.output_to_answer`, reason);
  } else {
    ctx.rec.note(
      `${harness} #${run}: the answer (${answer}) was not seen in the agent's output within 3 min`,
    );
  }
  await recordLaunch(ctx, prefix, { startedAt, sessionId: session.id, detail, agent });
  if (container !== null && ctx.host !== null) {
    const boot = restoreOf(
      sealantdEvents(ctx, await ctx.host.shell(`docker logs -t ${container} 2>&1`)),
    );
    if (boot !== null) ctx.rec.sample(`new.${harness}.restore_ms`, boot.ms, "ms");
  }
  const follower = ctx.host === null || container === null ? null : ctx.host.follow(container);
  return { session, agent, container, follower, name };
};

/** A second session of the same person in the live worktree: a join of a live executor. */
const joinSamePerson = async (ctx, primary, run) => {
  const label = `${primary.name}-join`;
  const { session, startedAt } = await createSession(ctx, {
    harness: primary.session.harness,
    name: primary.name,
    label,
  });
  if (session.worktreeId !== primary.session.worktreeId) {
    throw new Error("the second session did not join the first one's worktree");
  }
  await ctx.api.call("POST", `/sessions/${session.id}/launch`, {});
  const { detail, agent } = await waitForAgent(ctx, session.id, startedAt);
  const prefix = await recordJoin(ctx, "join.same", "start", {
    startedAt,
    session,
    detail,
    agent,
    run,
  });
  const stop = await stopAndSettle(ctx, session.id);
  ctx.rec.sample(`${prefix}.stop_settled`, stop.settledAt - stop.startedAt, "ms");
};

/** A join by a different person; only with a second account's token. */
const joinOtherPerson = async (ctx, primary, run) => {
  const { session, startedAt } = await createSession(ctx, {
    harness: primary.session.harness,
    name: primary.name,
    label: `${primary.name}-other`,
    api: ctx.api2,
  });
  if (session.worktreeId !== primary.session.worktreeId) {
    throw new Error("the second account's session did not join the first one's worktree");
  }
  let joined = false;
  try {
    await ctx.api2.call("POST", `/sessions/${session.id}/launch`, {});
    const { detail, agent } = await waitForAgent(ctx, session.id, startedAt, 600_000, ctx.api2);
    joined = true;
    if (ctx.opts.layout === "person") {
      ctx.rec.check(
        "join.other.runs_as",
        agent.runsAs === session.ownerUserId,
        `the joiner's agent runs as ${agent.runsAs ?? "root"}`,
      );
    }
    await recordJoin(ctx, "join.other", "join-other", { startedAt, session, detail, agent, run });
  } finally {
    // A join that failed is stopped too: otherwise the server keeps the launch waiting on the
    // worktree's holder (up to its 30 min lease wait) until the run's cleanup removes the worktree.
    // A failed stop never hides the join's own error.
    if (!joined) {
      await stopAndSettle(ctx, session.id, 120_000, ctx.api2).catch((error) =>
        ctx.log(`join.other · the failed join's stop: ${error.message}`),
      );
    }
  }
  await stopAndSettle(ctx, session.id, 1_200_000, ctx.api2);
};

/** Shell open, typing echo, git through the shim and checkpoints, on one live session. */
const interactive = async (ctx, primary) => {
  const { rec, opts } = ctx;
  const sessionId = primary.session.id;
  let shell = null;
  for (let k = 1; k <= opts.interactiveRuns; k += 1) {
    const opened = await openShell(ctx, sessionId);
    rec.sample("shell.open", opened.openMs, "ms", "interactive");
    rec.sample("shell.open_call", opened.callMs, "ms");
    if (k < opts.interactiveRuns) {
      opened.terminal.close();
      await ctx.api.post(`/processes/${opened.process.id}/stop`).catch(() => null);
    } else {
      shell = opened;
    }
  }
  ctx.log(`shell · ${opts.interactiveRuns} opens`);
  // The agent's own terminal, as a client attaches to it: ticket, socket, the first frame.
  for (let k = 1; k <= opts.interactiveRuns; k += 1) {
    const started = performance.now();
    const attached = await attachTerminal(ctx.api, { process: primary.agent.id });
    const first = await attached.firstFrame(0, 30_000);
    rec.sample("terminal.attach", first === null ? null : first.at - started, "ms", "interactive");
    attached.close();
  }
  ctx.log(`terminal · ${opts.interactiveRuns} attaches`);
  try {
    await onShell(ctx, primary, shell.terminal);
  } finally {
    shell.terminal.close();
    await ctx.api.post(`/processes/${shell.process.id}/stop`).catch(() => null);
  }
};

/** What runs at the last shell's prompt: versions, typing, git, checkpoints. */
const onShell = async (ctx, primary, terminal) => {
  const { rec, opts } = ctx;
  const sessionId = primary.session.id;
  await terminal.settle(800, 20_000);

  const versions = await runCommand(
    terminal,
    "for h in claude codex pi opencode; do printf 'ver:%s=' $h; $h --version 2>&1 | head -1; echo; done",
  );
  for (const match of versions.text.matchAll(/ver:(\w+)=([^\r\n]*)/g)) {
    const text = match[2].trim();
    if (/\d+\.\d+/.test(text) && !(match[1] in ctx.result.target.harnessVersions)) {
      ctx.result.target.harnessVersions[match[1]] = text;
    }
  }

  for (let k = 1; k <= opts.typingRuns; k += 1) {
    const index = terminal.frames.length;
    const sent = performance.now();
    terminal.send("x");
    const echo = await terminal.firstFrame(index, 5000);
    rec.sample("terminal.echo", echo === null ? null : echo.at - sent, "ms", "interactive");
    await sleep(150);
  }
  terminal.send("\x15");
  await terminal.settle(500, 5000);
  ctx.log(`terminal · ${opts.typingRuns} keystrokes`);

  await gitThroughShim(ctx, terminal).catch((error) => rec.error("git", error));

  for (let k = 1; k <= opts.interactiveRuns; k += 1) {
    await runCommand(terminal, `echo ${k} > .st-bench-checkpoint-${k}`);
    const { ms } = await ctx.api.call("POST", `/sessions/${sessionId}/checkpoints`, {
      trigger: "user-mark",
    });
    rec.sample("checkpoint.save", ms, "ms", "start");
  }
  await runCommand(terminal, "rm -f .st-bench-checkpoint-*");
  ctx.log(`checkpoint · ${opts.interactiveRuns} saves`);
};

/**
 * `git fetch` and `git push` through Mend's git shim: the workspace's `core.sshCommand`
 * (`mend-git-ssh`) carries git's SSH transport to the Mend host, which authenticates. The shim
 * serves SSH remotes only, so the project's origin is addressed in its SSH form; a prompt for
 * credentials fails the command at once instead of waiting for a person.
 */
const gitThroughShim = async (ctx, terminal) => {
  const { rec, opts } = ctx;
  const remote = sshRemoteOf(ctx.project.originUrl ?? "");
  if (remote === null) {
    rec.notRun("git.fetch", `the project's origin (${ctx.project.originUrl}) has no SSH form`);
    rec.notRun("git.push", `the project's origin (${ctx.project.originUrl}) has no SSH form`);
    return;
  }
  const git = `GIT_TERMINAL_PROMPT=0 git`;
  const branch = ctx.project.defaultBranch ?? "main";
  for (let k = 1; k <= opts.interactiveRuns; k += 1) {
    const fetched = await runCommand(terminal, `${git} fetch -q ${remote} ${branch}`);
    if (fetched.exit !== 0) throw new Error(`git fetch exited ${fetched.exit}`);
    rec.sample("git.fetch", fetched.ms, "ms", "interactive");
  }
  const commit = await runCommand(
    terminal,
    `${git} commit --allow-empty -q -m 'st-bench: push timing'`,
  );
  if (commit.exit !== 0) throw new Error(`git commit exited ${commit.exit}`);
  for (let k = 1; k <= opts.interactiveRuns; k += 1) {
    const ref = `${PREFIX}${ctx.rid}-${k}`;
    ctx.created.remoteRefs.add(ref);
    const pushed = await runCommand(terminal, `${git} push -q ${remote} HEAD:refs/heads/${ref}`);
    if (pushed.exit !== 0) {
      ctx.created.remoteRefs.delete(ref);
      rec.notRun(
        "git.push",
        `git push to ${remote} exited ${pushed.exit} (no push access through the shim?)`,
      );
      return;
    }
    rec.sample("git.push", pushed.ms, "ms", "interactive");
    const deleted = await runCommand(terminal, `${git} push -q ${remote} --delete ${ref}`);
    if (deleted.exit === 0) ctx.created.remoteRefs.delete(ref);
    rec.sample("git.push_delete", deleted.ms, "ms");
  }
  ctx.log(`git · ${opts.interactiveRuns} fetches and pushes through the shim`);
};

/** The two reads every client makes most: the session list and one session's view. */
const apiLatency = async (ctx, sessionId) => {
  for (let k = 1; k <= ctx.opts.apiRuns; k += 1) {
    ctx.rec.sample("api.session_list", (await ctx.api.call("GET", "/sessions")).ms, "ms", "api");
    ctx.rec.sample(
      "api.session_view",
      (await ctx.api.call("GET", `/sessions/${sessionId}`)).ms,
      "ms",
      "api",
    );
  }
  // The CLI on this machine, as a person reads their sessions: process start, auth, the list.
  if (ctx.opts.cli !== null) {
    for (const [name, args] of [
      ["cli.sessions", "sessions"],
      ["cli.worktrees", "worktrees"],
    ]) {
      for (let k = 1; k <= ctx.opts.apiRuns; k += 1) {
        const started = performance.now();
        try {
          await runLocal(`${ctx.opts.cli} ${args} >/dev/null`);
          ctx.rec.sample(name, performance.now() - started, "ms");
        } catch (error) {
          ctx.rec.error(name, error);
          break;
        }
      }
    }
  }
};

/** A resume after a Stop: a new executor restores the worktree's capture, the agent continues. */
const resume = async (ctx, primary, run) => {
  const sessionId = primary.session.id;
  const startedAt = Date.now();
  const { ms } = await ctx.api.call("POST", `/sessions/${sessionId}/resume`, { harness: null });
  const { detail, agent } = await waitForAgent(ctx, sessionId, startedAt);
  const outputAt = local(ctx, agent.firstOutputAt);
  const firstOutput = outputAt - startedAt;
  const container = ctx.host === null ? null : await executorOf(ctx.host, sessionId);
  const built = await imageBuiltDuring(ctx, container, `resume #${run}`, startedAt, outputAt);
  const prefix = built === null ? "resume" : "resume.image_built";
  ctx.rec.sample(`${prefix}.first_output`, firstOutput, "ms", built === null ? "start" : null);
  ctx.rec.sample("resume.call", ms, "ms");
  if (built !== null) {
    ctx.rec.note(
      `resume #${run} waited for its workspace image to be built (${built.id.slice(0, 19)}): kept apart under ${prefix}`,
    );
  }
  ctx.log(`resume #${run} · first output ${(firstOutput / 1000).toFixed(1)} s`);
  await recordLaunch(ctx, prefix, { startedAt, sessionId, detail, agent });
  if (container !== null) {
    const boot = restoreOf(
      sealantdEvents(ctx, await ctx.host.shell(`docker logs -t ${container} 2>&1`)),
    );
    if (boot !== null) {
      ctx.rec.sample("resume.restore_ms", boot.ms, "ms", "start");
      ctx.rec.sample("resume.restore_bytes", boot.bytes, "bytes", "bytes");
      ctx.rec.sample("resume.restore_files", boot.files, "count");
    }
    await recordResources(ctx, "executor.resumed", container, null);
  }
  return {
    agent,
    container,
    follower: container === null ? null : ctx.host.follow(container),
  };
};

// ─── per person (docs/adr/0016; need `--layout person`) ─────────────────────

/** The harnesses Mend runs in protocol mode, where a turn can be steered. */
const PROTOCOL_HARNESSES = ["claude", "codex"];

const seconds = (value) => (value === null ? "–" : `${(value / 1000).toFixed(1)} s`);

const sumPrompt = (a, b) =>
  `What is ${a} + ${b}? Reply with only the number. Do not use any tools.`;

/** The prompt whose answer is the agent's own uid and HOME, which only the agent can read. */
const IDENTITY_PROMPT =
  "Run this shell command and reply with only its output, on one line: echo ST-BENCH-ID $(id -u) $HOME";

const listTurns = async (api, sessionId) => {
  const value = await api.get(`/sessions/${sessionId}/turns`);
  return Array.isArray(value) ? value : (value?.turns ?? []);
};

/** Every item of one turn (the session's items, paged by their change-feed cursor). */
const turnItems = async (api, sessionId, turnId) => {
  const out = [];
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const value = await api.get(`/sessions/${sessionId}/items?after=${after}&limit=500`);
    const items = Array.isArray(value) ? value : (value?.items ?? []);
    out.push(...items.filter((item) => item.turnId === turnId));
    if (items.length < 500) break;
    after = Math.max(after, ...items.map((item) => item.seq ?? 0));
  }
  return out;
};

/**
 * Polls one turn until it ends, watching the session's agent processes meanwhile: the turn, the
 * session as it read then, and the most agent processes seen live at once (polled every 250 ms).
 */
const waitForTurn = async (ctx, sessionId, turnId, timeoutMs = 600_000) => {
  const deadline = Date.now() + timeoutMs;
  let maxLive = 0;
  for (;;) {
    const [turns, detail] = await Promise.all([
      listTurns(ctx.api, sessionId),
      ctx.api.get(`/sessions/${sessionId}`),
    ]);
    maxLive = Math.max(maxLive, liveAgents(detail.processes).length);
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (turn !== undefined && turnEnded(turn)) return { turn, detail, maxLive };
    if (Date.now() > deadline) {
      throw new Error(
        `turn ${turnId.slice(0, 8)} did not end within ${timeoutMs / 1000} s (${turn?.status ?? "not listed"})`,
      );
    }
    await sleep(250);
  }
};

/**
 * One turn sent to a shared conversation and timed on the server's clock from its submit: to
 * its start (the hand-over when the sender changed, budgeted at 5 s), to the agent's first item
 * for it and to its end. Its sender, payer, process user and the one-agent rule are checked.
 */
const steeredTurn = async (ctx, { session, harness, kind, api, round }) => {
  const { rec } = ctx;
  const a = 4000 + 13 * round + 101 * ["to_other", "back", "own"].indexOf(kind);
  const b = 5000 + 7 * round + HARNESSES.indexOf(harness);
  const answer = String(a + b);
  const prefix = `handover.${harness}.${kind}`;
  const { value: submitted, ms } = await api.call("POST", `/sessions/${session.id}/turns`, {
    input: sumPrompt(a, b),
  });
  const { turn, detail, maxLive } = await waitForTurn(ctx, session.id, submitted.id);
  const items = await turnItems(ctx.api, session.id, turn.id);
  const times = turnTimes(turn, items);
  rec.sample(`${prefix}.submit_call`, ms, "ms");
  rec.sample(`${prefix}.started`, times.started, "ms", kind === "own" ? null : "handover");
  rec.sample(`${prefix}.first_output`, times.firstOutput, "ms");
  rec.sample(`${prefix}.completed`, times.completed, "ms");
  const process = (detail.processes ?? []).find((entry) => entry.id === turn.processId) ?? null;
  for (const verdict of turnVerdicts({
    turn,
    process,
    ownerId: session.ownerUserId,
    fromOwner: kind !== "to_other",
    maxLive,
    answer,
    items,
  })) {
    rec.check(`${prefix}.${verdict.name}`, verdict.ok, verdict.detail);
  }
  ctx.log(
    `${prefix} #${round} · started ${seconds(times.started)} · first output ${seconds(times.firstOutput)} · completed ${seconds(times.completed)}`,
  );
};

/**
 * The steering hand-over (docs/adr/0016, decision 6) on one protocol harness: a person-layout
 * protocol session of the first account with shared control on; then, `runs` rounds of a turn
 * by the second account (the hand-over to their process), one by the owner (the hand-back) and
 * one more by the owner (no hand-over, the reference the ADR's limit is read against).
 */
const handoverOn = async (ctx, harness) => {
  const name = `${PREFIX}${ctx.rid}-handover-${harness}`;
  const { session } = await createSession(ctx, { harness, name, label: name, layout: "person" });
  ctx.log(`handover.${harness} · created ${session.id.slice(0, 8)} · worktree ${name}`);
  try {
    await ctx.api.call("POST", `/sessions/${session.id}/launch`, {
      mode: "protocol",
      prompt: sumPrompt(1200, 3400),
    });
    // The launch's own turn, the owner's, on the owner's process.
    const deadline = Date.now() + 900_000;
    let first = null;
    while (first === null) {
      const [earliest] = (await listTurns(ctx.api, session.id)).toSorted(
        (a, b) => a.ordinal - b.ordinal,
      );
      if (earliest !== undefined && turnEnded(earliest)) first = earliest;
      else if (Date.now() > deadline) throw new Error("the launch's turn did not end in 15 min");
      else await sleep(500);
    }
    const launched = await ctx.api.get(`/sessions/${session.id}`);
    const firstProcess = (launched.processes ?? []).find((p) => p.id === first.processId) ?? null;
    ctx.rec.check(
      `handover.${harness}.launch.runs_as`,
      firstProcess !== null && firstProcess.runsAs === session.ownerUserId,
      `the launch's process runs as ${firstProcess?.runsAs ?? "root (shared)"}`,
    );
    ctx.rec.check(
      `handover.${harness}.launch.completed`,
      first.status === "completed",
      first.status,
    );
    await ctx.api.put(`/sessions/${session.id}/shared-control`, { enabled: true });
    for (let round = 1; round <= ctx.opts.runs; round += 1) {
      await steeredTurn(ctx, { session, harness, kind: "to_other", api: ctx.api2, round });
      await steeredTurn(ctx, { session, harness, kind: "back", api: ctx.api, round });
      await steeredTurn(ctx, { session, harness, kind: "own", api: ctx.api, round });
    }
  } finally {
    await removeWorktree(ctx, session.worktreeId).catch((error) =>
      ctx.rec.error(`cleanup · handover.${harness}`, error),
    );
  }
};

const handover = async (ctx) => {
  const harnesses = ctx.opts.harnesses.filter((harness) => PROTOCOL_HARNESSES.includes(harness));
  if (harnesses.length === 0) {
    ctx.rec.notRun("handover.*", "no protocol harness (claude, codex) among --harnesses");
    return;
  }
  for (const harness of harnesses) {
    await handoverOn(ctx, harness).catch((error) => ctx.rec.error(`handover.${harness}`, error));
  }
};

/** The harnesses that answer on the person's ChatGPT login (docs/adr/0016, decision 5). */
const CHATGPT_HARNESSES = ["pi", "opencode"];

/**
 * Why this session's pi or opencode has no ChatGPT login of its sender's, or null: the session
 * line, else the person's connected accounts. Null for every other harness.
 */
const chatGptLoginSkip = async (ctx, harness, sessionId, api) => {
  if (!CHATGPT_HARNESSES.includes(harness)) return null;
  const detail = await api.get(`/sessions/${sessionId}`).catch(() => null);
  const identity = await api.get("/me/sealant").catch(() => null);
  return chatGptLoginSkipOf({
    summary: detail?.session?.summary ?? null,
    accounts: identity?.accounts ?? null,
  });
};

/** A person's launch into a new person worktree or a join of one, to its first output. */
const personLaunch = async (ctx, { harness, name, api, prompt, layout = null }) => {
  const { session, startedAt } = await createSession(ctx, {
    harness,
    name,
    label: api === ctx.api ? name : `${name}-other`,
    api,
    layout,
  });
  await api.call("POST", `/sessions/${session.id}/launch`, { prompt });
  const { agent } = await waitForAgent(ctx, session.id, startedAt, 600_000, api);
  return { session, agent };
};

/**
 * Growth per extra person (docs/adr/0016, "Budgets"), per harness: a person worktree with the
 * first account's conversation, then the second account's own session there with theirs, and
 * the second person's saved directory sized, machine state left out: all of it, their
 * conversation state and memory, and the rest, which the budget holds to 64 KB.
 */
const growthOn = async (ctx, harness) => {
  const { rec } = ctx;
  const name = `${PREFIX}${ctx.rid}-growth-${harness}`;
  const ask = (k) => {
    const a = 6000 + 17 * k + HARNESSES.indexOf(harness);
    return { prompt: sumPrompt(a, 2000), answer: String(a + 2000) };
  };
  const firstAsk = ask(1);
  const first = await personLaunch(ctx, {
    harness,
    name,
    api: ctx.api,
    prompt: firstAsk.prompt,
    layout: "person",
  });
  let second = null;
  try {
    await waitForAnswer(ctx, first.agent.id, firstAsk.answer);
    const container = await executorOf(ctx.host, first.session.id);
    if (container === null) throw new Error("the executor was not found on the host");
    const size = async (accountId) =>
      classifySavedFiles(
        await ctx.host.shell(asPersonCommand(container, accountId, SAVED_SIZES_SH)),
      );
    const secondAsk = ask(2);
    second = await personLaunch(ctx, {
      harness,
      name,
      api: ctx.api2,
      prompt: secondAsk.prompt,
    });
    if (second.session.worktreeId !== first.session.worktreeId) {
      throw new Error("the second account's session did not join the first one's worktree");
    }
    const skip = await chatGptLoginSkip(ctx, harness, second.session.id, ctx.api2);
    if (skip === null) {
      const answered = await waitForAnswer(
        ctx,
        second.agent.id,
        secondAsk.answer,
        180_000,
        ctx.api2,
      );
      rec.check(
        `growth.${harness}.second_answers`,
        answered.at !== null,
        answered.at !== null ? "answered" : (answered.limit ?? "no answer within 3 min"),
      );
    } else {
      rec.check(`growth.${harness}.second_answers`, null, `skipped: ${skip}`);
      rec.note(
        `growth.${harness}: the second person's agent cannot answer (${skip}), so it holds no conversation; their saved directory is sized without one`,
      );
    }
    // Let the harness write its state out after the answer.
    await sleep(5000);
    const firstSize = await size(first.session.ownerUserId);
    const secondSize = await size(second.session.ownerUserId);
    if (secondSize === null) {
      rec.check(`growth.${harness}.saved_dir`, false, "no saved directory for the second person");
      return;
    }
    rec.sample(`growth.${harness}.extra_person_bytes`, secondSize.total, "bytes");
    rec.sample(`growth.${harness}.extra_person_state_bytes`, secondSize.state, "bytes");
    rec.sample(
      `growth.${harness}.extra_person_beyond_state_bytes`,
      secondSize.beyond,
      "bytes",
      "growth",
    );
    rec.sample(`growth.${harness}.extra_person_machine_state_bytes`, secondSize.machine, "bytes");
    if (firstSize !== null)
      rec.sample(`growth.${harness}.first_person_bytes`, firstSize.total, "bytes");
    if (secondSize.beyond > 64 * 1024) {
      rec.note(
        `growth.${harness}: ${secondSize.beyond} bytes beyond conversation state; largest: ${secondSize.largestBeyond.map((entry) => `${entry.path} ${entry.bytes}`).join(", ")}`,
      );
    }
    ctx.log(
      `growth.${harness} · the second person's saved directory ${secondSize.total} bytes · ${secondSize.beyond} beyond conversation state`,
    );
  } finally {
    if (second !== null) {
      await stopAndSettle(ctx, second.session.id, 600_000, ctx.api2).catch((error) =>
        ctx.log(`growth.${harness} · the second session's stop: ${error.message}`),
      );
    }
    await removeWorktree(ctx, first.session.worktreeId).catch((error) =>
      rec.error(`cleanup · growth.${harness}`, error),
    );
  }
};

const growth = async (ctx) => {
  for (const harness of ctx.opts.harnesses) {
    await growthOn(ctx, harness).catch((error) => ctx.rec.error(`growth.${harness}`, error));
  }
};

/**
 * What one person's agent shows in its executor: the API's `runsAs`, the agent's own answer
 * (its uid and HOME), and the probe as that person (uid range, home, processes, logins, pi
 * profile). Recorded as checks under `prefix`.
 */
const checkPerson = async (ctx, prefix, { harness, session, agent, container, api, other }) => {
  const { rec } = ctx;
  const accountId = session.ownerUserId;
  rec.check(
    `${prefix}.runs_as`,
    agent.runsAs === accountId,
    `the agent runs as ${agent.runsAs ?? "root (shared)"}`,
  );
  // A pi or opencode with no ChatGPT login of this person's starts and cannot answer: said, not
  // waited on, and its home is still checked to be theirs.
  const loginSkipped = await chatGptLoginSkip(ctx, harness, session.id, api);
  const said =
    loginSkipped === null
      ? await waitForOutput(
          ctx,
          agent.id,
          (plain) => agentIdentityOf(plain) ?? agentIdentityOf(plain.replace(/\s+/g, "")),
          240_000,
          api,
        )
      : { at: null, value: null, limit: null };
  if (loginSkipped === null) {
    rec.check(
      `${prefix}.answers`,
      said.at !== null,
      said.at !== null ? "the first turn answered" : (said.limit ?? "no answer within 4 min"),
    );
  } else {
    rec.check(`${prefix}.answers`, null, `skipped: ${loginSkipped}`);
  }
  if (container === null) {
    rec.note(`${prefix}: the executor was not checked (no host access, or not found)`);
    return null;
  }
  const probe = parsePersonProbe(
    await ctx.host.shell(asPersonCommand(container, accountId, PERSON_PROBE_SH)),
  );
  const profile = harness === "pi" ? await api.get("/me/pi-profile").catch(() => null) : null;
  for (const verdict of personVerdicts({
    probe,
    harness,
    agentSaid: said.value || null,
    piDigest: harness === "pi" ? (profile?.profile?.digest ?? null) : undefined,
    otherPiDigest: other?.piDigest,
    otherUid: other?.uid ?? null,
    loginSkipped,
  })) {
    rec.check(`${prefix}.${verdict.name}`, verdict.ok, verdict.detail);
  }
  return { uid: probe.uid, piDigest: profile?.profile?.digest ?? null };
};

/**
 * Per-person correctness (docs/adr/0016, decisions 1, 2 and 5), recorded as checks, never as
 * timings: for each harness a person launch whose agent must run as a uid of the person range
 * with its own home and answer; pi's profile must be the person's own; pi's and opencode's
 * ChatGPT login must be in their home. For pi, the second account then joins, and its pi must
 * have its own profile and not the first account's.
 */
const personChecksOn = async (ctx, harness) => {
  const name = `${PREFIX}${ctx.rid}-check-${harness}`;
  const first = await personLaunch(ctx, {
    harness,
    name,
    api: ctx.api,
    prompt: IDENTITY_PROMPT,
    layout: "person",
  });
  let joined = null;
  try {
    const container = ctx.host === null ? null : await executorOf(ctx.host, first.session.id);
    const firstPerson = await checkPerson(ctx, `person.${harness}`, {
      harness,
      session: first.session,
      agent: first.agent,
      container,
      api: ctx.api,
      other: null,
    });
    if (harness !== "pi") return;
    if (ctx.api2 === null) {
      ctx.rec.note("person.pi.joined: not checked (no second account: pass --second-token-file)");
      return;
    }
    joined = await personLaunch(ctx, { harness, name, api: ctx.api2, prompt: IDENTITY_PROMPT });
    if (joined.session.worktreeId !== first.session.worktreeId) {
      throw new Error("the second account's pi session did not join the first one's worktree");
    }
    await checkPerson(ctx, "person.pi.joined", {
      harness,
      session: joined.session,
      agent: joined.agent,
      container,
      api: ctx.api2,
      other: firstPerson,
    });
  } finally {
    if (joined !== null) {
      await stopAndSettle(ctx, joined.session.id, 600_000, ctx.api2).catch((error) =>
        ctx.log(`person.pi.joined · stop: ${error.message}`),
      );
    }
    await removeWorktree(ctx, first.session.worktreeId).catch((error) =>
      ctx.rec.error(`cleanup · person.${harness}`, error),
    );
  }
};

const personChecks = async (ctx) => {
  if (ctx.host === null) {
    ctx.rec.note(
      "person checks: the executor is not probed without the server's host (pass --ssh); only the API's runsAs and the answers are checked",
    );
  }
  for (const harness of ctx.opts.harnesses) {
    await personChecksOn(ctx, harness).catch((error) => ctx.rec.error(`person.${harness}`, error));
  }
};

// ─── cleanup ────────────────────────────────────────────────────────────────

/** Stops every live session of a worktree and removes it (forced: its change is ours to drop). */
const removeWorktree = async (ctx, worktreeId) => {
  const detail = await ctx.api.get(`/worktrees/${worktreeId}`).catch(() => null);
  if (detail === null) return;
  for (const session of detail.sessions ?? []) {
    if (session.settledAt === null) {
      // The second account's session in a worktree of the first is stopped by its owner when the
      // first account may not.
      await stopAndSettle(ctx, session.id, 900_000)
        .catch((error) => {
          if (ctx.api2 === null || !(error instanceof ApiError) || error.status !== 403)
            throw error;
          return stopAndSettle(ctx, session.id, 900_000, ctx.api2);
        })
        .catch((error) => ctx.rec.error(`cleanup · stop ${session.id.slice(0, 8)}`, error));
    }
  }
  await ctx.api.delete(`/worktrees/${worktreeId}?force=true`);
};

/**
 * Every `st-bench-` worktree of the project, this run's or a crashed one's, stopped and removed;
 * the benchmark's secret file removed. Never touches anything without the prefix.
 */
export const cleanupAll = async (ctx) => {
  const listing = await ctx.api.get(`/projects/${ctx.project.id}/worktrees`);
  for (const worktree of listing.worktrees ?? []) {
    if (!worktree.name.startsWith(PREFIX)) continue;
    try {
      await removeWorktree(ctx, worktree.id);
      ctx.log(`cleanup · removed worktree ${worktree.name}`);
    } catch (error) {
      ctx.rec.error(`cleanup · worktree ${worktree.name}`, error);
    }
  }
  const secrets = await ctx.api.get("/me/secret-files").catch(() => ({ files: [] }));
  for (const file of secrets.files ?? []) {
    if (file.path === SECRET_PATH) {
      await ctx.api
        .delete(`/me/secret-files?path=${encodeURIComponent(SECRET_PATH)}`)
        .catch((error) => ctx.rec.error("cleanup · secret file", error));
    }
  }
  if (ctx.created.remoteRefs.size > 0) {
    ctx.rec.note(
      `remote branches pushed and not deleted, remove by hand: ${[...ctx.created.remoteRefs].join(", ")}`,
    );
  }
};

// ─── the plan ───────────────────────────────────────────────────────────────

/** Puts the benchmark's secret file in place so its delivery is timed; false when one was there. */
const placeSecretFile = async (ctx) => {
  const existing = await ctx.api.get("/me/secret-files");
  if ((existing.files ?? []).some((file) => file.path === SECRET_PATH)) {
    ctx.rec.note(`a secret file at ${SECRET_PATH} already exists; left as it is`);
    return;
  }
  await ctx.api.put("/me/secret-files", {
    path: SECRET_PATH,
    encoding: "utf8",
    contents: "st-bench: a secret file to time its delivery\n",
  });
  ctx.created.secretFile = true;
};

/** Whether the second account can reach the project at all; the reason when it cannot. */
const secondAccountBlocker = async (ctx) => {
  if (ctx.api2 === null) {
    return "second account not yet joined (no token for it: pass --second-token-file)";
  }
  try {
    await ctx.api2.get(`/projects/${ctx.project.id}`);
    return null;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return `second account not yet joined to a shared project (it cannot see ${ctx.project.name}, which is ${ctx.project.visibility ?? "private"})`;
    }
    throw error;
  }
};

/**
 * Every selected scenario, `runs` times. Each run launches a new session per harness (only the
 * first harness when `new` is not selected: it is then just the live session the other scenarios
 * need), measures what rides on it, stops it (the Stop's save) and removes its worktree. The first
 * harness's session also carries the joins, the resume and, on the first run, the interactive and
 * API scenarios, which repeat inside themselves. Then the per-person scenarios (hand-over, growth,
 * person checks), each on person worktrees of its own; they need `--layout person`, and the
 * hand-over and growth a second account.
 */
export const runAll = async (ctx) => {
  const { opts, rec } = ctx;
  const selected = (scenario) => opts.only.includes(scenario);
  if (opts.secretFile) await placeSecretFile(ctx);
  let otherBlocker = null;
  if (selected("join-other") || selected("handover") || selected("growth")) {
    otherBlocker = await secondAccountBlocker(ctx);
  }
  if (selected("join-other") && otherBlocker !== null) {
    rec.notRun("join.other.first_output", otherBlocker);
    ctx.log(`join-other · not run: ${otherBlocker}`);
  }
  // What only a person worktree has, each with what it needs; run after the launches.
  const perPerson = PERSON_SCENARIOS.filter(selected).filter((scenario) => {
    const measure = { handover: "handover.*", growth: "growth.*", "person-checks": "person.*" }[
      scenario
    ];
    const blocker =
      opts.layout !== "person"
        ? "per-person only: run with --layout person"
        : scenario !== "person-checks" && otherBlocker !== null
          ? otherBlocker
          : scenario === "growth" && ctx.host === null
            ? "sizes a saved directory in the executor: needs the server's host (pass --ssh or run there)"
            : null;
    if (blocker !== null) {
      rec.notRun(measure, blocker);
      ctx.log(`${scenario} · not run: ${blocker}`);
    }
    return blocker === null;
  });
  const launches = opts.only.some(
    (scenario) =>
      !PERSON_SCENARIOS.includes(scenario) && !(scenario === "join-other" && otherBlocker !== null),
  );
  if (launches) await runLaunches(ctx, otherBlocker);
  for (const scenario of perPerson) {
    const run = { handover, growth, "person-checks": personChecks }[scenario];
    await run(ctx).catch((error) => rec.error(scenario, error));
  }
};

/** The launch scenarios (`new` and what rides on its sessions), `runs` times. */
const runLaunches = async (ctx, otherBlocker) => {
  const { opts, rec } = ctx;
  const selected = (scenario) => opts.only.includes(scenario);
  const primaryHarness = opts.harnesses[0];
  const harnesses = selected("new") || selected("stop") ? opts.harnesses : [primaryHarness];
  for (let run = 1; run <= opts.runs; run += 1) {
    for (const harness of harnesses) {
      const isPrimary = harness === primaryHarness;
      let primary = null;
      try {
        primary = await newSession(ctx, harness, run);
        const live = primary;
        // What rides on the first harness's live session, joins first: on 0.36.0-next.601 an
        // executor is replaced about two minutes after it starts ("planned drain due ·
        // fallback"), which ends the shells, and a join after it launches cold. Joins that find no
        // live executor are kept apart (`first_output_cold`).
        const extras = async () => {
          if (selected("join-same")) {
            for (let k = 1; k <= opts.joinsPerRun; k += 1) {
              await joinSamePerson(ctx, live, `${run}.${k}`).catch((error) =>
                rec.error("join.same", error),
              );
            }
          }
          if (selected("join-other") && otherBlocker === null) {
            for (let k = 1; k <= opts.joinsPerRun; k += 1) {
              await joinOtherPerson(ctx, live, `${run}.${k}`).catch((error) =>
                rec.error("join.other", error),
              );
            }
          }
          if (run === 1 && selected("interactive")) {
            await interactive(ctx, live).catch((error) => rec.error("interactive", error));
          }
          if (run === 1 && selected("api")) {
            await apiLatency(ctx, live.session.id).catch((error) => rec.error("api", error));
          }
        };
        const resumes = isPrimary && selected("resume") ? opts.resumesPerRun : 0;
        if (isPrimary && resumes === 0) await extras();
        const stop = await stopAndSettle(ctx, primary.session.id);
        await recordStop(
          ctx,
          `stop.${harness}`,
          {
            stop,
            sessionId: primary.session.id,
            container: primary.container,
            follower: primary.follower,
          },
          true,
        );
        primary.follower = null;
        ctx.log(
          `${harness} #${run} · stop settled ${((stop.settledAt - stop.startedAt) / 1000).toFixed(1)} s`,
        );
        if (resumes > 0) {
          for (let k = 1; k <= resumes; k += 1) {
            const resumed = await resume(ctx, primary, `${run}.${k}`);
            primary.agent = resumed.agent;
            if (k === resumes) await extras();
            const again = await stopAndSettle(ctx, primary.session.id);
            await recordStop(
              ctx,
              "stop.after_resume",
              {
                stop: again,
                sessionId: primary.session.id,
                container: resumed.container,
                follower: resumed.follower,
              },
              false,
            );
          }
        }
      } catch (error) {
        rec.error(`${harness} #${run}`, error);
      } finally {
        await primary?.follower?.stop();
        const worktreeId =
          primary?.session.worktreeId ??
          ctx.created.worktrees.get(`${PREFIX}${ctx.rid}-${harness}-${run}`);
        if (worktreeId !== undefined) {
          await removeWorktree(ctx, worktreeId).catch((error) =>
            rec.error(`cleanup · ${harness} #${run}`, error),
          );
        }
      }
    }
  }
};
