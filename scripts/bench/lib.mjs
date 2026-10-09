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

/**
 * A container's cgroup `memory.stat` as the parts `docker stats` adds up: `anon` (processes' own
 * memory), `activeFile` (page cache it counts; the inactive part it leaves out), `shmem` (tmpfs
 * and shared memory) and `kernel`. cgroup v2's names, v1's (`total_*`) where v2's are absent.
 * Null for a part the text does not hold.
 */
export const parseMemoryStat = (text) => {
  const values = new Map();
  for (const line of (text ?? "").split("\n")) {
    const match = /^(\w+)\s+(\d+)$/.exec(line.trim());
    if (match !== null) values.set(match[1], Number(match[2]));
  }
  const first = (...names) => {
    for (const name of names) if (values.has(name)) return values.get(name);
    return null;
  };
  return {
    anon: first("anon", "total_rss"),
    activeFile: first("active_file", "total_active_file"),
    shmem: first("shmem", "total_shmem"),
    kernel: first("kernel"),
  };
};

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

/**
 * How many times the engine wrote a person's logins into a workspace between two instants (Core's
 * `POST /v1/workspaces/:id/credentials`, docs/adr/0016 decision 5).
 */
export const credentialWriteCount = (blocks, workspaceId, fromMs, toMs) =>
  blocks.filter((block) => {
    const http = httpOf(block);
    return (
      http !== null &&
      http.method === "POST" &&
      http.url === `/v1/workspaces/${workspaceId}/credentials` &&
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

/**
 * A milestone's name: the engine's message without its prefix and its trailing evidence (the
 * evidence word, the dependency install's fetch retries and its exit code).
 */
export const milestoneName = (message) =>
  message
    .replace(/^session engine:\s*/, "")
    .replace(/^capture mode:\s*/, "capture mode · ")
    .replace(/\s*·\s*observed$/, "")
    .replace(/\s*·\s*fetch retries \d+$/, "")
    .replace(/\s*·\s*exit -?\d+$/, "")
    .replace(/\s*\{.*$/, "")
    .trim();

/**
 * The session engine's milestones for one session or workspace, in order, deduplicated by name
 * (the workspace note is logged once per harness file). These are what a launch, a resume or a
 * Stop is broken into.
 */
export const milestonesOf = (blocks, window) => {
  const seen = new Set();
  const out = [];
  for (const line of engineLinesOf(blocks, window)) {
    if (seen.has(line.name)) continue;
    seen.add(line.name);
    out.push({ name: line.name, at: line.at, level: line.level, fields: line.fields });
  }
  return out;
};

/**
 * Every session-engine line of one session or workspace in a window, in order, none dropped
 * (`milestonesOf` keeps each name once), with its message whole: what the install's window is read
 * from, where a second attempt must show.
 */
export const engineLinesOf = (blocks, { sessionId, workspaceId, fromMs, toMs }) => {
  const out = [];
  for (const block of blocks) {
    if (block.at < fromMs || block.at > toMs) continue;
    if (!/^(session engine|capture mode):/.test(block.message)) continue;
    const ours =
      (sessionId !== undefined && block.fields.sessionId === sessionId) ||
      (workspaceId !== undefined && block.fields.workspaceId === workspaceId);
    if (!ours) continue;
    out.push({
      name: milestoneName(block.message),
      at: block.at,
      level: block.level,
      fields: block.fields,
      message: block.message,
    });
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

/**
 * Why a launch has no delivery window (`deliveryWindow`), from what its milestones say. The engine
 * logs a delivery only when it writes something: a person's memory already in place from their
 * earlier start in the executor, an executor that shares one home (it writes nothing for another
 * person's join), and a person who holds no memory or secret file for the project all leave none.
 */
export const noDeliveryReasonOf = (milestones) => {
  const said = (prefix) => (milestones ?? []).some((m) => m.name.startsWith(prefix));
  if (said("agent memory · already in place")) {
    return "nothing to deliver: the person's memory was already in place from their earlier start in this executor";
  }
  if (said("secret files not written · the executor is another person's")) {
    return "nothing delivered: an executor that shares one home writes no memory or secret files for another person's join (ADR 0009, ADR 0010 decision 3)";
  }
  if (!said("agent memory ·") && !said("secret file")) {
    return "nothing delivered: the launch logged no memory or secret-file delivery (the person holds none for this project, or the live executor already had them)";
  }
  return "the delivery milestones were not in the log";
};

/** What a measure that needs the server's log says when the bench cannot read it. */
export const NO_HOST = "no access to the server's host (pass --ssh or run there)";

const INSTALL_RUNNING = /^dependency install · running\b/;
const INSTALL_ENDED = /^dependency install · (?:completed|exited)\b/;
/** The engine's line before it runs a failed install once more with pnpm's defaults (mend#585). */
const INSTALL_RERUN = /^dependency install · retried with defaults\b/;
/** What the engine says when a launch ran no install: a tree restored, skipped, or not run. */
const INSTALL_NONE =
  /^(?:dependency tree observed|dependency install skipped|dependency install did not run)/;
const TREE_RESTORED = /^dependency tree observed/;

/** Why a clean install cannot be told from a stalled one: the engine's line has no count. */
export const FETCH_RETRIES_UNKNOWN =
  "the engine's install line carries no fetch-retry count (a build before mend#585)";

/**
 * The engine's install end line (mend#585): `session engine: dependency install · completed ·
 * exit 0 · fetch retries 2`, or `· exited · exit 1 · fetch retries 0`; before it, the same
 * without `· fetch retries N`.
 */
const INSTALL_END_LINE =
  /^session engine: dependency install · (?:completed|exited) · exit (-?\d+)(?: · fetch retries (\d+))?$/;

/**
 * An install end line's exit code and fetch retries, read from its exact words; the retries also
 * from its structured field (`fetchRetries`, a number or its digits). Each null when the line
 * does not say it (a build before mend#585 has no retries): unknown, never 0.
 */
export const installEndOf = (line) => {
  const match = INSTALL_END_LINE.exec((line.message ?? "").trim());
  const field = line.fields?.fetchRetries;
  const fromField =
    typeof field === "number" && Number.isInteger(field) && field >= 0
      ? field
      : typeof field === "string" && /^\d+$/.test(field.trim())
        ? Number(field.trim())
        : null;
  return {
    exitCode: match === null ? null : Number(match[1]),
    fetchRetries: match?.[2] === undefined ? fromField : Number(match[2]),
  };
};

/** How many fetches pnpm retried during an install, from its end line (`installEndOf`). */
export const fetchRetriesOf = (line) => installEndOf(line).fetchRetries;

/**
 * The dependency install inside a launch, from every engine line of its window
 * (`engineLinesOf`, nothing deduplicated):
 * - `{ kind: "ran", ms, exited, exitCode, fetchRetries, reruns, why }`: exactly one "dependency
 *   install · running" and one end ("· completed" or "· exited"), the end after it; `ms` between
 *   them, `exited` when the install failed, `fetchRetries` null when the line has no count,
 *   `reruns` the "retried with defaults" lines between them (the install run once more with
 *   pnpm's defaults, which `ms` covers), `why` the running line's reason;
 * - `{ kind: "none", ms: 0, restored }`: no install, as the engine said (`restored` when it saw
 *   the head's dependency tree for the platform, else an install skipped or not run);
 * - `{ kind: "unknown", reason }`: the log shows neither, or not exactly one install.
 * Its time depends on the public npm registry (docs/adr/0016, decision log 2026-10-09).
 */
export const installOf = (lines) => {
  if (lines === null) return { kind: "unknown", reason: NO_HOST };
  const running = lines.filter((line) => INSTALL_RUNNING.test(line.name));
  const ended = lines.filter((line) => INSTALL_ENDED.test(line.name));
  if (running.length === 0 && ended.length === 0) {
    const none = lines.filter((line) => INSTALL_NONE.test(line.name));
    if (none.length === 0) {
      return { kind: "unknown", reason: "the dependency install's lines were not in the log" };
    }
    return { kind: "none", ms: 0, restored: none.some((line) => TREE_RESTORED.test(line.name)) };
  }
  if (running.length !== 1 || ended.length !== 1) {
    return {
      kind: "unknown",
      reason: `${running.length} "dependency install · running" and ${ended.length} end line(s) in the launch's window; exactly one of each is needed`,
    };
  }
  const [start] = running;
  const [end] = ended;
  if (end.at < start.at) {
    return { kind: "unknown", reason: "the install's end line precedes its running line" };
  }
  // A re-run with pnpm's defaults is the same install: its line falls between the one running
  // line and the one end line, which then says the last run's exit and both runs' retries.
  const reruns = lines.filter((line) => INSTALL_RERUN.test(line.name));
  if (reruns.some((line) => line.at < start.at || line.at > end.at)) {
    return {
      kind: "unknown",
      reason: 'a "retried with defaults" line falls outside the install\'s running and end lines',
    };
  }
  const { exitCode, fetchRetries } = installEndOf(end);
  const why = installWhyOf(start);
  return {
    kind: "ran",
    // Both runs, when it was run again.
    ms: end.at - start.at,
    // A non-zero exit fails the install whatever the line's word, as does "exited".
    exited: /^dependency install · exited/.test(end.name) || (exitCode !== null && exitCode !== 0),
    exitCode,
    fetchRetries,
    reruns: Math.max(reruns.length, end.fields?.retriedWithDefaults === true ? 1 : 0),
    why,
  };
};

/** The platforms a logged list names (`[ 'linux-x64-glibc' ]`, an array, or `[]`). */
const platformsOf = (value) => {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value !== "string") return [];
  return [...value.matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2]);
};

/**
 * Why the engine ran an install, from its "dependency install · running" line: a stated `reason`
 * when the line carries one, else what its fields say of the saved head (`capturedFor`: the
 * platforms whose dependency tree it holds, against this executor's `platform`). Null when the
 * line says neither.
 */
export const installWhyOf = (line) => {
  const fields = line.fields ?? {};
  for (const key of ["reason", "why"]) {
    if (typeof fields[key] === "string" && fields[key] !== "") return fields[key];
  }
  if (!("capturedFor" in fields)) return null;
  const platform = typeof fields.platform === "string" ? fields.platform : "this platform";
  const captured = platformsOf(fields.capturedFor);
  return captured.length === 0
    ? `the saved head held no dependency tree (needed: ${platform})`
    : `the saved head held a tree for ${captured.join(", ")}, not ${platform}`;
};

/**
 * `POST /sessions/:id/launch` answers with the session as it stands after this long and the
 * launch carries on (`LAUNCH_ANSWER_WINDOW`, apps/api/src/session-start.ts): a launch call is
 * capped there, so it is recorded unbudgeted, with whether it hit the cap.
 */
export const LAUNCH_ANSWER_WINDOW_MS = 30_000;

/** Whether a launch call's time is the answer window's rather than the launch's. */
export const launchCallCapped = (ms) => ms >= LAUNCH_ANSWER_WINDOW_MS;

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
  // "Steering hand-over (send to first output, nothing in the background; …; a conversation of
  // realistic size) | under 5 s more than the same turn sent by the process's own person": the
  // per-round difference `first_output_over_own`.
  handover: { ceiling: 5000, text: "under 5 s over the owner's own turn" },
  growth: { ceiling: 64 * 1024, text: "at most 64 KB" },
};

/** Whether a budget is a fixed ceiling rather than an allowance over a baseline. */
const isCeiling = (budgetKey) => typeof BUDGETS[budgetKey]?.ceiling === "number";

/**
 * Measures records made before 2026-10-09 budgeted, recorded unbudgeted since: a new launch's and
 * a resume's first output and first turn, which hold the dependency install and its public
 * registry's stalls (their `_excl_install` measures carry the budget now, and clean installs are
 * compared on their own), a resume's restore, budgeted per kind of resume since (one that restored
 * the saved tree, one that reinstalled), and the launch call, capped by the answer window. A
 * comparison reads them as unbudgeted whatever a record says.
 */
const UNBUDGETED =
  /^(?:(?:new\.[a-z]+|resume)\.(?:first_output|first_turn)|new\.[a-z]+\.launch_call|resume\.restore_(?:ms|bytes))$/;

/** A measure's budget class as a comparison reads it. */
export const budgetOf = (name, measure) =>
  UNBUDGETED.test(name) ? null : (measure?.budget ?? null);

/** The increase a budget allows over one statistic of the baseline. */
export const allowance = (budgetKey, before, stat) => {
  const budget = BUDGETS[budgetKey];
  if (budget === undefined || isCeiling(budgetKey)) return null;
  if (budget.spread === true) return Math.max(before.spread ?? 0, budget.abs);
  return Math.max((before[stat] ?? 0) * budget.pct, budget.abs);
};

/**
 * How many samples a gate measure's series should have: one per round for the per-round measures
 * (a launch and its Stop per harness, the hand-over's differences, growth), one per resume or join
 * per round for those. Null for the measures that repeat inside a scenario (interactive, API).
 */
export const expectedSamplesOf = (result, name) => {
  const runs = result.options?.runs ?? 10;
  if (
    /^new\.(?:claude|codex|pi|opencode)\.(?:first_output|first_turn)_excl_install$/.test(name) ||
    /^new\.(?:claude|codex|pi|opencode)\.install_clean$/.test(name) ||
    /^stop\.(?:claude|codex|pi|opencode)\.save$/.test(name) ||
    /^handover\.\w+\.(?:to_other|back)\.first_output_over_own$/.test(name) ||
    /^growth\.\w+\.extra_person_beyond_state_bytes$/.test(name)
  ) {
    return runs;
  }
  if (name === "join.same.first_output" || name === "join.other.first_output") {
    return runs * (result.options?.joinsPerRun ?? 1);
  }
  return null;
};

/** The fewest samples a series may keep: 80% of what was asked, and never fewer than 5. */
export const seriesFloorOf = (expected) => Math.max(5, Math.ceil(expected * 0.8));

/**
 * The fewest clean installs (no fetch retried) a harness's new launches may keep under gate P1,
 * per layout: the registry's stalls set some apart, so the floor is fixed, not 80% of the runs.
 */
export const CLEAN_INSTALL_FLOOR = 5;

const CLEAN_INSTALL = /^new\.[a-z]+\.install_clean$/;

/**
 * How a launch's installs split: all, clean, stalled (a fetch retried), run again with pnpm's
 * defaults (`rerun`, stalled too), unknown count, failed.
 */
export const installsOf = (result, prefix) => {
  const n = (name) => summarize(result.measures?.[`${prefix}.${name}`]?.samples ?? []).n;
  const retries = result.measures?.[`${prefix}.install_fetch_retries`]?.samples ?? [];
  const failed = (result.checks ?? []).find(
    (check) => check.check === `${prefix}.install_succeeded`,
  );
  const reruns = result.measures?.[`${prefix}.install_reruns`]?.samples ?? [];
  return {
    installs: n("install"),
    clean: n("install_clean"),
    stalled: retries.filter((value) => value > 0).length,
    rerun: reruns.filter((value) => value > 0).length,
    unknown: n("install") - retries.length,
    failed: failed?.failed ?? 0,
  };
};

/**
 * Why a gate series is too short to stand (`n of N kept; at least F needed`, with what was set
 * apart: rounds discarded as compacted, rounds with no conversation), or null when it is long
 * enough or has no expected length. A series with no samples is already a miss.
 */
const shortSeriesOf = (result, name, who) => {
  const expected = expectedSamplesOf(result, name);
  if (expected === null) return null;
  const n = summarize(result.measures?.[name]?.samples ?? []).n;
  const clean = CLEAN_INSTALL.test(name);
  const floor = clean ? CLEAN_INSTALL_FLOOR : seriesFloorOf(expected);
  if (n === 0 || n >= floor) return null;
  const apart = [];
  if (clean) {
    const installs = installsOf(result, name.replace(/\.install_clean$/, ""));
    if (installs.stalled > 0) {
      apart.push(
        `${installs.stalled} stalled: a fetch retried${installs.rerun > 0 ? `, ${installs.rerun} of them run again with pnpm's defaults` : ""}`,
      );
    }
    if (installs.unknown > 0) apart.push(`${installs.unknown} with no retry count`);
    if (installs.failed > 0) apart.push(`${installs.failed} failed`);
  }
  const handover = /^handover\.(\w+)\./.exec(name);
  if (handover !== null) {
    const discarded = (result.checks ?? []).find(
      (check) => check.check === `handover.${handover[1]}.round_not_compacted`,
    );
    if ((discarded?.skipped ?? 0) > 0) apart.push(`${discarded.skipped} discarded: compacted`);
  }
  const growth = /^growth\.(\w+)\./.exec(name);
  if (growth !== null) {
    const empty = summarize(
      result.measures?.[`growth.${growth[1]}.no_conversation.extra_person_beyond_state_bytes`]
        ?.samples ?? [],
    ).n;
    if (empty > 0) apart.push(`${empty} with no conversation`);
  }
  return `${who} kept ${n} of ${expected}${apart.length === 0 ? "" : ` (${apart.join(", ")})`}; at least ${floor} needed`;
};

/** One comparison row: a statistic of the run under test against its limit. */
const rowOf = ({ name, measure, before: beforeValue, limit, current, stat, notRun }) => {
  const value = current.n === 0 ? null : current[stat];
  return {
    measure: name,
    unit: measure.unit,
    budget: measure.budget,
    stat,
    before: beforeValue,
    after: value,
    limit,
    ok: value !== null && limit !== null && value <= limit,
    missing: value === null,
    ...(notRun === null ? {} : { notRun }),
  };
};

/**
 * Two result files against the budgets. Every budgeted measure of the baseline is checked on each
 * named statistic (the median and the p90 by default, as review r4 of the ADR asks; the worst
 * only when asked). A measure the baseline has and the other run lacks is a miss: a number that
 * was not taken cannot be inside its limit. A `person` record must also carry what only a person
 * worktree has, for every scenario it was asked to run (`requiredOf`): those absent are misses
 * too, so a run that skipped or crashed them cannot pass. Its errors fail the comparison, and its
 * not-run entries are listed.
 *
 * Gate P1 (a `shared` baseline, a `person` record under test) asks for the whole set whatever the
 * records' `--only` and `--harnesses` said (`requiredOf` with `gate`): every launch scenario for
 * the four harnesses, and the hand-over, growth, the different-person join and the person checks
 * for the harnesses the second person can run (`secondPersonHarnesses`, all four unless the
 * partial gate is asked for explicitly). A budgeted measure either side lacks is a miss, the
 * baseline's errors fail it, and a record that ran less than the set is "not the gate" and fails.
 * Companion records (another project's joins) are compared by what they were asked to run.
 */
export const compareResults = (
  before,
  after,
  {
    stats = ["median", "p90"],
    secondPersonHarnesses = null,
    companion = false,
    // A companion compared under gate P1: the gate's measures it holds (`heldByCompanions`), and
    // its series held to the gate's floors.
    gateMeasures = null,
  } = {},
) => {
  const rows = [];
  const incomparable = [];
  const sampledBefore = resourcesSampledAt(before);
  const sampledAfter = resourcesSampledAt(after);
  const gate = !companion && layoutOf(before) === "shared" && layoutOf(after) === "person";
  // Under the gate, what a companion of the record's run holds is compared there, not missed here.
  const held = heldByCompanions(
    requiredOf(after, { gate, secondPersonHarnesses }),
    gate ? sameRunCompanionsOf(after) : [],
  );
  const required = held.left;
  for (const entry of gateMeasures ?? []) {
    if (!required.measures.some((known) => known.measure === entry.measure)) {
      required.measures.push(entry);
    }
  }
  for (const [name, recorded] of Object.entries(before.measures ?? {})) {
    const measure = { ...recorded, budget: budgetOf(name, recorded) };
    if (
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
    // A kind of resume the record under test never had is not a miss: the kinds' shares are
    // checked on their own (`resumeKindFailures`).
    if (current.n === 0 && RESUME_KIND.test(name)) {
      incomparable.push({
        measure: name,
        reason: "the record under test had no resume of this kind",
      });
      continue;
    }
    const notRun = current.n === 0 ? notRunReasonOf(after, name) : null;
    for (const stat of stats) {
      const limit = baseline[stat] + allowance(measure.budget, baseline, stat);
      rows.push(rowOf({ name, measure, before: baseline[stat], limit, current, stat, notRun }));
    }
  }
  // Under the gate, a budgeted measure the record under test has and the baseline lacks (a shared
  // launch that errored, say) was never compared: a miss, not a pass.
  if (gate) {
    for (const [name, recorded] of Object.entries(after.measures ?? {})) {
      const measure = { ...recorded, budget: budgetOf(name, recorded) };
      if (
        measure.budget === null ||
        BUDGETS[measure.budget] === undefined ||
        isCeiling(measure.budget) ||
        summarize(measure.samples ?? []).n === 0 ||
        rows.some((row) => row.measure === name)
      ) {
        continue;
      }
      if (summarize(before.measures?.[name]?.samples ?? []).n > 0) continue;
      if (RESUME_KIND.test(name)) {
        incomparable.push({ measure: name, reason: "the baseline had no resume of this kind" });
        continue;
      }
      const current = summarize(measure.samples ?? []);
      for (const stat of stats) {
        rows.push({
          ...rowOf({
            name,
            measure,
            before: null,
            limit: null,
            current,
            stat,
            notRun: `no baseline: the shared record has no ${name}${notRunReasonOf(before, name) === null ? "" : ` (${notRunReasonOf(before, name)})`}`,
          }),
          missing: true,
          ok: false,
        });
      }
    }
  }
  // A baselined measure the record under test must carry, which the baseline lacks: it cannot be
  // checked, which is a miss, not a pass.
  for (const { measure: name, unit, budget } of required.measures) {
    if (isCeiling(budget) || rows.some((row) => row.measure === name)) continue;
    const current = summarize(after.measures?.[name]?.samples ?? []);
    const notRun =
      current.n === 0
        ? (notRunReasonOf(after, name) ?? "not in the record")
        : `the baseline has no ${name} to compare against`;
    for (const stat of stats) {
      rows.push({
        ...rowOf({
          name,
          measure: { unit, budget },
          before: null,
          limit: null,
          current,
          stat,
          notRun,
        }),
        missing: true,
        ok: false,
      });
    }
  }
  // A ceiling is checked on the run under test, whatever the baseline holds: a measure either
  // record budgets that way, or the record under test must carry, and it lacks, is a miss.
  const ceilings = new Map();
  for (const record of [after, before]) {
    for (const [name, measure] of Object.entries(record.measures ?? {})) {
      if (isCeiling(measure.budget) && !ceilings.has(name)) ceilings.set(name, measure);
    }
  }
  for (const entry of required.measures) {
    if (isCeiling(entry.budget) && !ceilings.has(entry.measure)) ceilings.set(entry.measure, entry);
  }
  for (const [name, measure] of ceilings) {
    const current = summarize(after.measures?.[name]?.samples ?? []);
    const notRun = current.n === 0 ? notRunReasonOf(after, name) : null;
    const limit = BUDGETS[measure.budget].ceiling;
    for (const stat of stats) {
      rows.push(rowOf({ name, measure, before: null, limit, current, stat, notRun }));
    }
  }
  // Companions (another project's runs), on either side: one only one record has is compared
  // against an empty counterpart, and its failed and unverified checks and errors count as the
  // main record's do.
  const fromCompanions = { checkFailures: [], checksNotVerified: [], errors: [] };
  const companionNames = new Set([
    ...Object.keys(before.companions ?? {}),
    ...Object.keys(after.companions ?? {}),
  ]);
  for (const name of companionNames) {
    const ours = before.companions?.[name] ?? { measures: {} };
    const theirs = after.companions?.[name] ?? { measures: {} };
    const compared = compareResults(ours, theirs, {
      stats,
      companion: true,
      gateMeasures: gate ? (held.byCompanion.get(name) ?? []) : null,
    });
    for (const row of compared.rows) {
      rows.push({ ...row, measure: `${name}: ${row.measure}` });
    }
    for (const entry of compared.incomparable) {
      incomparable.push({ ...entry, measure: `${name}: ${entry.measure}` });
    }
    for (const check of compared.checkFailures) {
      fromCompanions.checkFailures.push({ ...check, check: `${name}: ${check.check}` });
    }
    for (const entry of compared.checksNotVerified) {
      fromCompanions.checksNotVerified.push({ ...entry, check: `${name}: ${entry.check}` });
    }
    for (const error of compared.errors) {
      fromCompanions.errors.push({ ...error, scenario: `${name}: ${error.scenario}` });
    }
  }
  // Under the gate, a series shorter than its floor (rounds discarded as compacted, launches kept
  // apart, growth rounds that held no conversation) is a miss: a median of one round is not the
  // ADR's ten-run gate. A companion's rows are held to it inside its own comparison.
  if (gate || gateMeasures !== null) {
    for (const row of rows) {
      if (companionNames.has(row.measure.split(": ")[0])) continue;
      const short =
        shortSeriesOf(after, row.measure, "the record under test") ??
        (row.before === null ? null : shortSeriesOf(before, row.measure, "the baseline"));
      if (short !== null && row.ok) Object.assign(row, { ok: false, short });
      else if (short !== null) row.short = short;
    }
  }
  const checks = after.checks ?? [];
  return {
    rows,
    misses: rows.filter((row) => !row.ok),
    incomparable,
    gate,
    installs: installReportOf(before, after),
    resumes: {
      before: resumeKindsOf(before),
      after: resumeKindsOf(after),
      shares: reinstallSharesOf(before, after),
      reasons: { before: reinstallReasonsOf(before), after: reinstallReasonsOf(after) },
    },
    // Under the gate: the person layout reinstalling at more resumes than shared, too few resumes
    // of a known kind, no kind on both sides, and a failed install in the baseline.
    layoutFailures: gate && !companion ? gateLayoutFailures(before, after) : [],
    label: describeComparison(before, after, { secondPersonHarnesses, companion }),
    // A correctness check the run under test failed fails the comparison too: a fast launch that
    // ran as the wrong person, or billed the wrong login, is not inside any budget.
    checkFailures: [...failedChecks(after), ...fromCompanions.checkFailures],
    // A check the record must carry that it never made, or never saw hold (only skipped).
    checksNotVerified: [
      ...required.checks
        .filter((name) => !checks.some((check) => check.check === name && check.passed > 0))
        .map((name) => ({
          check: name,
          reason:
            checks.find((check) => check.check === name)?.detail ??
            notRunReasonOf(after, name) ??
            "not in the record",
        })),
      ...fromCompanions.checksNotVerified,
    ],
    checksSkipped: checks.filter((check) => (check.skipped ?? 0) > 0),
    // What went wrong in the run under test fails it; the baseline's are said.
    errors: [...(after.errors ?? []), ...fromCompanions.errors],
    baselineErrors: before.errors ?? [],
    notRun: after.notRun ?? [],
  };
};

/**
 * Whether a comparison fails: a miss, a failed or unverified check, or an error in the run; and,
 * when the layouts make it gate P1, anything that makes it "not the gate" (`label.differs`: another
 * build, instance, project, image or harness version, or a record that ran less than the gate's
 * set) and the baseline's errors. Exit 0 means the gate passed, never "not the gate".
 */
export const comparisonFails = (comparison) =>
  comparison.misses.length > 0 ||
  (comparison.layoutFailures ?? []).length > 0 ||
  comparison.checkFailures.length > 0 ||
  comparison.checksNotVerified.length > 0 ||
  comparison.errors.length > 0 ||
  (comparison.gate === true &&
    ((comparison.label?.differs ?? []).length > 0 || comparison.baselineErrors.length > 0));

// ─── installs and resumes per layout (docs/adr/0016, decision log 2026-10-09) ──

/**
 * The kinds a resume is kept apart by: one that restored the saved dependency tree
 * (`resume.tree_restored.*`) and one that reinstalled (`resume.installed.*`). Each is budgeted
 * against the same kind; a kind only one record had is not compared, and the shares are checked.
 */
const RESUME_KIND = /^resume\.(?:installed|tree_restored)\./;

/**
 * A resume's kind from its install (`installOf`): `installed`, `tree_restored` (the engine saw
 * the head's dependency tree for the platform), or `unclassified` (the log cannot tell, or the
 * install was skipped or did not run).
 */
export const resumeKindOf = (install) =>
  install.kind === "ran"
    ? "installed"
    : install.kind === "none" && install.restored
      ? "tree_restored"
      : "unclassified";

/** How a record's resumes went: reinstalled, restored the saved tree, or could not be told. */
export const resumeKindsOf = (result) => {
  const n = (kind) => summarize(result.measures?.[`resume.${kind}.first_output`]?.samples ?? []).n;
  return {
    installed: n("installed"),
    restored: n("tree_restored"),
    unclassified: n("unclassified"),
  };
};

/** Each launch's installs in either record: every harness's new launches, then the resumes'. */
export const installReportOf = (before, after) =>
  [...GATE_HARNESSES.map((harness) => `new.${harness}`), "resume.installed"]
    .map((prefix) => ({
      prefix,
      before: installsOf(before, prefix),
      after: installsOf(after, prefix),
    }))
    .filter((row) => row.before.installs > 0 || row.after.installs > 0);

/**
 * How much larger a share of its resumes the person layout may reinstall at than shared: 2 per 10
 * resumes, scaled with their number. Shared resumes reinstall now and then too (a capture still
 * uploading at the Stop), so a smaller excess is noise.
 */
export const REINSTALL_TOLERANCE = { per: 10, more: 2 };

/**
 * Both layouts' resume reinstall shares, and whether the person layout's is too large: more than
 * `REINSTALL_TOLERANCE` over shared's (exact integer arithmetic), or every person resume
 * reinstalled while shared restored the saved tree at least once. Null when either side told no
 * resume apart.
 */
export const reinstallSharesOf = (before, after) => {
  const shared = resumeKindsOf(before);
  const person = resumeKindsOf(after);
  const sharedKnown = shared.installed + shared.restored;
  const personKnown = person.installed + person.restored;
  if (sharedKnown === 0 || personKnown === 0) return null;
  // person/personKnown - shared/sharedKnown > more/per, without division.
  const { per, more } = REINSTALL_TOLERANCE;
  const excess =
    per * (person.installed * sharedKnown - shared.installed * personKnown) >
    more * sharedKnown * personKnown;
  const everyOne = person.installed === personKnown && shared.restored >= 1;
  return {
    shared: { installed: shared.installed, of: sharedKnown },
    person: { installed: person.installed, of: personKnown },
    tooMany: excess || everyOne,
    why: excess
      ? `more than ${more} per ${per} resumes over shared`
      : everyOne
        ? "every person resume reinstalled while shared restored the saved tree"
        : null,
  };
};

const percent = (part, of) => `${Math.round((100 * part) / of)}%`;

/** Both reinstall shares in words. */
export const reinstallSharesText = (shares) =>
  `resumes that reinstalled: shared ${shares.shared.installed} of ${shares.shared.of} (${percent(shares.shared.installed, shares.shared.of)}), person ${shares.person.installed} of ${shares.person.of} (${percent(shares.person.installed, shares.person.of)}); gate P1 allows ${REINSTALL_TOLERANCE.more} per ${REINSTALL_TOLERANCE.per} more, and fails when every person resume reinstalls while shared restored at least one`;

/**
 * Why a record's resumes reinstalled, as the engine said it (`resumeReinstalls`), tallied:
 * `[reason, count]`, most first. A reinstall with no stated reason counts under its own words.
 */
export const reinstallReasonsOf = (result) => {
  const counts = new Map();
  for (const entry of result.resumeReinstalls ?? []) {
    const why = entry.why ?? "the engine's line gave no reason";
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1]);
};

/**
 * What fails gate P1 between the layouts that no single measure holds: the person layout
 * reinstalling at too large a share of its resumes against shared (`reinstallSharesOf`: its saved
 * tree not saved or not restored, a loss of work product that would read as a faster resume),
 * either record classifying
 * fewer resumes than its floor, no kind of resume both records had (nothing compared), and a
 * failed install in the baseline (the record under test's fail as checks).
 */
export const gateLayoutFailures = (before, after) => {
  const failures = [];
  const shared = resumeKindsOf(before);
  const person = resumeKindsOf(after);
  for (const [who, result, kinds] of [
    ["the shared record", before, shared],
    ["the person record", after, person],
  ]) {
    const expected = (result.options?.runs ?? 10) * (result.options?.resumesPerRun ?? 1);
    const floor = seriesFloorOf(expected);
    const known = kinds.installed + kinds.restored;
    if (known < floor) {
      failures.push(
        `${who} told ${known} of ${expected} resumes apart (reinstalled or restored the saved tree${kinds.unclassified > 0 ? `; ${kinds.unclassified} could not be told` : ""}); at least ${floor} needed`,
      );
    }
  }
  const sharedKnown = shared.installed + shared.restored;
  const personKnown = person.installed + person.restored;
  const shares = reinstallSharesOf(before, after);
  if (shares?.tooMany === true) {
    failures.push(
      `the person layout reinstalled at ${shares.person.installed} of ${shares.person.of} resumes, the shared at ${shares.shared.installed} of ${shares.shared.of} (${shares.why}): the person layout's saved dependency tree was not restored as often`,
    );
  }
  const both = ["installed", "restored"].filter((kind) => shared[kind] > 0 && person[kind] > 0);
  if (sharedKnown > 0 && personKnown > 0 && both.length === 0) {
    failures.push(
      "no kind of resume ran in both records (reinstalled, restored the saved tree): no resume time was compared",
    );
  }
  for (const row of installReportOf(before, after)) {
    if (row.before.failed > 0) {
      failures.push(`the shared record: ${row.before.failed} failed install(s) in ${row.prefix}`);
    }
  }
  return failures;
};

/** The harnesses Mend runs in protocol mode, where a turn can be steered (the hand-over). */
export const PROTOCOL_HARNESSES = ["claude", "codex"];

/** The four harnesses the gate covers. */
export const GATE_HARNESSES = ["claude", "codex", "pi", "opencode"];

/**
 * The launch measures gate P1 needs from both records, per the ADR's table: each harness's new
 * session to first output and to its first answer, each less its dependency install, and its
 * clean installs (no fetch retried, at least `CLEAN_INSTALL_FLOOR`), compared on their own
 * (decision log 2026-10-09); each Stop's save; a second session of the same person; a checkpoint
 * save; shell and terminal open, typing, `git fetch`; the session list and view. Resumes are
 * checked by kind (`gateLayoutFailures`). (`git push` is left out: a project may give the shim no
 * push access, which a record says as not run.)
 */
const gateLaunchMeasures = () => [
  ...GATE_HARNESSES.flatMap((harness) => [
    { measure: `new.${harness}.first_output_excl_install`, unit: "ms", budget: "start" },
    { measure: `new.${harness}.first_turn_excl_install`, unit: "ms", budget: "start" },
    { measure: `new.${harness}.install_clean`, unit: "ms", budget: "start" },
    { measure: `stop.${harness}.save`, unit: "ms", budget: "start" },
  ]),
  { measure: "join.same.first_output", unit: "ms", budget: "start" },
  { measure: "checkpoint.save", unit: "ms", budget: "start" },
  { measure: "shell.open", unit: "ms", budget: "interactive" },
  { measure: "terminal.attach", unit: "ms", budget: "interactive" },
  { measure: "terminal.echo", unit: "ms", budget: "interactive" },
  { measure: "git.fetch", unit: "ms", budget: "interactive" },
  { measure: "api.session_list", unit: "ms", budget: "api" },
  { measure: "api.session_view", unit: "ms", budget: "api" },
];

/**
 * What a `person` record must carry. For a plain comparison, what each scenario it was asked to run
 * (its `options`) yields: the hand-over's budgeted difference per protocol harness, growth per
 * harness, the different-person join, and the person checks that say who an agent runs as and
 * where its home is. For gate P1 (`gate`), the whole set whatever it was asked: the launch
 * measures for the four harnesses, the person checks for the four, and the hand-over, growth, the
 * joined pi's checks and the different-person join for `secondPersonHarnesses` (all four unless
 * the partial gate names fewer). Nothing for a record of another layout outside the gate.
 */
export const requiredOf = (result, { gate = false, secondPersonHarnesses = null } = {}) => {
  const measures = [];
  const checks = [];
  if (layoutOf(result) !== "person") return { measures, checks };
  const only = gate ? SCENARIOS : (result.options?.only ?? []);
  const harnesses = gate ? GATE_HARNESSES : (result.options?.harnesses ?? []);
  const second = gate
    ? (secondPersonHarnesses ?? GATE_HARNESSES)
    : (result.options?.secondPersonHarnesses ?? harnesses).filter((name) =>
        harnesses.includes(name),
      );
  if (gate) measures.push(...gateLaunchMeasures());
  if (only.includes("handover")) {
    for (const harness of second.filter((name) => PROTOCOL_HARNESSES.includes(name))) {
      for (const kind of ["to_other", "back"]) {
        measures.push({
          measure: `handover.${harness}.${kind}.first_output_over_own`,
          unit: "ms",
          budget: "handover",
        });
        for (const check of ["billed", "runs_as", "one_agent", "completed", "conversation_kept"]) {
          checks.push(`handover.${harness}.${kind}.${check}`);
        }
      }
      // The seed's size was read, and at least one round kept its conversation uncompacted.
      checks.push(`handover.${harness}.seed.size_read`, `handover.${harness}.round_not_compacted`);
    }
  }
  if (only.includes("growth")) {
    for (const harness of second) {
      measures.push({
        measure: `growth.${harness}.extra_person_beyond_state_bytes`,
        unit: "bytes",
        budget: "growth",
      });
    }
  }
  if (only.includes("join-other") && second.length > 0) {
    measures.push({ measure: "join.other.first_output", unit: "ms", budget: "join-other" });
  }
  if (only.includes("person-checks")) {
    const who = ["runs_as", "uid", "home", "agent_process"];
    for (const harness of harnesses) {
      for (const check of who) checks.push(`person.${harness}.${check}`);
    }
    if (second.includes("pi")) {
      for (const check of who) checks.push(`person.pi.joined.${check}`);
    }
  }
  return { measures, checks };
};

/**
 * What a gate P1 pair ran less of than the gate's set, in words: scenarios or harnesses either
 * record's `--only`/`--harnesses` left out, and a person record whose second person ran fewer
 * harnesses than the gate asks of them.
 */
/** The harnesses a record's second person ran. */
const secondPersonRanBy = (result) =>
  result.options?.secondPersonHarnesses ?? result.options?.harnesses ?? [];

export const gateScopeGaps = (before, after, secondPersonHarnesses = null) => {
  const gaps = [];
  const launch = SCENARIOS.filter((scenario) => !PERSON_SCENARIOS.includes(scenario));
  for (const [who, result, scenarios] of [
    ["the shared record", before, launch],
    ["the person record", after, SCENARIOS],
  ]) {
    // A scenario a companion of the same run ran counts as run (`companionMismatchOf`).
    const only = new Set([
      ...(result.options?.only ?? []),
      ...sameRunCompanionsOf(result).flatMap(([, companion]) => companion.options?.only ?? []),
    ]);
    const harnesses = result.options?.harnesses ?? [];
    const notRun = scenarios.filter((scenario) => !only.has(scenario));
    if (notRun.length > 0) gaps.push(`${who} did not run ${notRun.join(", ")}`);
    const absent = GATE_HARNESSES.filter((harness) => !harnesses.includes(harness));
    if (absent.length > 0) gaps.push(`${who} did not run ${absent.join(", ")}`);
    for (const [name, companion] of Object.entries(result.companions ?? {})) {
      const mismatch = companionMismatchOf(result, companion);
      if (mismatch.length > 0) {
        gaps.push(`${who}'s companion on ${name} is not of its run: ${mismatch.join("; ")}`);
      }
    }
  }
  for (const [who, result] of [
    ["the shared record", before],
    ["the person record", after],
  ]) {
    for (const [name, counted] of [[null, result], ...sameRunCompanionsOf(result)]) {
      const runs = counted.options?.runs ?? null;
      if (runs !== null && runs < 10) {
        gaps.push(
          `${name === null ? who : `${who}'s companion on ${name}`} ran ${runs} round(s); the gate runs at least 10 (docs/adr/0016, "Method")`,
        );
      }
    }
  }
  // Companions of one name on both sides compare like the main records: one project, one image,
  // the same harness versions.
  for (const [name, ours] of Object.entries(before.companions ?? {})) {
    const theirs = after.companions?.[name];
    if (theirs === undefined) continue;
    const { differs } = describeComparison(ours, theirs, { companion: true });
    if (differs.length > 0) gaps.push(`the companions on ${name} differ: ${differs.join("; ")}`);
  }
  // What the second person ran, per scenario of theirs: every harness any record of the run (the
  // record itself, or a companion of its run) ran it with. They ran a harness when every scenario
  // of theirs that was run has it; one nobody ran is a gap above.
  const records = [after, ...sameRunCompanionsOf(after).map(([, companion]) => companion)];
  const perScenario = [...PERSON_SCENARIOS, "join-other"]
    .map((scenario) =>
      records
        .filter((result) => (result.options?.only ?? []).includes(scenario))
        .flatMap(secondPersonRanBy),
    )
    .filter((harnesses) => harnesses.length > 0);
  const ran =
    perScenario.length === 0
      ? secondPersonRanBy(after)
      : perScenario.reduce((all, one) => all.filter((harness) => one.includes(harness)));
  const second = secondPersonHarnesses ?? GATE_HARNESSES;
  const short = second.filter((harness) => !ran.includes(harness));
  if (short.length > 0) {
    gaps.push(`the person record's second person did not run ${short.join(", ")}`);
  }
  return gaps;
};

/**
 * Why a companion is not of the same run as the record it is kept in (`withCompanion`), in words;
 * empty when it is. Of the same run: the same layout, instance, Mend build (the image's id, else
 * the commit, else the version), workspace image and harness versions; only the project differs.
 * Under gate P1 a companion of the same run counts toward the gate's set (`requiredOf`), and one
 * that is not makes the comparison "not the gate".
 */
export const companionMismatchOf = (main, companion) => {
  const reasons = [];
  const layouts = [layoutOf(main), layoutOf(companion)];
  if (layouts[0] !== layouts[1]) {
    reasons.push(`it ran the ${layouts[1] ?? "unknown"} layout, the record ${layouts[0] ?? "?"}`);
  }
  const { differs } = describeComparison(main, companion, { companion: true });
  return [...reasons, ...differs.filter((reason) => reason !== "different projects")];
};

/** A record's companions of its own run (`companionMismatchOf`), as `[name, record]` pairs. */
export const sameRunCompanionsOf = (result) =>
  Object.entries(result.companions ?? {}).filter(
    ([, companion]) => companionMismatchOf(result, companion).length === 0,
  );

/**
 * What of `required` a companion of the record's run holds: a measure it has samples of, a check
 * it saw hold. Those are compared there, against the baseline's companion of that name; the rest
 * stays the record's own to carry.
 */
const companionHas = (companion, name) =>
  summarize(companion.measures?.[name]?.samples ?? []).n > 0;
const companionHolds = (companion, name) =>
  (companion.checks ?? []).some((check) => check.check === name && check.passed > 0);
const heldByCompanions = (required, companions) => {
  const measures = new Map();
  for (const entry of required.measures) {
    const holder = companions.find(([, companion]) => companionHas(companion, entry.measure));
    if (holder !== undefined) {
      measures.set(holder[0], [...(measures.get(holder[0]) ?? []), entry]);
    }
  }
  const held = new Set([...measures.values()].flat().map((entry) => entry.measure));
  return {
    left: {
      measures: required.measures.filter((entry) => !held.has(entry.measure)),
      checks: required.checks.filter(
        (name) => !companions.some(([, companion]) => companionHolds(companion, name)),
      ),
    },
    byCompanion: measures,
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

const describeRecord = (result, layout) =>
  `${layout ?? "layout unknown"} · ${result.target?.version ?? "version unknown"}${
    result.target?.commit && result.target.commit !== "unknown"
      ? ` (${String(result.target.commit).slice(0, 9)})`
      : ""
  }${result.target?.mendImage ? ` · ${String(result.target.mendImage).split(" ").at(-1)?.slice(0, 19)}` : ""}`;

/** The Mend server's image id a record ran on (`docker inspect`'s `.Image`), or null. */
const mendImageIdOf = (result) => {
  const text = result.target?.mendImage ?? null;
  if (text === null) return null;
  return /sha256:[0-9a-f]+/.exec(String(text).split(" ").at(-1) ?? "")?.[0] ?? null;
};

/** A known commit, or null for none or `unknown`. */
const commitOf = (result) => {
  const commit = result.target?.commit ?? null;
  return commit === null || commit === "unknown" || commit === "" ? null : commit;
};

/** What gate P1 measures that no record of this benchmark covers (said, so a pass is not read as all of it). */
export const P1_NOT_COVERED = [
  "restore wall time on the box's largest worktree, interleaved between the layouts, on the box's own filesystem (docs/adr/0016, \"What the design does to stay inside them\"; sealantd#145): not measured by this benchmark, which restores its own fresh st-bench worktrees one layout per run",
  "a dependency install that stalled on the public npm registry (a fetch retried): its time is the registry's, so it is recorded (`<launch>.install`) and counted per layout, not budgeted; clean installs, which hold the person's own cost (the install as the launcher, their login profile, the store under /var/cache, default ACLs on every new file), are budgeted on their own, and the start budget is on first output and first turn less the install (docs/adr/0016, decision log 2026-10-09)",
];

/**
 * What a comparison stands for, in words, with what keeps it from standing for that. Gate P1
 * (docs/adr/0016, "Method") is `person` launches against `shared` launches of the same build (the
 * Mend image's id, else its commit), on the same instance, project, workspace image and harness
 * versions; any of those differing makes it "not the gate". `shared` against an older `shared`
 * record is its named check; anything else is a plain before-and-after. Each side's build that
 * cannot be told (no image id, no commit) and each harness version one side lacks is warned of.
 */
export const describeComparison = (
  before,
  after,
  { secondPersonHarnesses = null, companion = false } = {},
) => {
  const layouts = [layoutOf(before), layoutOf(after)];
  const versions = [before.target?.version ?? null, after.target?.version ?? null];
  const warnings = [];
  const differs = [];
  const images = [mendImageIdOf(before), mendImageIdOf(after)];
  const commits = [commitOf(before), commitOf(after)];
  let sameBuild;
  if (images[0] !== null && images[1] !== null) {
    sameBuild = images[0] === images[1];
    if (!sameBuild)
      differs.push(
        `the Mend images differ (${images[0].slice(0, 19)} and ${images[1].slice(0, 19)})`,
      );
  } else if (commits[0] !== null && commits[1] !== null) {
    sameBuild = commits[0] === commits[1];
    if (!sameBuild)
      differs.push(`the commits differ (${commits[0].slice(0, 9)} and ${commits[1].slice(0, 9)})`);
  } else {
    sameBuild = versions[0] !== null && versions[0] === versions[1];
    if (!sameBuild)
      differs.push(`the versions differ (${versions[0] ?? "?"} and ${versions[1] ?? "?"})`);
    warnings.push(
      "the build is told apart by its version only: a record lacks the Mend image's id and its commit (run with the host)",
    );
  }
  if (sameBuild && versions[0] !== versions[1]) {
    differs.push(`the versions differ (${versions[0] ?? "?"} and ${versions[1] ?? "?"})`);
  }
  for (const [index, result] of [before, after].entries()) {
    if (commitOf(result) === null) {
      warnings.push(`the ${index === 0 ? "baseline" : "record under test"}'s commit is unknown`);
    }
  }
  if ((before.target?.url ?? null) !== (after.target?.url ?? null)) {
    differs.push(`different instances (${before.target?.url} and ${after.target?.url})`);
  }
  if ((before.target?.project?.id ?? null) !== (after.target?.project?.id ?? null)) {
    differs.push("different projects");
  }
  const workspace = [before.target?.workspaceImage ?? null, after.target?.workspaceImage ?? null];
  if (workspace[0] !== null && workspace[1] !== null && workspace[0] !== workspace[1]) {
    differs.push(`the workspace images differ (${workspace[0]} and ${workspace[1]})`);
  } else if (workspace[0] === null || workspace[1] === null) {
    warnings.push("a record does not say its workspace image");
  }
  const harnesses = new Set([
    ...(before.options?.harnesses ?? []),
    ...(after.options?.harnesses ?? []),
    ...Object.keys(before.target?.harnessVersions ?? {}),
    ...Object.keys(after.target?.harnessVersions ?? {}),
  ]);
  for (const harness of harnesses) {
    const ours = [
      before.target?.harnessVersions?.[harness],
      after.target?.harnessVersions?.[harness],
    ];
    if (ours[0] !== undefined && ours[1] !== undefined) {
      if (ours[0] !== ours[1])
        differs.push(`${harness} ran ${ours[0]} before and ${ours[1]} after`);
    } else {
      warnings.push(
        `${harness}'s version is not in ${ours[0] === undefined && ours[1] === undefined ? "either record" : ours[0] === undefined ? "the baseline" : "the record under test"}`,
      );
    }
  }
  const gate = !companion && layouts[0] === "shared" && layouts[1] === "person";
  if (gate) differs.push(...gateScopeGaps(before, after, secondPersonHarnesses));
  const notGate = differs.length === 0 ? "" : ` (not the gate: ${differs.join("; ")})`;
  const partial =
    gate &&
    secondPersonHarnesses !== null &&
    GATE_HARNESSES.some((harness) => !secondPersonHarnesses.includes(harness))
      ? ` (partial: the second person runs ${secondPersonHarnesses.join(", ") || "nothing"} only, by --second-person-harnesses)`
      : "";
  let kind = "before and after";
  let notCovered = [];
  if (gate) {
    kind = `gate P1: person launches against shared launches${partial}${notGate}`;
    notCovered = P1_NOT_COVERED;
  } else if (layouts[0] === "person" && layouts[1] === "shared") {
    kind = "shared launches against person launches (reversed: the gate puts shared first)";
  } else if (layouts[0] === "shared" && layouts[1] === "shared" && !sameBuild) {
    const others = differs.filter(
      (reason) => !/images differ|commits differ|versions differ/.test(reason),
    );
    kind = `gate P1's named check: shared launches against an earlier shared record${
      others.length === 0 ? "" : ` (not the check: ${others.join("; ")})`
    }`;
  } else if (layouts[0] !== null && layouts[0] === layouts[1]) {
    kind = `${layouts[0]} launches, before and after`;
  }
  return {
    kind,
    before: describeRecord(before, layouts[0]),
    after: describeRecord(after, layouts[1]),
    layouts,
    differs,
    warnings,
    notCovered,
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

/** Items that are not the agent's output for a turn: the person's message, and errors. */
const NOT_OUTPUT = new Set(["user-message", "error"]);

/**
 * A turn's times, all on the server's clock and all from its creation (the submit as the server
 * received it): to `startedAt` (when a process claimed it), to the first thing the agent said or
 * did for it (an item of that turn other than the person's message or an error), and to its end.
 * The first output and the end are kept only for a turn that completed: a fast error is not a
 * fast answer. Null where the record does not say.
 */
export const turnTimes = (turn, items = []) => {
  const created = Date.parse(turn.createdAt);
  const since = (iso) => {
    const at = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(at) && Number.isFinite(created) ? at - created : null;
  };
  const completed = turn.status === "completed";
  const first = items
    .filter((item) => item.turnId === turn.id && !NOT_OUTPUT.has(item.kind))
    .map((item) => item.createdAt)
    .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    started: since(turn.startedAt),
    firstOutput: !completed || first === undefined ? null : since(first),
    completed: completed ? since(turn.endedAt) : null,
  };
};

/**
 * One round's hand-over cost as the ADR words it: a steered turn's send to first output, less the
 * same round's turn sent by the process's own person (`own`). Null when either is missing.
 */
export const overOwn = (steered, own) =>
  steered === null || own === null || steered === undefined || own === undefined
    ? null
    : steered - own;

/** Who an id is, in a record: the owner, the other person, or nobody. Ids stay out of records. */
const roleOf = (id, ownerId) =>
  id === null || id === undefined
    ? "nobody recorded"
    : id === ownerId
      ? "the owner"
      : "the other person";

/**
 * What one steered turn must show (docs/adr/0016, decision 6): it ran on its sender's login
 * (`billedUserId`), on a process that runs as its sender (`runsAs`), from the person expected
 * (the owner, or someone else), with one agent at a time while it ran (as polled), and it
 * answered. Details name people by role, never by id.
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
      detail: `sent by ${roleOf(sender, ownerId)} (${fromOwner ? "the owner" : "the other person"} expected)`,
    },
    {
      name: "billed",
      ok: sender !== null && turn.billedUserId === sender,
      detail: `billed to ${roleOf(turn.billedUserId, ownerId)}, sent by ${roleOf(sender, ownerId)}`,
    },
    {
      name: "runs_as",
      ok: sender !== null && process !== null && process.runsAs === sender,
      detail: `${process === null ? "its process not found" : `its process runs as ${roleOf(process.runsAs, ownerId)}`}, sent by ${roleOf(sender, ownerId)}`,
    },
    {
      name: "one_agent",
      ok: maxLive <= 1,
      detail: `at most ${maxLive} agent process(es) live at once while it ran, as polled every 250 ms`,
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
 * names of the processes running as them (the probe's own process tree left out), their pi and
 * opencode ChatGPT logins (presence, owner, mode, how many lines name the provider's key, or
 * `unreadable` when the person cannot read it, and where the file really is) and the digest of the
 * pi profile in their home. Nothing it prints is a secret: no file's contents, no environment.
 * `ST_BENCH_PEOPLE` and `ST_BENCH_PASSWD` stand in for the executor's paths in the tests.
 */
export const PERSON_PROBE_SH = [
  PROFILE_DIGEST_SH,
  `P="\${ST_BENCH_PEOPLE:-${PEOPLE_ROOT}}/$1"`,
  `if [ ! -d "$P" ]; then echo "probe saved absent"; exit 0; fi`,
  `uid=$(stat -c %u "$P"); echo "probe uid $uid"`,
  `ent=$(awk -F: -v u="$uid" '$3==u{print $1" "$6; exit}' "\${ST_BENCH_PASSWD:-/etc/passwd}")`,
  `if [ -z "$ent" ]; then echo "probe user none"; exit 0; fi`,
  `echo "probe user $ent"; home=\${ent#* }`,
  `[ -d "$home" ] && echo "probe home-stat $(stat -c '%u %a' "$home")"`,
  // The probe runs as the person too: it and every process under it are not theirs to count.
  `me=$$`,
  `inprobe() { p=$1; n=0; while [ -n "$p" ] && [ "$p" -gt 1 ] && [ "$n" -lt 64 ]; do ` +
    `[ "$p" = "$me" ] && return 0; p=$(awk '/^PPid:/{print $2; exit}' "/proc/$p/status" 2>/dev/null); n=$((n+1)); done; return 1; }`,
  `for s in /proc/[0-9]*/status; do pid=\${s#/proc/}; pid=\${pid%/status}; ` +
    `u=$(awk '/^Uid:/{print $2; exit}' "$s" 2>/dev/null) || continue; [ "$u" = "$uid" ] || continue; ` +
    `inprobe "$pid" && continue; n=$(awk '/^Name:/{print $2; exit}' "$s" 2>/dev/null); [ -n "$n" ] && echo "probe proc $n"; done`,
  `login() { if [ -f "$1" ]; then if [ -r "$1" ]; then c=$(grep -c "\\"$2\\"" "$1" 2>/dev/null); [ -n "$c" ] || c=unreadable; else c=unreadable; fi; ` +
    `echo "probe login $2 present $(stat -L -c '%u %a' "$1") $c $(readlink -f "$1")"; ` +
    `else echo "probe login $2 absent"; fi; }`,
  `login "$home/.pi/agent/auth.json" openai-codex`,
  `login "$home/.local/share/opencode/auth.json" openai`,
  `d="$home/.pi/agent/mend/profile"`,
  `if [ -d "$d" ]; then echo "probe pi-profile present $(stat -c '%u %a' "$d") $(profile_files "$d") $(profile_digest "$d")"; ` +
    `else echo "probe pi-profile absent"; fi`,
].join("\n");

/**
 * What `PERSON_PROBE_SH` printed, as one object; null fields where it said nothing. A login line
 * that says the file is there and does not parse is kept as `unparsed`, never read as absent.
 */
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
    else if (
      (match = /^probe login (\S+) present (\d+) ([0-7]+) (\d+|unreadable) (\/\S.*)$/.exec(line))
    ) {
      probe.logins[match[1]] = {
        present: true,
        owner: Number(match[2]),
        mode: match[3],
        unreadable: match[4] === "unreadable",
        keyLines: match[4] === "unreadable" ? null : Number(match[4]),
        realPath: match[5],
      };
    } else if ((match = /^probe login (\S+) present\b/.exec(line))) {
      probe.logins[match[1]] = { present: true, unparsed: true, raw: line };
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
 * A process name that is exactly the harness's own (`claude`, `codex`, `pi`, `opencode`, a
 * `.opencode` binary, a `-rpc` variant): `pip`, `ping` or `pidof` are not pi.
 */
const isHarnessProcess = (name, harness) => new RegExp(`^\\.?${harness}(?:-rpc)?$`).test(name);

/** A login file's words for a check's detail; never its contents. */
const loginWords = (key, login) => {
  if (!login.present) return `no ${key} login file`;
  if (login.unparsed) return `${key} file there, and the probe's line did not parse: ${login.raw}`;
  const where = login.realPath.startsWith("/workspace/") ? "saved state" : "the home";
  const holds = login.unreadable
    ? "the person cannot read it"
    : login.keyLines > 0
      ? "has the provider's entry"
      : "no provider entry";
  return `${key} · owner ${login.owner} · mode ${login.mode} · ${holds} · in ${where}`;
};

/**
 * What a person launch must show in its executor (docs/adr/0016, decisions 1, 2 and 5): the agent
 * runs as a uid in the person range with its own home (the agent's own `id -u` and `$HOME`, which
 * only the agent can read, against the probe's passwd entry), a process of the harness runs as
 * them (the probe's own left out), the home is theirs and 0700, pi's profile is the person's own
 * (`piDigest` from `GET /me/pi-profile`, null for none) and not `otherPiDigest`'s, and pi's and
 * opencode's ChatGPT login is in their home, theirs, readable by them, 0600, never under the saved
 * worktree. With no login of their own (`loginSkipped`), what is there must hold nobody's entry,
 * and an agent that answered anyway (`agentSaid`) fails `answered_without_login`. `ok` null is a
 * check that could not be made.
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
  const names = [...new Set(probe.processes)];
  add(
    "agent_process",
    names.some((name) => isHarnessProcess(name, harness)),
    names.length > 0
      ? `runs ${names.slice(0, 8).join(", ")}`
      : "no process runs as this person (the probe's own left out)",
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
  if (loginKey !== undefined) {
    const login = probe.logins[loginKey] ?? { present: false };
    const usable = login.present && !login.unparsed && !login.unreadable;
    const inHome = usable && !login.realPath.startsWith("/workspace/");
    if (loginSkipped !== null) {
      // No login of their own: what is there must still be theirs and hold nobody's entry, never
      // the owner's (Mend uses nobody else's login, decision 5); a file they cannot read is not
      // known to hold nothing.
      add("chatgpt_login", null, `skipped: ${loginSkipped}`);
      add(
        "chatgpt_login_nobody_else",
        !login.present || (usable && inHome && login.owner === probe.uid && login.keyLines === 0),
        loginWords(loginKey, login),
      );
      if (agentSaid !== null) {
        add(
          "answered_without_login",
          false,
          `answered with no ChatGPT login of its own: uid ${agentSaid.uid} · HOME ${agentSaid.home}`,
        );
      }
    } else {
      add(
        "chatgpt_login",
        usable && inHome && login.owner === probe.uid && login.mode === "600" && login.keyLines > 0,
        loginWords(loginKey, login),
      );
    }
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
          null,
          "skipped: cannot be told apart, the other person's profile is the same or absent",
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
 * The executor checks `personVerdicts` makes, each skipped with `reason`: what a run without the
 * server's host could not look at, tallied so it shows as not checked rather than vanishing.
 */
export const personVerdictsSkipped = ({ harness, joined = false }, reason) =>
  [
    "uid",
    "home",
    "agent_process",
    "agent_identity",
    ...(CHATGPT_LOGIN_OF[harness] === undefined ? [] : ["chatgpt_login"]),
    ...(harness === "pi" ? ["pi_profile"] : []),
    ...(harness === "pi" && joined ? ["pi_profile_not_other"] : []),
  ].map((name) => ({ name, ok: null, detail: `skipped: ${reason}` }));

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

// ─── a conversation's size (docs/adr/0016's hand-over row) ──────────────────

/**
 * Run as the session's owner in the executor, with their account id and the conversation's id
 * (the harness's own session id, `providerSessionId`): the usage of the last model request in
 * that conversation's transcript, wherever it is under their saved directory (`.claude/projects`
 * or `.codex/sessions` before a hand-over, `conversations/<session>` after), never another, older
 * conversation's (Claude's `"usage":{…}`, Codex's `"last_token_usage":{…}`), and how many
 * compactions it records (Claude's `compact_boundary`, Codex's `"type":"compacted"`). Prints only
 * numbers, never a message.
 */
export const LAST_REQUEST_SH = [
  `P="\${ST_BENCH_PEOPLE:-${PEOPLE_ROOT}}/$1"`,
  `[ -d "$P" ] && [ -n "$2" ] || { echo "usage none"; exit 0; }`,
  `f=$(find "$P" -type f -name "*$2*.jsonl" -exec stat -c '%Y %n' {} + 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)`,
  `[ -n "$f" ] || { echo "usage none"; exit 0; }`,
  `echo "compactions $(grep -cE '"subtype":"compact_boundary"|"type":"compacted"' "$f")"`,
  `u=$(grep -o '"last_token_usage":{[^}]*}' "$f" | tail -1)`,
  `[ -n "$u" ] && { echo "usage codex $u" | tr -cd '[:alnum:]_:,{}" \\n'; exit 0; }`,
  `u=$(grep -o '"usage":{"input_tokens":[^}]*}' "$f" | tail -1)`,
  `[ -n "$u" ] && { echo "usage claude $u" | tr -cd '[:alnum:]_:,{}" \\n'; exit 0; }`,
  `echo "usage none"`,
].join("\n");

/** How many compactions `LAST_REQUEST_SH` saw in the transcript, or null. */
export const compactionsOf = (text) => {
  const match = /^compactions (\d+)$/m.exec(text);
  return match === null ? null : Number(match[1]);
};

/**
 * The prompt size of the last model request (`LAST_REQUEST_SH`'s line): Codex's
 * `last_token_usage.input_tokens` (which includes the cached input), Claude's `input_tokens` plus
 * its cache reads and writes. Null when it said none or did not parse.
 */
export const lastRequestTokensOf = (text) => {
  const line = text.split("\n").find((entry) => entry.startsWith("usage ")) ?? "";
  const field = (name) => {
    const match = new RegExp(`"${name}":(\\d+)`).exec(line);
    return match === null ? null : Number(match[1]);
  };
  if (line.startsWith("usage codex ")) return field("input_tokens");
  if (line.startsWith("usage claude ")) {
    const input = field("input_tokens");
    if (input === null) return null;
    return (
      input + (field("cache_read_input_tokens") ?? 0) + (field("cache_creation_input_tokens") ?? 0)
    );
  }
  return null;
};

/**
 * Whether a conversation shrank between two of its requests by more than a quarter (a
 * conversation only grows, turn by turn, until a harness summarises it, or loses it).
 */
export const compactedBetween = (earlier, later) =>
  typeof earlier === "number" && typeof later === "number" && later < earlier * 0.75;

/**
 * What one hand-over round's conversation sizes say (`sizes`: before the round, then after its
 * `to_other`, `back` and `own` turns; `compactions`: the transcript's compaction count at each
 * point). `lost`: a shrink at a steered turn (`to_other` or `back`) with no compaction recorded,
 * which is the conversation lost at the hand-over, a failure. `compacted`: a shrink the transcript
 * records as a compaction, or one at the `own` turn: the round is discarded. `unread`: a size that
 * could not be read, so nothing can be said either way.
 */
export const roundConversationOf = (sizes, compactions = []) => {
  const kinds = ["to_other", "back", "own"];
  if (sizes.some((value) => typeof value !== "number")) {
    return { unread: true, lost: [], compacted: false };
  }
  const lost = [];
  let compacted = false;
  for (let index = 1; index < sizes.length; index += 1) {
    if (!compactedBetween(sizes[index - 1], sizes[index])) continue;
    const marked =
      typeof compactions[index] === "number" &&
      typeof compactions[index - 1] === "number" &&
      compactions[index] > compactions[index - 1];
    const kind = kinds[index - 1];
    if (!marked && kind !== "own") lost.push(kind);
    else compacted = true;
  }
  return { unread: false, lost, compacted };
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
export const asPersonCommand = (container, accountId, script, extra = []) => {
  for (const arg of [container, accountId, ...extra]) {
    if (!/^[\w.:@-]+$/.test(String(arg))) throw new Error(`not an id or a name: ${arg}`);
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return (
    `uid=$(docker exec ${container} stat -c %u ${PEOPLE_ROOT}/${accountId} 2>/dev/null); ` +
    `if [ -n "$uid" ]; then docker exec -u "$uid" ${container} sh -c "$(printf %s '${encoded}' | base64 -d)" st-bench ${[accountId, ...extra].join(" ")}; ` +
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
    const budget =
      BUDGETS[budgetOf(name, measure)]?.text ??
      (typeof measure.cappedAtMs === "number"
        ? `none: capped at ${formatValue(measure.cappedAtMs, "ms")}`
        : "–");
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
          ...(label.notCovered ?? []).map((item) => `not covered by this comparison: ${item}`),
          "",
        ];
  lines.push(
    "| Measure | stat | before | after | limit | |",
    "| --- | --- | --: | --: | --: | --- |",
  );
  const ordered = [...comparison.misses, ...comparison.rows.filter((row) => row.ok)];
  for (const row of ordered) {
    const verdict =
      row.short !== undefined && !row.missing
        ? `SHORT: ${row.short}`
        : row.missing
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
  if ((comparison.installs ?? []).length > 0) {
    lines.push(
      "",
      "Dependency installs (before → after; stalled: a fetch retried, kept out of the budget):",
      "",
      "| Launch | installs | clean | stalled | re-run with defaults | no retry count | failed |",
      "| --- | --: | --: | --: | --: | --: | --: |",
    );
    for (const row of comparison.installs) {
      const pair = (key) => `${row.before[key]} → ${row.after[key]}`;
      lines.push(
        `| ${row.prefix} | ${pair("installs")} | ${pair("clean")} | ${pair("stalled")} | ${pair("rerun")} | ${pair("unknown")} | ${pair("failed")} |`,
      );
    }
  }
  const resumes = comparison.resumes ?? null;
  if (
    resumes !== null &&
    Object.values({ ...resumes.before, ...resumes.after }).some((n) => n > 0)
  ) {
    const said = (kinds) =>
      `${kinds.restored} restored the saved tree, ${kinds.installed} reinstalled${kinds.unclassified > 0 ? `, ${kinds.unclassified} could not be told` : ""}`;
    lines.push(
      "",
      `Resumes before: ${said(resumes.before)}.`,
      `Resumes after: ${said(resumes.after)}.`,
    );
    if (resumes.shares !== null && resumes.shares !== undefined) {
      lines.push(`Shares of ${reinstallSharesText(resumes.shares)}.`);
    }
    for (const [who, reasons] of [
      ["before", resumes.reasons?.before ?? []],
      ["after", resumes.reasons?.after ?? []],
    ]) {
      if (reasons.length > 0) {
        lines.push(
          `Why resumes reinstalled ${who}: ${reasons.map(([why, n]) => `${n} × ${why}`).join("; ")}.`,
        );
      }
    }
  }
  if ((comparison.layoutFailures ?? []).length > 0) {
    lines.push("", "Between the layouts (gate P1):", "");
    for (const failure of comparison.layoutFailures) lines.push(`- ${failure}`);
  }
  if ((comparison.checkFailures ?? []).length > 0) {
    lines.push(
      "",
      "Failed checks of the run under test:",
      "",
      formatChecks(comparison.checkFailures),
    );
  }
  if ((comparison.checksNotVerified ?? []).length > 0) {
    lines.push("", "Checks the run under test must hold and did not show holding:", "");
    for (const entry of comparison.checksNotVerified) {
      lines.push(`- ${entry.check}: ${entry.reason}`);
    }
  }
  if ((comparison.checksSkipped ?? []).length > 0) {
    lines.push("", "Skipped checks of the run under test (not verified):", "");
    lines.push(formatChecks(comparison.checksSkipped));
  }
  if ((comparison.errors ?? []).length > 0) {
    lines.push("", "Errors in the run under test:", "");
    for (const error of comparison.errors) lines.push(`- ${error.scenario}: ${error.message}`);
  }
  if ((comparison.baselineErrors ?? []).length > 0) {
    lines.push("", "Errors in the baseline (its missing measures are not compared):", "");
    for (const error of comparison.baselineErrors)
      lines.push(`- ${error.scenario}: ${error.message}`);
  }
  if ((comparison.notRun ?? []).length > 0) {
    lines.push("", "Not run in the run under test:", "");
    for (const entry of comparison.notRun) lines.push(`- ${entry.measure}: ${entry.reason}`);
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

/** Two runs' check tallies as one: held, failed and skipped added, failures kept (up to five). */
export const sumChecks = (first, second) => {
  const out = first.map((check) => ({ ...check, failures: [...(check.failures ?? [])] }));
  for (const check of second) {
    const entry = out.find((candidate) => candidate.check === check.check);
    if (entry === undefined) {
      out.push({ ...check, failures: [...(check.failures ?? [])] });
      continue;
    }
    entry.passed += check.passed ?? 0;
    entry.failed += check.failed ?? 0;
    entry.skipped = (entry.skipped ?? 0) + (check.skipped ?? 0);
    entry.failures = [...entry.failures, ...(check.failures ?? [])].slice(0, 5);
    entry.detail = entry.detail ?? check.detail ?? null;
  }
  return out;
};

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
    // Checks are observations, not timings: a merge adds the two runs' tallies and never drops a
    // failure. A re-run is for timing noise (docs/adr/0016, "Method"); a check that failed in
    // either run stays failed.
    checks: sumChecks(base.checks ?? [], extra.checks ?? []),
    imageBuilds: [...(base.imageBuilds ?? []), ...(extra.imageBuilds ?? [])],
    resumeReinstalls: [...(base.resumeReinstalls ?? []), ...(extra.resumeReinstalls ?? [])],
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
    // The hand-over's conversation is grown to about this many input tokens on its last request,
    // in at most `handoverSeedTurns` turns (docs/adr/0016's "a conversation of realistic size").
    handoverSeedTurns: 8,
    handoverContextTokens: 45_000,
    // The harnesses the second person runs: the hand-over, growth and the joined pi. Their
    // connected accounts decide it (pi and opencode need a Codex account). `compare` takes it as
    // the explicit opt-in to a partial gate P1.
    secondPersonHarnesses: null,
    all: false,
    runId: null,
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
    "--handover-seed-turns": (v) =>
      (opts.handoverSeedTurns = positiveInt("--handover-seed-turns", v)),
    "--handover-context-tokens": (v) =>
      (opts.handoverContextTokens = positiveInt("--handover-context-tokens", v)),
    "--second-person-harnesses": (v) => (opts.secondPersonHarnesses = list(v)),
    "--run": (v) => (opts.runId = v),
    "--layout": (v) => (opts.layout = v),
    "--out": (v) => (opts.out = v),
    "--stats": (v) => (opts.stats = list(v)),
  };
  const flags = {
    "--no-host": () => (opts.noHost = true),
    "--secret-file": () => (opts.secretFile = true),
    "--rerun": () => (opts.rerun = true),
    "--all": () => (opts.all = true),
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
  if (opts.secondPersonHarnesses !== null) {
    for (const harness of opts.secondPersonHarnesses) {
      if (!HARNESS_NAMES.includes(harness)) {
        throw new Error(`unknown harness ${harness} in --second-person-harnesses`);
      }
    }
    // The hand-over is P1's headline row: a second person always runs one protocol harness.
    if (!opts.secondPersonHarnesses.some((harness) => ["claude", "codex"].includes(harness))) {
      throw new Error(
        "--second-person-harnesses names the harnesses the second person runs, and must hold claude or codex (the hand-over runs on them)",
      );
    }
  }
  if (opts.runId !== null && !/^[0-9a-z]+$/.test(opts.runId)) {
    throw new Error(`--run takes a run's id (the one its log starts with), not ${opts.runId}`);
  }
  if (opts.command === "cleanup" && !opts.all && opts.runId === null) {
    throw new Error(
      "cleanup removes one run's worktrees (--run <id>, from its log or record) or every st-bench worktree of the project (--all)",
    );
  }
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
 * Whether a cleanup takes a worktree: one of run `rid`'s (`st-bench-<rid>-…`), or with `all` any
 * `st-bench-` worktree. Never one without the prefix.
 */
export const inCleanupScope = (name, rid, all) =>
  typeof name === "string" &&
  name.startsWith("st-bench-") &&
  (all || (typeof rid === "string" && rid !== "" && name.startsWith(`st-bench-${rid}-`)));

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
