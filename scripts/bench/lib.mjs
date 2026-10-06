// The pure half of the benchmark (docs/adr/0016, "Performance"): statistics, log parsing, the
// budgets and their comparison, and the tables. Nothing here reads the network, a clock or a file,
// so all of it is unit-tested (lib.test.mjs).

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
};

/** The increase a budget allows over one statistic of the baseline. */
export const allowance = (budgetKey, before, stat) => {
  const budget = BUDGETS[budgetKey];
  if (budget === undefined) return null;
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
  for (const [name, measure] of Object.entries(before.measures ?? {})) {
    if (
      measure.budget === undefined ||
      measure.budget === null ||
      BUDGETS[measure.budget] === undefined
    ) {
      continue;
    }
    const baseline = summarize(measure.samples ?? []);
    if (baseline.n === 0) continue;
    const other = after.measures?.[name];
    const current = summarize(other?.samples ?? []);
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
      });
    }
  }
  for (const [name, companion] of Object.entries(before.companions ?? {})) {
    const theirs = after.companions?.[name] ?? { measures: {} };
    for (const row of compareResults(companion, theirs, { stats }).rows) {
      rows.push({ ...row, measure: `${name}: ${row.measure}` });
    }
  }
  return { rows, misses: rows.filter((row) => !row.ok) };
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
  for (const [name, companion] of Object.entries(result.companions ?? {})) {
    lines.push("", `On project ${name}:`, "", formatTable(companion));
  }
  return lines.join("\n");
};

/** The comparison as a table, misses first, with the verdict of each row in words. */
export const formatComparison = (comparison) => {
  const lines = [
    "| Measure | stat | before | after | limit | |",
    "| --- | --- | --: | --: | --: | --- |",
  ];
  const ordered = [...comparison.misses, ...comparison.rows.filter((row) => row.ok)];
  for (const row of ordered) {
    const verdict = row.missing ? "MISSING" : row.ok ? "within" : "OVER";
    lines.push(
      `| ${row.measure} | ${row.stat} | ${formatValue(row.before, row.unit)} | ${formatValue(row.after, row.unit)} | ${formatValue(row.limit, row.unit)} | ${verdict} |`,
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
];

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
  return null;
};

/** The harness a per-harness measure belongs to (`new.codex.…`, `stop.pi.…`), or null. */
export const harnessOf = (measure) => {
  const match = /^(?:new|stop|executor)\.([a-z]+)\./.exec(measure);
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
    measures: { ...kept, ...taken },
    notRun: [
      ...(base.notRun ?? []).filter(
        (entry) => !extraNotRun.some((other) => other.measure === entry.measure),
      ),
      ...extraNotRun,
    ],
    notes: [...(base.notes ?? []), ...(extra.notes ?? [])],
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
