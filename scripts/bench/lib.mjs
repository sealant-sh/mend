// The pure half of the benchmark (docs/adr/0016, "Performance"): statistics, log parsing, the
// budgets and their comparison, and the tables. Nothing here reads the network, a clock or a file,
// so all of it is unit-tested (lib.test.mjs).

import { createHash } from "node:crypto";

// ─── statistics ─────────────────────────────────────────────────────────────

/** The q-quantile of an ascending array, interpolated between neighbours (R type 7, numpy's default). */
export const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
};

/**
 * What the tables and the budgets read from a measure's samples. Every measure here is "lower is
 * better" (time, bytes, counts), so `worst` is the largest sample.
 */
export const summarize = (samples) => {
  const values = samples.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return { n: 0, median: null, p90: null, worst: null, best: null, mean: null, spread: null };
  }
  const sorted = values.toSorted((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const worst = sorted[sorted.length - 1];
  return {
    n: sorted.length,
    median,
    p90: quantile(sorted, 0.9),
    worst,
    best: sorted[0],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    spread: worst - median,
  };
};

// ─── text ───────────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const CHARSET = new RegExp(`${ESC}[()][0-9A-Za-z]`, "g");
const SHORT = new RegExp(`${ESC}[78=>cDEHMNOZ]`, "g");

/** Terminal output as plain text: CSI, OSC, charset and keypad sequences removed. */
export const stripAnsi = (text) =>
  text.replace(OSC, "").replace(CSI, "").replace(CHARSET, "").replace(SHORT, "");

/** A docker size ("3.59GB", "1.094GiB", "102kB", "0B") in bytes; null when it is not one. */
export const parseDockerSize = (text) => {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGT]?i?B)\s*$/.exec(text ?? "");
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const binary = unit.includes("i");
  const base = binary ? 1024 : 1000;
  const power = { B: 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[unit[0]] ?? 0;
  return Math.round(value * base ** power);
};

/** `docker ps -s` → the writable layer's size ("3.59GB (virtual 6.69GB)" → 3590000000). */
export const parseContainerDisk = (text) => parseDockerSize((text ?? "").split("(")[0]);

/** `docker stats` MemUsage ("1.094GiB / 39.17GiB") → the used bytes. */
export const parseMemUsage = (text) => parseDockerSize((text ?? "").split("/")[0]);

// ─── Mend's log (docker logs -t of the Mend container) ──────────────────────

const VALUE = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^,{}\s][^,{}]*)/;
const FIELD = new RegExp(`(?:^|[\\s{,])'?([A-Za-z_][\\w.]*)'?:\\s*${VALUE.source}`, "g");

const fieldValue = (raw) => {
  const text = raw.trim();
  if (/^'.*'$/s.test(text) || /^".*"$/s.test(text)) {
    return text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (text === "null" || text === "undefined") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
};

/** `key: 'value'` pairs out of a pretty-printed log object, flattened; nested keys keep their own names. */
export const parseFields = (body) => {
  const fields = {};
  for (const match of body.matchAll(FIELD)) {
    if (!(match[1] in fields)) fields[match[1]] = fieldValue(match[2]);
  }
  return fields;
};

const HEADER =
  /^\[(\d\d:\d\d:\d\d\.\d+)\]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*(?:\(#(\d+)\))?\s*(?:http\.span=(\d+)ms)?\s*:\s?(.*)$/;

/**
 * Mend's log as blocks: one per entry, with the docker timestamp of its first line (ms since the
 * epoch), the level, the fiber, the HTTP span when the entry ran inside a request (ms since that
 * request began), the message and its fields. Lines that are not entries (the bundle's own
 * startup lines) are skipped.
 */
export const parseMendLog = (text) => {
  const blocks = [];
  let current = null;
  const close = () => {
    if (current === null) return;
    current.fields = parseFields(current.body.join("\n"));
    delete current.body;
    blocks.push(current);
    current = null;
  };
  for (const rawLine of text.split("\n")) {
    const line = stripAnsi(rawLine);
    const stamped = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/.exec(line);
    if (stamped === null) continue;
    const at = Date.parse(stamped[1]);
    const rest = stamped[2];
    const header = HEADER.exec(rest);
    if (header !== null) {
      close();
      const message = header[5];
      const brace = message.indexOf(" {");
      current = {
        at,
        level: header[2],
        fiber: header[3] === undefined ? null : Number(header[3]),
        spanMs: header[4] === undefined ? null : Number(header[4]),
        message: (brace === -1 ? message : message.slice(0, brace)).trim(),
        body: brace === -1 ? [] : [message.slice(brace)],
      };
      continue;
    }
    if (current !== null) current.body.push(rest);
  }
  close();
  return blocks;
};

/** A Sealant API request line inside Mend's log ("Sent HTTP response" with method, url, status). */
export const httpOf = (block) =>
  block.message === "Sent HTTP response" && typeof block.fields["http.url"] === "string"
    ? {
        method: block.fields["http.method"],
        url: block.fields["http.url"],
        status: block.fields["http.status"],
      }
    : null;

/** How many commands the session engine ran in a workspace between two instants. */
export const execCount = (blocks, workspaceId, fromMs, toMs) =>
  blocks.filter((block) => {
    const http = httpOf(block);
    return (
      http !== null &&
      http.method === "POST" &&
      http.url === `/v1/workspaces/${workspaceId}/exec` &&
      block.at >= fromMs &&
      block.at <= toMs
    );
  }).length;

/** The time of the first command in a workspace after an instant: the executor answered. */
export const firstExecAt = (blocks, workspaceId, fromMs) =>
  blocks.find((block) => {
    const http = httpOf(block);
    return (
      http !== null &&
      http.method === "POST" &&
      http.url === `/v1/workspaces/${workspaceId}/exec` &&
      block.at >= fromMs
    );
  })?.at ?? null;

/** A milestone's name: the engine's message without its prefix and its trailing evidence word. */
export const milestoneName = (message) =>
  message
    .replace(/^session engine:\s*/, "")
    .replace(/^capture mode:\s*/, "capture mode · ")
    .replace(/\s*·\s*observed$/, "")
    .replace(/\s*·\s*exit -?\d+$/, "")
    .replace(/\s*\{.*$/, "")
    .trim();

/**
 * The session engine's milestones for one session or workspace, in order, deduplicated by name
 * (the workspace note is logged once per harness file). These are what a launch, a resume or a
 * Stop is broken into.
 */
export const milestonesOf = (blocks, { sessionId, workspaceId, fromMs, toMs }) => {
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    if (block.at < fromMs || block.at > toMs) continue;
    if (!/^(session engine|capture mode):/.test(block.message)) continue;
    const ours =
      (sessionId !== undefined && block.fields.sessionId === sessionId) ||
      (workspaceId !== undefined && block.fields.workspaceId === workspaceId);
    if (!ours) continue;
    const name = milestoneName(block.message);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, at: block.at, level: block.level, fields: block.fields });
  }
  return out;
};

/**
 * Consecutive milestones as steps: each step is the time from the one before (or from `startMs`)
 * to this one, named for where it ends ("→ dependency install · completed"). Steps measured
 * before `startMs` are dropped.
 */
export const stepsOf = (startMs, milestones) => {
  const steps = [];
  let previous = startMs;
  for (const milestone of milestones.toSorted((a, b) => a.at - b.at)) {
    if (milestone.at < startMs) continue;
    steps.push({ name: milestone.name, ms: milestone.at - previous });
    previous = milestone.at;
  }
  return steps;
};

const DELIVERED = /^(agent memory · delivered|secret file · written)/;

/**
 * The delivery window of a launch: from the harness warm-up (a cold launch reads the harness's
 * home first) or, when there is none (a join of a live executor), from the milestone just before
 * the first delivery, to the last of memory and secret files. Skills log nothing of their own and
 * fall inside it. Null when nothing was delivered.
 */
export const deliveryWindow = (milestones) => {
  const ordered = milestones.toSorted((a, b) => a.at - b.at);
  const ends = ordered.filter((m) => DELIVERED.test(m.name));
  if (ends.length === 0) return null;
  const firstEnd = ends[0].at;
  const before = ordered.filter((m) => m.at <= firstEnd && !DELIVERED.test(m.name));
  const start =
    before.find((m) => m.name.startsWith("harness warm-up")) ??
    before.find((m) => m.name.startsWith("default shell profile")) ??
    before.at(-1);
  if (start === undefined) return null;
  return ends.at(-1).at - start.at;
};

/** A harness's version from its own first screen ("Claude Code v2.1.287"), or null. */
export const harnessVersionOf = (screen) => {
  const claude = /Claude Code\s*v(\d+\.\d+\.\d+)/.exec(screen);
  if (claude !== null) return { harness: "claude", version: claude[1] };
  const codex = /OpenAI Codex \(v(\d+\.\d+\.\d+)\)/.exec(screen);
  if (codex !== null) return { harness: "codex", version: codex[1] };
  return null;
};

/**
 * A harness's own words that its account refused the turn for a usage limit until it resets
 * ("You've hit your weekly limit · resets 6pm (UTC)", "Usage limit reached", "5-hour limit reached
 * ∙ resets 3am"): the line, or null. A request-rate 429 the harness retries on its own ("Rate limit
 * reached … Please try again in 2.1s.; retrying 1/5") is not one, nor is a line that says it is
 * retrying: the agent is still in its turn. A TUI may draw its spaces as cursor moves, so each line
 * is also read with its whitespace gone.
 */
const USAGE_LIMITS = [
  /you(?:'|’)ve hit your [\w-]+(?: [\w-]+)? limit[^\r\n]*/i,
  /usage limit (?:reached|exceeded)[^\r\n]*/i,
  /\b(?:\d+-hour|weekly|daily|session) limit reached[^\r\n]*/i,
];
const USAGE_LIMITS_COMPACT = [
  /you(?:'|’)vehityour[\w-]{0,24}limit/i,
  /usagelimit(?:reached|exceeded)/i,
  /(?:\d+-hour|weekly|daily|session)limitreached/i,
];
/** A line about a retry the harness makes by itself, spaced or not. */
const RETRYING =
  /retrying|retry ?in\b|try ?again ?in ?\d+(?:\.\d+)? ?(?:ms|s|sec|secs|seconds?)\b/i;
export const usageLimitOf = (text) => {
  for (const line of text.split(/\r?\n|\r/)) {
    if (RETRYING.test(line)) continue;
    for (const pattern of USAGE_LIMITS) {
      const match = pattern.exec(line);
      if (match !== null) return match[0].replace(/\s+/g, " ").trim().slice(0, 160);
    }
    const compact = line.replace(/\s+/g, "");
    for (const pattern of USAGE_LIMITS_COMPACT) {
      const match = pattern.exec(compact);
      if (match !== null) return match[0];
    }
  }
  return null;
};

/**
 * Docker's `Created` ("2026-10-06T18:03:20.123456789Z") in epoch ms; null when it is not a time
 * or is the zero time a reproducible build stamps.
 */
export const parseDockerTime = (text) => {
  const match = /^\s*(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)\s*$/.exec(
    text ?? "",
  );
  if (match === null) return null;
  const ms = Date.parse(`${match[1]}.${(match[2] ?? "0").padEnd(3, "0").slice(0, 3)}${match[3]}`);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/**
 * Whether an image was made inside a launch's window (its request to its first output, local
 * time): that launch waited for a workspace image build, and its start numbers are kept apart.
 */
export const builtWithin = (createdMs, fromMs, toMs) =>
  createdMs !== null && createdMs >= fromMs && createdMs <= toMs;

/** The Sealant worker's line for a Stop's drain: what the executor uploaded and registered. */
export const parseDrainLine = (message) => {
  const match =
    /Capture drain \(([^)]*)\) · run ([0-9a-f-]+): saved · pending (\d+) · (\d+) bytes to ship · staged (\d+) bytes · uploaded (\d+) bytes · registered (\d+)/.exec(
      message,
    );
  if (match === null) return null;
  return {
    why: match[1],
    executor: match[2],
    pending: Number(match[3]),
    toShipBytes: Number(match[4]),
    stagedBytes: Number(match[5]),
    uploadedBytes: Number(match[6]),
    registered: Number(match[7]),
  };
};

/** "Workspace image plan unchanged (hash …); …, reusing sha256:…" → the image the executor ran. */
export const parseImageLine = (message) => {
  const match = /Workspace image plan (\w+) \(hash ([0-9a-f]+)\).*?(sha256:[0-9a-f]+)/.exec(
    message,
  );
  return match === null ? null : { plan: match[1], hash: match[2], image: match[3] };
};

// ─── sealantd's log (docker logs -t of an executor) ─────────────────────────

/**
 * sealantd's tracing lines: `<docker ts> <sealantd ts>  INFO target: message k=v k=v`. The
 * message is everything before the first `key=`.
 */
export const parseSealantdLog = (text) => {
  const events = [];
  for (const rawLine of text.split("\n")) {
    const line = stripAnsi(rawLine);
    const match =
      /^\S+Z\s+(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s(.*)$/.exec(
        line,
      );
    if (match === null) continue;
    const rest = match[4];
    const firstField = rest.search(/\s[A-Za-z_]\w*=/);
    const message = (firstField === -1 ? rest : rest.slice(0, firstField)).trim();
    const fields = {};
    for (const field of rest.matchAll(/\s([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
      const raw = field[2].replace(/^"(.*)"$/s, "$1");
      fields[field[1]] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
    events.push({ at: Date.parse(match[1]), level: match[2], target: match[3], message, fields });
  }
  return events;
};

/**
 * What an executor restored at boot: the capture head's bytes and files, and the time from the
 * plan's arrival to the head on disk (sealantd logs no elapsed time of its own for it).
 */
export const restoreOf = (events) => {
  const materialized = events.find((event) => event.message === "capture head materialized");
  if (materialized === undefined) return null;
  const plan = events.find((event) => event.message === "capture plan fetched");
  const elapsed = materialized.fields.elapsed_ms;
  return {
    ms:
      typeof elapsed === "number" ? elapsed : plan === undefined ? null : materialized.at - plan.at,
    bytes: materialized.fields.bytes ?? null,
    files: materialized.fields.files ?? null,
    head: plan?.fields.head ?? null,
  };
};

/** Bytes staged per capture class while the executor ran ("capture staged … class=Small"). */
export const stagedBytesOf = (events) => {
  const totals = {};
  for (const event of events) {
    if (event.message !== "capture staged") continue;
    const kind = String(event.fields.class ?? "unknown").toLowerCase();
    totals[kind] = (totals[kind] ?? 0) + (Number(event.fields.staged_bytes) || 0);
  }
  return totals;
};

// ─── budgets (docs/adr/0016, "Budgets") ─────────────────────────────────────

/**
 * Each class is one row of the ADR's budget table. `pct` and `abs` give the allowed increase as
 * the larger of a share of the baseline and a fixed amount (in the measure's unit); `spread`
 * allows the baseline's own noise (worst minus median) with a floor.
 */
export const BUDGETS = {
  start: { pct: 0.05, abs: 1000, text: "+5% or +1 s" },
  "join-other": { pct: 0, abs: 3000, text: "+3 s" },
  bytes: { pct: 0.05, abs: 0, text: "+5%" },
  delivery: { pct: 0.05, abs: 500, text: "+5% or +0.5 s" },
  interactive: { spread: true, abs: 50, text: "noise: max(worst − median, 50 ms)" },
  resource: { pct: 0.05, abs: 0, text: "+5%" },
  api: { pct: 0.05, abs: 20, text: "+5% or +20 ms" },
  // Fixed ceilings, checked on the run under test alone (a `shared` record has no hand-over and no
  // second person's saved directory to compare against).
  handover: { ceiling: 5000, text: "under 5 s" },
  growth: { ceiling: 64 * 1024, text: "at most 64 KB" },
};

/** Whether a budget is a fixed ceiling rather than an allowance over a baseline. */
const isCeiling = (budgetKey) => typeof BUDGETS[budgetKey]?.ceiling === "number";

/** The increase a budget allows over one statistic of the baseline. */
export const allowance = (budgetKey, before, stat) => {
  const budget = BUDGETS[budgetKey];
  if (budget === undefined || isCeiling(budgetKey)) return null;
  if (budget.spread === true) return Math.max(before.spread ?? 0, budget.abs);
  return Math.max((before[stat] ?? 0) * budget.pct, budget.abs);
};

/**
 * Two result files against the budgets. Every budgeted measure of the baseline is checked on each
 * named statistic (the median and the p90 by default, as review r4 of the ADR asks; the worst
 * only when asked). A measure the baseline has and the other run lacks is a miss: a number that
 * was not taken cannot be inside its limit.
 */
export const compareResults = (before, after, { stats = ["median", "p90"] } = {}) => {
  const rows = [];
  const incomparable = [];
  const sampledBefore = resourcesSampledAt(before);
  const sampledAfter = resourcesSampledAt(after);
  for (const [name, measure] of Object.entries(before.measures ?? {})) {
    if (
      measure.budget === undefined ||
      measure.budget === null ||
      BUDGETS[measure.budget] === undefined ||
      isCeiling(measure.budget)
    ) {
      continue;
    }
    const baseline = summarize(measure.samples ?? []);
    if (baseline.n === 0) continue;
    const other = after.measures?.[name];
    // An executor's size taken at another point of its launch is another number.
    if (EXECUTOR_RESOURCE.test(name)) {
      const at = [measure.sampledAt ?? sampledBefore, other?.sampledAt ?? sampledAfter];
      if (at[0] !== at[1]) {
        incomparable.push({ measure: name, reason: `sampled ${at[0]} before and ${at[1]} after` });
        continue;
      }
    }
    const current = summarize(other?.samples ?? []);
    const notRun = current.n === 0 ? notRunReasonOf(after, name) : null;
    for (const stat of stats) {
      const allowed = allowance(measure.budget, baseline, stat);
      const limit = baseline[stat] + allowed;
      const value = current.n === 0 ? null : current[stat];
      rows.push({
        measure: name,
        unit: measure.unit,
        budget: measure.budget,
        stat,
        before: baseline[stat],
        after: value,
        limit,
        ok: value !== null && value <= limit,
        missing: value === null,
        ...(notRun === null ? {} : { notRun }),
      });
    }
  }
  // A ceiling is checked on the run under test, whatever the baseline holds: a measure either
  // record budgets that way, and the other run lacks, is a miss.
  const ceilings = new Map();
  for (const record of [after, before]) {
    for (const [name, measure] of Object.entries(record.measures ?? {})) {
      if (isCeiling(measure.budget) && !ceilings.has(name)) ceilings.set(name, measure);
    }
  }
  for (const [name, measure] of ceilings) {
    const current = summarize(after.measures?.[name]?.samples ?? []);
    const notRun = current.n === 0 ? notRunReasonOf(after, name) : null;
    for (const stat of stats) {
      const value = current.n === 0 ? null : current[stat];
      const limit = BUDGETS[measure.budget].ceiling;
      rows.push({
        measure: name,
        unit: measure.unit,
        budget: measure.budget,
        stat,
        before: null,
        after: value,
        limit,
        ok: value !== null && value <= limit,
        missing: value === null,
        ...(notRun === null ? {} : { notRun }),
      });
    }
  }
  for (const [name, companion] of Object.entries(before.companions ?? {})) {
    const theirs = after.companions?.[name] ?? { measures: {} };
    const compared = compareResults(companion, theirs, { stats });
    for (const row of compared.rows) {
      rows.push({ ...row, measure: `${name}: ${row.measure}` });
    }
    for (const entry of compared.incomparable) {
      incomparable.push({ ...entry, measure: `${name}: ${entry.measure}` });
    }
  }
  return {
    rows,
    misses: rows.filter((row) => !row.ok),
    incomparable,
    label: describeComparison(before, after),
    // A correctness check the run under test failed fails the comparison too: a fast launch that
    // ran as the wrong person, or billed the wrong login, is not inside any budget.
    checkFailures: failedChecks(after),
  };
};

// ─── layouts and what a comparison is ───────────────────────────────────────

/**
 * The harness layout a record's launches asked for (`--layout`), or what the server's flag said
 * when they asked for none (docs/adr/0016, decision 14). Null when neither says.
 */
export const layoutOf = (result) => {
  const asked = result.options?.layout ?? result.target?.layout ?? null;
  if (asked === "person" || asked === "shared") return asked;
  return /^(person|shared)\b/.exec(result.target?.flag ?? "")?.[1] ?? null;
};

/**
 * What a comparison stands for, in words, with what keeps it from standing for that. Gate P1
 * (docs/adr/0016, "Method") is `person` launches against `shared` launches at the same commit, on
 * the same instance, images and harness versions; `shared` against an older `shared` record is its
 * named check; anything else is a plain before-and-after.
 */
const describeRecord = (result, layout) =>
  `${layout ?? "layout unknown"} · ${result.target?.version ?? "version unknown"}${
    result.target?.commit ? ` (${String(result.target.commit).slice(0, 9)})` : ""
  }`;

export const describeComparison = (before, after) => {
  const layouts = [layoutOf(before), layoutOf(after)];
  const versions = [before.target?.version ?? null, after.target?.version ?? null];
  const warnings = [];
  const sameVersion = versions[0] !== null && versions[0] === versions[1];
  const sameCommit =
    (before.target?.commit ?? null) === (after.target?.commit ?? null) || !before.target?.commit;
  if (!sameVersion || !sameCommit) {
    warnings.push(
      `the two records are of different builds (${versions[0] ?? "?"} and ${versions[1] ?? "?"})`,
    );
  }
  if ((before.target?.url ?? null) !== (after.target?.url ?? null)) {
    warnings.push(
      `the two records are of different instances (${before.target?.url} and ${after.target?.url})`,
    );
  }
  if ((before.target?.project?.id ?? null) !== (after.target?.project?.id ?? null)) {
    warnings.push("the two records ran on different projects");
  }
  if ((before.target?.workspaceImage ?? null) !== (after.target?.workspaceImage ?? null)) {
    warnings.push(
      `the workspace images differ (${before.target?.workspaceImage ?? "?"} and ${after.target?.workspaceImage ?? "?"})`,
    );
  }
  for (const [harness, version] of Object.entries(after.target?.harnessVersions ?? {})) {
    const theirs = before.target?.harnessVersions?.[harness];
    if (theirs !== undefined && theirs !== version) {
      warnings.push(`${harness} ran ${theirs} before and ${version} after`);
    }
  }
  let kind = "before and after";
  if (layouts[0] === "shared" && layouts[1] === "person") {
    kind = "gate P1: person launches against shared launches";
    if (!sameVersion || !sameCommit) kind += " (not the gate: not the same build)";
  } else if (layouts[0] === "person" && layouts[1] === "shared") {
    kind = "shared launches against person launches (reversed: the gate puts shared first)";
  } else if (layouts[0] === "shared" && layouts[1] === "shared" && !sameVersion) {
    kind = "gate P1's named check: shared launches against an earlier shared record";
  } else if (layouts[0] !== null && layouts[0] === layouts[1]) {
    kind = `${layouts[0]} launches, before and after`;
  }
  return {
    kind,
    before: describeRecord(before, layouts[0]),
    after: describeRecord(after, layouts[1]),
    layouts,
    warnings,
  };
};

// ─── correctness checks (recorded beside the timings, never as one) ─────────

/** The checks a record failed. */
export const failedChecks = (result) => (result.checks ?? []).filter((check) => check.failed > 0);

/**
 * One check observed once more: passes and failures are counted per check, with the first few
 * failures' details kept, so ten rounds of a hand-over are ten observations of one check. `ok`
 * null is a check that could not be made (its reason in `detail`): skipped, neither held nor
 * failed.
 */
export const tallyCheck = (checks, name, ok, detail = null) => {
  let entry = checks.find((check) => check.check === name);
  if (entry === undefined) {
    entry = { check: name, passed: 0, failed: 0, skipped: 0, detail: null, failures: [] };
    checks.push(entry);
  }
  if (ok === null) {
    entry.skipped = (entry.skipped ?? 0) + 1;
    entry.detail ??= detail;
  } else if (ok) {
    entry.passed += 1;
    if (detail !== null) entry.detail = detail;
  } else {
    entry.failed += 1;
    if (detail !== null && entry.failures.length < 5) entry.failures.push(detail);
  }
  return entry;
};

// ─── a protocol turn (docs/adr/0016, decision 6) ────────────────────────────

const AGENT_KINDS = new Set(["agent-pty", "agent-protocol", "agent-external"]);
const LIVE_STATUSES = new Set(["starting", "running", "reachable", "unreachable"]);

/** The agent processes of a session view that have not ended. */
export const liveAgents = (processes) =>
  (processes ?? []).filter(
    (process) =>
      AGENT_KINDS.has(process.kind) &&
      (process.exitedAt === null || process.exitedAt === undefined) &&
      LIVE_STATUSES.has(process.status),
  );

/** Whether a turn has ended (any way). */
export const turnEnded = (turn) =>
  ["completed", "interrupted", "failed", "cancelled"].includes(turn?.status);

/**
 * A turn's times, all on the server's clock and all from its creation (the submit as the server
 * received it): to `startedAt` (the hand-over, when the sender changed), to the first thing the
 * agent said or did for it (an item of that turn other than the person's message), and to its end
 * when it completed. Null where the record does not say.
 */
export const turnTimes = (turn, items = []) => {
  const created = Date.parse(turn.createdAt);
  const since = (iso) => {
    const at = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(at) && Number.isFinite(created) ? at - created : null;
  };
  const first = items
    .filter((item) => item.turnId === turn.id && item.kind !== "user-message")
    .map((item) => item.createdAt)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    started: since(turn.startedAt),
    firstOutput: first === undefined ? null : since(first),
    completed: turn.status === "completed" ? since(turn.endedAt) : null,
  };
};

/**
 * What one steered turn must show (docs/adr/0016, decision 6): it ran on its sender's login
 * (`billedUserId`), on a process that runs as its sender (`runsAs`), from the person expected
 * (the owner, or someone else), with one agent at a time while it ran, and it answered.
 */
export const turnVerdicts = ({ turn, process, ownerId, fromOwner, maxLive, answer, items }) => {
  const sender = turn.author ?? null;
  const said = (items ?? [])
    .filter((item) => item.turnId === turn.id && item.kind === "assistant-message")
    .map((item) => item.text ?? "")
    .join("\n");
  return [
    {
      name: "sender",
      ok: sender !== null && (fromOwner ? sender === ownerId : sender !== ownerId),
      detail: `sent by ${sender ?? "nobody recorded"} (${fromOwner ? "the owner" : "another person"} expected)`,
    },
    {
      name: "billed",
      ok: sender !== null && turn.billedUserId === sender,
      detail: `billed to ${turn.billedUserId ?? "nobody"}${turn.billedAccountName ? ` · ${turn.billedAccountName}` : ""}, sent by ${sender ?? "?"}`,
    },
    {
      name: "runs_as",
      ok: sender !== null && process !== null && process.runsAs === sender,
      detail: `process ${process?.id?.slice(0, 8) ?? "not found"} runs as ${process?.runsAs ?? "nobody recorded"}, sent by ${sender ?? "?"}`,
    },
    {
      name: "one_agent",
      ok: maxLive <= 1,
      detail: `at most ${maxLive} agent process(es) live at once while it ran`,
    },
    {
      name: "completed",
      ok: turn.status === "completed",
      detail: `${turn.status}${turn.error ? `: ${turn.error}` : ""}`,
    },
    {
      name: "answers",
      ok: said.includes(answer),
      detail: said.includes(answer) ? `answered ${answer}` : `no ${answer} in what it said`,
    },
  ];
};

// ─── a person in an executor (docs/adr/0016, decisions 1, 2 and 5) ───────────

/**
 * A pi profile's digest as Mend stores it (`piProfileDigest`, packages/db/src/repos/pi-profiles.ts):
 * each file's path and the SHA-256 of its bytes, sorted by path. Mirrored here so the tests can
 * check the shell version the probe runs against it.
 */
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const profileDigestOf = (files) =>
  sha256Hex(
    files
      .map((file) => [file.path, sha256Hex(file.bytes)])
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, digest]) => `${file}\u0000${digest}\n`)
      .join(""),
  );

/**
 * `profile_digest <dir>`: the same digest over a delivered profile directory, leaving out every
 * `node_modules` directory (what the session installs, as the delivery's own comparison does).
 * Prints only the digest and the file count: never a path or a byte of the files.
 */
export const PROFILE_DIGEST_SH = [
  `profile_digest() {`,
  `  ( cd "$1" && find . -type d -name node_modules -prune -o -type f -print | sed 's|^\\./||' | LC_ALL=C sort |`,
  `    while IFS= read -r f; do printf '%s\\000%s\\n' "$f" "$(sha256sum < "$f" | cut -d' ' -f1)"; done | sha256sum | cut -d' ' -f1 )`,
  `}`,
  `profile_files() { ( cd "$1" && find . -type d -name node_modules -prune -o -type f -print | wc -l | tr -d ' ' ); }`,
].join("\n");

/** The saved directories of people, under the harness home every executor mounts. */
export const PEOPLE_ROOT = "/workspace/harness-home/people";

/**
 * Run in the executor as the person (`asPersonCommand`), with their account id: their uid (the
 * owner of their saved directory), their passwd name and home, the home's owner and mode, the
 * names of the processes running as them, their pi and opencode ChatGPT logins (presence, owner,
 * mode, whether the provider's key is there, and where the file really is) and the digest of the
 * pi profile in their home. Nothing it prints is a secret: no file's contents, no environment.
 */
export const PERSON_PROBE_SH = [
  PROFILE_DIGEST_SH,
  `P="${PEOPLE_ROOT}/$1"`,
  `if [ ! -d "$P" ]; then echo "probe saved absent"; exit 0; fi`,
  `uid=$(stat -c %u "$P"); echo "probe uid $uid"`,
  `ent=$(awk -F: -v u="$uid" '$3==u{print $1" "$6; exit}' /etc/passwd)`,
  `if [ -z "$ent" ]; then echo "probe user none"; exit 0; fi`,
  `echo "probe user $ent"; home=\${ent#* }`,
  `[ -d "$home" ] && echo "probe home-stat $(stat -c '%u %a' "$home")"`,
  `for s in /proc/[0-9]*/status; do u=$(awk '/^Uid:/{print $2; exit}' "$s" 2>/dev/null) || continue; ` +
    `[ "$u" = "$uid" ] || continue; echo "probe proc $(awk '/^Name:/{print $2; exit}' "$s" 2>/dev/null)"; done`,
  `login() { if [ -f "$1" ]; then echo "probe login $2 present $(stat -L -c '%u %a' "$1") $(grep -c "\\"$2\\"" "$1") $(readlink -f "$1")"; ` +
    `else echo "probe login $2 absent"; fi; }`,
  `login "$home/.pi/agent/auth.json" openai-codex`,
  `login "$home/.local/share/opencode/auth.json" openai`,
  `d="$home/.pi/agent/mend/profile"`,
  `if [ -d "$d" ]; then echo "probe pi-profile present $(stat -c '%u %a' "$d") $(profile_files "$d") $(profile_digest "$d")"; ` +
    `else echo "probe pi-profile absent"; fi`,
].join("\n");

/** What `PERSON_PROBE_SH` printed, as one object; null fields where it said nothing. */
export const parsePersonProbe = (text) => {
  const probe = {
    saved: true,
    uid: null,
    name: null,
    home: null,
    homeOwner: null,
    homeMode: null,
    processes: [],
    logins: {},
    piProfile: null,
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let match;
    if (line === "probe saved absent") probe.saved = false;
    else if ((match = /^probe uid (\d+)$/.exec(line))) probe.uid = Number(match[1]);
    else if ((match = /^probe user (\S+) (\S+)$/.exec(line))) {
      probe.name = match[1];
      probe.home = match[2];
    } else if ((match = /^probe home-stat (\d+) ([0-7]+)$/.exec(line))) {
      probe.homeOwner = Number(match[1]);
      probe.homeMode = match[2];
    } else if ((match = /^probe proc (.+)$/.exec(line))) probe.processes.push(match[1]);
    else if ((match = /^probe login (\S+) present (\d+) ([0-7]+) (\d+) (.+)$/.exec(line))) {
      probe.logins[match[1]] = {
        present: true,
        owner: Number(match[2]),
        mode: match[3],
        keyLines: Number(match[4]),
        realPath: match[5],
      };
    } else if ((match = /^probe login (\S+) absent$/.exec(line))) {
      probe.logins[match[1]] = { present: false };
    } else if (
      (match = /^probe pi-profile present (\d+) ([0-7]+) (\d+) ([0-9a-f]{64})$/.exec(line))
    ) {
      probe.piProfile = {
        present: true,
        owner: Number(match[1]),
        mode: match[2],
        files: Number(match[3]),
        digest: match[4],
      };
    } else if (line === "probe pi-profile absent") probe.piProfile = { present: false };
  }
  return probe;
};

/** The first person's uid in the reserved range (docs/adr/0016, decision 1: 40000 is the group). */
export const FIRST_PERSON_UID = 40001;

/** Each harness's ChatGPT login, as the probe names it (docs/adr/0016, decision 5). */
const CHATGPT_LOGIN_OF = { pi: "openai-codex", opencode: "openai" };

/**
 * What a person launch must show in its executor (docs/adr/0016, decisions 1, 2 and 5): the agent
 * runs as a uid in the person range with its own home (the agent's own `id -u` and `$HOME`, which
 * only the agent can read, against the probe's passwd entry), the home is theirs and 0700, pi's
 * profile is the person's own (`piDigest` from `GET /me/pi-profile`, null for none) and not
 * `otherPiDigest`'s, and pi's and opencode's ChatGPT login is in their home, theirs, 0600, never
 * under the saved worktree.
 */
export const personVerdicts = ({
  probe,
  harness,
  agentSaid = null,
  piDigest = undefined,
  otherPiDigest = undefined,
  otherUid = null,
  loginSkipped = null,
}) => {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  if (!probe.saved || probe.uid === null) {
    add("saved_dir", false, "no saved directory for this person in the executor");
    return out;
  }
  add(
    "uid",
    probe.uid >= FIRST_PERSON_UID && (otherUid === null || probe.uid !== otherUid),
    `uid ${probe.uid}${otherUid === null ? "" : ` (the other person: ${otherUid})`}`,
  );
  add(
    "home",
    probe.home !== null &&
      probe.home !== "/root" &&
      probe.homeOwner === probe.uid &&
      probe.homeMode === "700",
    `home ${probe.home ?? "none"} · owner ${probe.homeOwner ?? "?"} · mode ${probe.homeMode ?? "?"}`,
  );
  add(
    "processes",
    probe.processes.length > 0,
    probe.processes.length > 0
      ? `runs ${[...new Set(probe.processes)].slice(0, 8).join(", ")}`
      : "no process runs as this person",
  );
  if (agentSaid === null && loginSkipped !== null) {
    add("agent_identity", null, `skipped: ${loginSkipped}, so the agent cannot answer`);
  } else if (agentSaid === null) {
    add("agent_identity", false, "the agent did not say its uid and HOME");
  } else {
    add(
      "agent_identity",
      agentSaid.uid === probe.uid && agentSaid.home === probe.home,
      `the agent says uid ${agentSaid.uid} · HOME ${agentSaid.home}`,
    );
  }
  const loginKey = CHATGPT_LOGIN_OF[harness];
  if (loginKey !== undefined && loginSkipped !== null) {
    // No login of their own: what is there must still be theirs and hold nobody's entry, never
    // the owner's (Mend uses nobody else's login, decision 5).
    const login = probe.logins[loginKey] ?? { present: false };
    add("chatgpt_login", null, `skipped: ${loginSkipped}`);
    add(
      "chatgpt_login_nobody_else",
      !login.present ||
        (login.owner === probe.uid &&
          login.keyLines === 0 &&
          !login.realPath.startsWith("/workspace/")),
      login.present
        ? `${loginKey} file · owner ${login.owner} · mode ${login.mode} · ${login.keyLines > 0 ? "holds a provider entry" : "no provider entry"} · in ${login.realPath.startsWith("/workspace/") ? "saved state" : "the home"}`
        : `no ${loginKey} login file`,
    );
  } else if (loginKey !== undefined) {
    const login = probe.logins[loginKey] ?? { present: false };
    add(
      "chatgpt_login",
      login.present &&
        login.owner === probe.uid &&
        login.mode === "600" &&
        login.keyLines > 0 &&
        !login.realPath.startsWith("/workspace/"),
      login.present
        ? `${loginKey} · owner ${login.owner} · mode ${login.mode} · ${login.keyLines > 0 ? "has the provider's entry" : "no entry for the provider"} · in ${login.realPath.startsWith("/workspace/") ? "saved state" : "the home"}`
        : `no ${loginKey} login file`,
    );
  }
  if (harness === "pi" && piDigest !== undefined) {
    const profile = probe.piProfile ?? { present: false };
    if (piDigest === null) {
      add(
        "pi_profile",
        !profile.present,
        profile.present
          ? "a pi profile is there, and this person has none"
          : "no profile, as this person has none",
      );
    } else {
      add(
        "pi_profile",
        profile.present && profile.digest === piDigest && profile.owner === probe.uid,
        profile.present
          ? `${profile.files} file(s) · owner ${profile.owner} · ${profile.digest === piDigest ? "this person's profile" : "not this person's profile"}`
          : "no profile delivered, and this person has one",
      );
    }
    if (otherPiDigest !== undefined) {
      if (otherPiDigest === null || otherPiDigest === piDigest) {
        add(
          "pi_profile_not_other",
          true,
          "cannot be told apart: the other person's profile is the same or absent",
        );
      } else {
        add(
          "pi_profile_not_other",
          !(profile.present && profile.digest === otherPiDigest),
          profile.present && profile.digest === otherPiDigest
            ? "the other person's profile"
            : "not the other person's profile",
        );
      }
    }
  }
  return out;
};

/**
 * Why a person's pi or opencode has no ChatGPT login to answer on, or null when it has one: the
 * session line Mend writes when Core left the login out ("pi's ChatGPT login not written · no
 * Codex account is connected"), else the person's connected accounts (`GET /me/sealant`) holding
 * no active Codex account. Such an agent starts and cannot answer, so the bench does not wait.
 */
export const chatGptLoginSkipOf = ({ summary = null, accounts = null }) => {
  const said = /login not written · ([^·\n]+)/.exec(summary ?? "");
  if (said !== null) return `no ChatGPT login: ${said[1].trim()}`;
  if (accounts === null) return null;
  const codex = accounts.filter((account) => account.provider === "codex");
  if (codex.length === 0) return "no ChatGPT login: no Codex account is connected";
  if (!codex.some((account) => account.status === "active")) {
    return "no ChatGPT login: the Codex login needs reconnecting";
  }
  return null;
};

/** The agent's own `ST-BENCH-ID <uid> <home>` line, its spaces drawn or not; null when absent. */
export const agentIdentityOf = (screen) => {
  const match = /ST-BENCH-ID\s*(\d+)\s*(\/[\w./-]*)/.exec(screen);
  return match === null
    ? null
    : { uid: Number(match[1]), home: match[2].replace(/\/+$/, "") || "/" };
};

// ─── growth per extra person (docs/adr/0016, "Budgets") ─────────────────────

/**
 * A person's conversation state in their saved directory (decision 2, `PERSON_SAVED_STATE` in
 * packages/sessions/src/harness-layout.ts, which a test keeps this in step with), their Codex
 * databases (`codex-db`, its WAL included) and the shared conversations they own. Their memory lives
 * inside these. Everything else in `P` is what the budget allows 64 KB for.
 */
export const PERSON_STATE_PATHS = [
  ".claude/projects",
  ".claude/plans",
  ".claude/todos",
  ".claude/tasks",
  ".claude/agents",
  ".claude/commands",
  ".claude/skills",
  ".claude/history.jsonl",
  ".codex/sessions",
  ".codex/archived_sessions",
  ".codex/memories",
  ".codex/rules",
  ".codex/session_index.jsonl",
  ".codex/history.jsonl",
  ".pi/agent/sessions",
  ".pi/agent/settings.json",
  ".local/share/opencode",
  ".local/state/opencode",
];
const PERSON_STATE_EXTRA = ["codex-db", "conversations"];

/** Machine state, never saved (Delivery 3): Codex's logs database and every `*-shm`. */
const isMachineState = (relative) =>
  relative.startsWith("codex-db/logs_") || relative.endsWith("-shm");

/** `size <bytes> ./<path>` for each file under a person's saved directory. */
export const SAVED_SIZES_SH = [
  `P="${PEOPLE_ROOT}/$1"`,
  `if [ ! -d "$P" ]; then echo "size absent"; exit 0; fi`,
  `cd "$P" && find . -type f -exec stat -c 'size %s %n' {} +`,
].join("\n");

/**
 * A person's saved directory in bytes (machine state left out): all of it, their conversation
 * state and memory, and the rest, with the largest of the rest named so a miss says what grew.
 * Null when the directory is not there.
 */
export const classifySavedFiles = (text) => {
  if (text.split("\n").some((line) => line.trim() === "size absent")) return null;
  const totals = { total: 0, state: 0, beyond: 0, files: 0, machine: 0, largestBeyond: [] };
  const beyond = [];
  for (const line of text.split("\n")) {
    const match = /^size (\d+) \.\/(.+)$/.exec(line.trim());
    if (match === null) continue;
    const bytes = Number(match[1]);
    const relative = match[2];
    if (isMachineState(relative)) {
      totals.machine += bytes;
      continue;
    }
    totals.files += 1;
    totals.total += bytes;
    const inState = [...PERSON_STATE_PATHS, ...PERSON_STATE_EXTRA].some(
      (entry) => relative === entry || relative.startsWith(`${entry}/`),
    );
    if (inState) totals.state += bytes;
    else {
      totals.beyond += bytes;
      beyond.push({ path: relative, bytes });
    }
  }
  totals.largestBeyond = beyond.toSorted((a, b) => b.bytes - a.bytes).slice(0, 5);
  return totals;
};

/**
 * A script run in an executor through the host, as the person whose saved directory is
 * `people/<accountId>` (its owner's uid: they own their home, and their processes' status is
 * world-readable, so nothing leans on root's reach into a 0700 home). The script's text rides as
 * base64, so no quoting of the host's shell or SSH touches it; it gets the account id as `$1`.
 * When the person has no saved directory there it prints the absent lines of both probes.
 */
export const asPersonCommand = (container, accountId, script) => {
  for (const arg of [container, accountId]) {
    if (!/^[\w.:@-]+$/.test(String(arg))) throw new Error(`not an id or a name: ${arg}`);
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return (
    `uid=$(docker exec ${container} stat -c %u ${PEOPLE_ROOT}/${accountId} 2>/dev/null); ` +
    `if [ -n "$uid" ]; then docker exec -u "$uid" ${container} sh -c "$(printf %s '${encoded}' | base64 -d)" st-bench ${accountId}; ` +
    `else echo "probe saved absent"; echo "size absent"; fi`
  );
};

/**
 * A launch harness's executor size: sampled at one point of its launch, the record's
 * (`resourcesSampledAt`) unless a merge stamped the measure with its own (`sampledAt`).
 */
const EXECUTOR_RESOURCE =
  /^executor\.(?:claude|codex|pi|opencode)\.(?:disk|memory|sidecar_memory)_bytes$/;

/**
 * Where a record took each launch harness's executor size. Records before this field took it after
 * the answer wait, which a missing answer stretched to 3 minutes (capture staging included).
 */
export const RESOURCES_AT_FIRST_OUTPUT = "at first output";
export const resourcesSampledAt = (result) =>
  result.method?.executorResources ?? "after the answer";

/** A record's executor sizes, each stamped with the point it was sampled at (merges keep it). */
const stampSampling = (result, measures) =>
  Object.fromEntries(
    Object.entries(measures).map(([name, measure]) => [
      name,
      EXECUTOR_RESOURCE.test(name) && measure.sampledAt === undefined
        ? { ...measure, sampledAt: resourcesSampledAt(result) }
        : measure,
    ]),
  );

/** Why a record did not take a measure, from its `notRun` entries; null when it does not say. */
export const notRunReasonOf = (result, name) => {
  const entry = (result.notRun ?? []).find((skipped) =>
    skipped.measure.endsWith(".*")
      ? name.startsWith(skipped.measure.slice(0, -1))
      : skipped.measure === name,
  );
  return entry === undefined ? null : entry.reason;
};

// ─── tables ─────────────────────────────────────────────────────────────────

/** A value in its unit, the way the tables print it. */
export const formatValue = (value, unit) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (unit === "ms") {
    if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)} s`;
    if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
    return `${Math.round(value)} ms`;
  }
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = value;
    let index = 0;
    while (Math.abs(scaled) >= 1000 && index < units.length - 1) {
      scaled /= 1000;
      index += 1;
    }
    return index === 0
      ? `${Math.round(scaled)} B`
      : `${scaled.toFixed(scaled >= 100 ? 0 : 2)} ${units[index]}`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/** The human table of one result: median, p90 and worst per measure, with its budget class. */
export const formatTable = (result) => {
  const lines = [
    "| Measure | n | median | p90 | worst | budget |",
    "| --- | --: | --: | --: | --: | --- |",
  ];
  for (const [name, measure] of Object.entries(result.measures ?? {})) {
    const summary = summarize(measure.samples ?? []);
    if (summary.n === 0) continue;
    const budget = BUDGETS[measure.budget]?.text ?? "–";
    lines.push(
      `| ${name} | ${summary.n} | ${formatValue(summary.median, measure.unit)} | ${formatValue(summary.p90, measure.unit)} | ${formatValue(summary.worst, measure.unit)} | ${budget} |`,
    );
  }
  for (const skipped of result.notRun ?? []) {
    lines.push(`| ${skipped.measure} | 0 | not run: ${skipped.reason} | | | |`);
  }
  if ((result.checks ?? []).length > 0) lines.push("", formatChecks(result.checks));
  for (const [name, companion] of Object.entries(result.companions ?? {})) {
    lines.push("", `On project ${name}:`, "", formatTable(companion));
  }
  return lines.join("\n");
};

/** The correctness checks, which are not timings: how often each held, and what it saw. */
export const formatChecks = (checks) => {
  const lines = [
    "Checks (observations, not timings):",
    "",
    "| Check | held | failed | skipped | observed |",
    "| --- | --: | --: | --: | --- |",
  ];
  for (const check of checks.toSorted((a, b) => b.failed - a.failed)) {
    const observed = check.failed > 0 ? check.failures.join("; ") : (check.detail ?? "");
    lines.push(
      `| ${check.check} | ${check.passed} | ${check.failed} | ${check.skipped ?? 0} | ${observed} |`,
    );
  }
  return lines.join("\n");
};

/** The comparison as a table, misses first, with the verdict of each row in words. */
export const formatComparison = (comparison) => {
  const label = comparison.label ?? null;
  const lines =
    label === null
      ? []
      : [
          label.kind,
          `before: ${label.before}`,
          `after:  ${label.after}`,
          ...label.warnings.map((warning) => `warning: ${warning}`),
          "",
        ];
  lines.push(
    "| Measure | stat | before | after | limit | |",
    "| --- | --- | --: | --: | --: | --- |",
  );
  const ordered = [...comparison.misses, ...comparison.rows.filter((row) => row.ok)];
  for (const row of ordered) {
    const verdict = row.missing
      ? row.notRun === undefined
        ? "MISSING"
        : `NOT RUN: ${row.notRun}`
      : row.ok
        ? "within"
        : "OVER";
    lines.push(
      `| ${row.measure} | ${row.stat} | ${formatValue(row.before, row.unit)} | ${formatValue(row.after, row.unit)} | ${formatValue(row.limit, row.unit)} | ${verdict} |`,
    );
  }
  for (const entry of comparison.incomparable ?? []) {
    lines.push(`| ${entry.measure} | | | | | not comparable: ${entry.reason} |`);
  }
  if ((comparison.checkFailures ?? []).length > 0) {
    lines.push(
      "",
      "Failed checks of the run under test:",
      "",
      formatChecks(comparison.checkFailures),
    );
  }
  return lines.join("\n");
};

// ─── results ────────────────────────────────────────────────────────────────

const HARNESS_LIST = ["claude", "codex", "pi", "opencode"];

/** The scenarios `--only` takes; `new` and `stop` are one scenario seen from either end. */
export const SCENARIOS = [
  "new",
  "stop",
  "resume",
  "join-same",
  "join-other",
  "interactive",
  "api",
  "handover",
  "growth",
  "person-checks",
];

/** The scenarios that measure what only a `person` worktree has; they need `--layout person`. */
export const PERSON_SCENARIOS = ["handover", "growth", "person-checks"];

/** The scenario that produces a measure: what a re-run of a missed measure has to run. */
export const scenarioOf = (measure) => {
  const head = measure.split(".")[0];
  if (head === "new" || head === "executor") {
    return measure.startsWith("executor.resumed") ? "resume" : "new";
  }
  if (head === "stop") return measure.startsWith("stop.after_resume") ? "resume" : "stop";
  if (head === "resume") return "resume";
  if (head === "join") return measure.startsWith("join.other") ? "join-other" : "join-same";
  if (["shell", "terminal", "git", "checkpoint"].includes(head)) return "interactive";
  if (head === "api" || head === "cli") return "api";
  if (head === "handover") return "handover";
  if (head === "growth") return "growth";
  if (head === "person") return "person-checks";
  return null;
};

/** The harness a per-harness measure belongs to (`new.codex.…`, `stop.pi.…`), or null. */
export const harnessOf = (measure) => {
  const match = /^(?:new|stop|executor|handover|growth|person)\.([a-z]+)\./.exec(measure);
  return match !== null && HARNESS_LIST.includes(match[1]) ? match[1] : null;
};

/** A "not run" entry is dropped once its measure has samples (a later run of it worked). */
export const settleNotRun = (result) => ({
  ...result,
  notRun: (result.notRun ?? []).filter((entry) => {
    const pattern = entry.measure.endsWith(".*") ? entry.measure.slice(0, -1) : null;
    return !Object.entries(result.measures ?? {}).some(
      ([name, measure]) =>
        (measure.samples ?? []).length > 0 &&
        (pattern === null ? name === entry.measure : name.startsWith(pattern)),
    );
  }),
});

/**
 * One result with some measures taken again. The measures of `extra` that `takes` accepts replace
 * the base's (a re-run stands for the measure; it is not pooled with the run that missed). By
 * default those are the measures of the scenarios `extra` was run for, so the session a
 * `--only join-other` run launches to join does not replace the base's launch numbers; the base's
 * other measures of those scenarios are dropped, so nothing of the run being replaced stays. Notes,
 * errors and the runs merged are kept beside the base's.
 */
export const mergeResults = (base, extra, takes = null) => {
  const only = extra.options?.only ?? null;
  const harnesses = extra.options?.harnesses ?? null;
  const accept =
    takes ??
    ((name) => {
      if (only !== null && !only.includes(scenarioOf(name) ?? "")) return false;
      const harness = harnessOf(name);
      return harness === null || harnesses === null || harnesses.includes(harness);
    });
  const taken = Object.fromEntries(
    Object.entries(extra.measures ?? {}).filter(
      ([name, measure]) => accept(name) && (measure.samples ?? []).length > 0,
    ),
  );
  const extraNotRun = (extra.notRun ?? []).filter((entry) => accept(entry.measure));
  // A scenario run again stands whole: its measures the later run did not take go too. Named
  // measures (a re-run of misses) replace only themselves.
  const kept = Object.fromEntries(
    Object.entries(base.measures ?? {}).filter(([name]) => takes !== null || !accept(name)),
  );
  return settleNotRun({
    ...base,
    target:
      base.target === undefined || base.target === null
        ? (extra.target ?? null)
        : {
            ...base.target,
            workspaceImage: base.target.workspaceImage ?? extra.target?.workspaceImage ?? null,
            harnessVersions: {
              ...extra.target?.harnessVersions,
              ...base.target.harnessVersions,
            },
          },
    // Each executor size keeps the point its own record sampled it at.
    measures: { ...stampSampling(base, kept), ...stampSampling(extra, taken) },
    notRun: [
      ...(base.notRun ?? []).filter(
        (entry) => !extraNotRun.some((other) => other.measure === entry.measure),
      ),
      ...extraNotRun,
    ],
    notes: [...(base.notes ?? []), ...(extra.notes ?? [])],
    // A scenario run again stands for its checks too.
    checks: [
      ...(base.checks ?? []).filter((check) => takes !== null || !accept(check.check)),
      ...(extra.checks ?? []).filter((check) => accept(check.check)),
    ],
    imageBuilds: [...(base.imageBuilds ?? []), ...(extra.imageBuilds ?? [])],
    errors: [...(base.errors ?? []), ...(extra.errors ?? [])],
    merged: [
      ...(base.merged ?? []),
      { startedAt: extra.startedAt ?? null, only, measures: Object.keys(taken) },
    ],
  });
};

// ─── options ────────────────────────────────────────────────────────────────

const HARNESS_NAMES = ["claude", "codex", "pi", "opencode"];

const positiveInt = (flag, text) => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${flag} takes a whole number, not ${text}`);
  return value;
};

const list = (text) =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/**
 * The command line as options. Defaults follow the ADR: 10 runs of each launch scenario, 10 of
 * each interactive one; `--only` and `--harnesses` are checked against what exists.
 */
export const parseOptions = (argv, now = Date.now()) => {
  const opts = {
    command: "help",
    args: [],
    url: null,
    tokenFile: "~/.config/mend/cli.json",
    secondTokenFile: null,
    project: "mend",
    ssh: null,
    noHost: false,
    mendContainer: "mend-mend-1",
    cli: null,
    only: [...SCENARIOS],
    harnesses: [...HARNESS_NAMES],
    runs: 10,
    joinsPerRun: 1,
    resumesPerRun: 1,
    interactiveRuns: 10,
    typingRuns: 30,
    apiRuns: 20,
    secretFile: false,
    layout: null,
    flag: null,
    out: null,
    stats: ["median", "p90"],
    rerun: false,
  };
  const valued = {
    "--url": (v) => (opts.url = v),
    "--token-file": (v) => (opts.tokenFile = v),
    "--second-token-file": (v) => (opts.secondTokenFile = v),
    "--project": (v) => (opts.project = v),
    "--ssh": (v) => (opts.ssh = v),
    "--mend-container": (v) => (opts.mendContainer = v),
    "--cli": (v) => (opts.cli = v),
    "--only": (v) => (opts.only = list(v)),
    "--harnesses": (v) => (opts.harnesses = list(v)),
    "--runs": (v) => (opts.runs = positiveInt("--runs", v)),
    "--joins-per-run": (v) => (opts.joinsPerRun = positiveInt("--joins-per-run", v)),
    "--resumes-per-run": (v) => (opts.resumesPerRun = positiveInt("--resumes-per-run", v)),
    "--interactive-runs": (v) => (opts.interactiveRuns = positiveInt("--interactive-runs", v)),
    "--typing-runs": (v) => (opts.typingRuns = positiveInt("--typing-runs", v)),
    "--api-runs": (v) => (opts.apiRuns = positiveInt("--api-runs", v)),
    "--flag": (v) => (opts.flag = v),
    "--layout": (v) => (opts.layout = v),
    "--out": (v) => (opts.out = v),
    "--stats": (v) => (opts.stats = list(v)),
  };
  const flags = {
    "--no-host": () => (opts.noHost = true),
    "--secret-file": () => (opts.secretFile = true),
    "--rerun": () => (opts.rerun = true),
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    if (name in valued) {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined) throw new Error(`${name} needs a value`);
      valued[name](value);
    } else if (name in flags) {
      flags[name]();
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  opts.command = positional[0] ?? "help";
  opts.args = positional.slice(1);
  for (const scenario of opts.only) {
    if (!SCENARIOS.includes(scenario)) {
      throw new Error(`unknown scenario ${scenario} (one of ${SCENARIOS.join(", ")})`);
    }
  }
  for (const harness of opts.harnesses) {
    if (!HARNESS_NAMES.includes(harness)) {
      throw new Error(`unknown harness ${harness} (one of ${HARNESS_NAMES.join(", ")})`);
    }
  }
  if (opts.harnesses.length === 0) throw new Error("--harnesses needs at least one harness");
  if (opts.layout !== null && opts.layout !== "person" && opts.layout !== "shared") {
    throw new Error(`--layout takes person or shared, not ${opts.layout}`);
  }
  for (const stat of opts.stats) {
    if (!["median", "p90", "worst"].includes(stat)) throw new Error(`unknown statistic ${stat}`);
  }
  const needs = { table: 1, compare: 2, merge: 2, companion: 2 }[opts.command];
  if (needs !== undefined && opts.args.length < needs) {
    throw new Error(`${opts.command} needs ${needs} record file(s)`);
  }
  if (opts.out === null) {
    opts.out =
      opts.command === "compare" || opts.command === "merge" || opts.command === "companion"
        ? (opts.args[opts.command === "companion" ? 0 : 1] ?? "/tmp/st-bench.json").replace(
            /\.json$/,
            "",
          ) +
          `.${{ merge: "merged", compare: "rerun", companion: "with-companion" }[opts.command]}.json`
        : `/tmp/st-bench-${now.toString(36).slice(-6)}.json`;
  }
  return opts;
};

/**
 * An origin URL in the SSH form Mend's git shim carries (`git@host:owner/repo.git`); null when it
 * has none (a local path, an unknown scheme).
 */
export const sshRemoteOf = (url) => {
  if (/^[\w.-]+@[\w.-]+:.+/.test(url)) return url;
  const match = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/.exec(url);
  if (match === null) return null;
  const repo = match[2].endsWith(".git") ? match[2] : `${match[2]}.git`;
  return `git@${match[1]}:${repo}`;
};

/**
 * A record run on another project, kept inside the main one under that project's name (the
 * different-person join needs a project both accounts can see; the same-person join is run there
 * too, so the two compare like for like). `compare` checks companions as well.
 */
export const withCompanion = (main, companion) => ({
  ...main,
  companions: {
    ...main.companions,
    [companion.target?.project?.name ?? "other"]: companion,
  },
});
