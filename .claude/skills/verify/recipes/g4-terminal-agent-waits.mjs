// G4 live: a terminal agent reports that it waits, and why. A claude session launched as a PTY agent
// (the world has no provider login, so the real claude sits at its sign-in screen: still a live
// `agent-pty`), its argv read for the hooks Mend wires, then claude's hooks replayed by
// fixtures/claude-standin.mjs inside the session's own workspace, in a shell beside the agent, to
// the real `mend hook claude` helper. Each state is read from `GET /api/sessions/:id` and the frames
// of `/api/events`. Then Stop: the wait ends with the agent, and a report replayed after it changes
// nothing. Last, codex: the `[hooks]` table of the workspace's `/etc/codex/config.toml`.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/g4-terminal-agent-waits.mjs --out <dir>
//
// MEND_VERIFY_G4_PAUSE_MS (default 8000) is the stand-in's pause before each event: every state
// must be read inside it. Needs a world from `up` built from a checkout with G4 (`--build`).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "../scripts/drive-vscode.lib.mjs";
import { EVENTS, handlersFor } from "../scripts/fixtures/claude-standin.mjs";
import { redact } from "../scripts/redact.mjs";
import { loadSecrets, redactValues } from "../scripts/secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STANDIN = join(here, "../scripts/fixtures/claude-standin.mjs");

export const HELPER = { claude: "mend hook claude", codex: "mend hook codex" };
export const CLAUDE_EVENTS = [
  "PermissionRequest",
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "PostToolUse",
];
export const CODEX_EVENTS = ["PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"];
const NOTIFICATION_TYPES = [
  "permission_prompt",
  "elicitation_dialog",
  "idle_prompt",
  "auth_success",
];

/** The JSON object claude's argv carries after `--settings` (or as `--settings=<json>`). */
export const settingsOfArgv = (argv) => {
  const at = argv.findIndex((word) => word === "--settings" || word.startsWith("--settings="));
  if (at === -1) throw new Error(`the agent's argv has no --settings: ${argv[0]} …`);
  const value = argv[at] === "--settings" ? argv[at + 1] : argv[at].slice("--settings=".length);
  try {
    const settings = JSON.parse(value ?? "");
    if (settings !== null && typeof settings === "object" && !Array.isArray(settings))
      return settings;
  } catch {}
  throw new Error("the agent's --settings is not inline JSON");
};

/**
 * Which claude events would run `mend hook claude`, resolved the way claude resolves them (the
 * stand-in's matcher and payloads), and which Notification types the matcher admits.
 */
export const claudeHookCheck = (settings) => {
  const common = {
    session_id: "check",
    transcript_path: "/dev/null",
    cwd: "/",
  };
  const runsHelper = (event, variant) =>
    handlersFor(settings, event, EVENTS[event].payload(common, variant)).some(
      (handler) => handler.command.trim() === HELPER.claude,
    );
  const wired = CLAUDE_EVENTS.filter((event) =>
    event === "Notification" ? runsHelper(event, "permission_prompt") : runsHelper(event),
  );
  return {
    wired,
    missing: CLAUDE_EVENTS.filter((event) => !wired.includes(event)),
    notificationTypes: Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [type, runsHelper("Notification", type)]),
    ),
  };
};

/**
 * Which codex events a config.toml wires to `mend hook codex`: an array of tables
 * `[[hooks.<Event>]]` (or `[[hooks.<Event>.hooks]]`) whose body names the helper, or a
 * `<Event> = […]` key of `[hooks]` that does.
 */
export const codexHookCheck = (text) => {
  const bodies = [];
  let current = null;
  for (const line of text.replaceAll("\r", "").split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header !== null) {
      current = { table: header[1], keys: [], text: "" };
      bodies.push(current);
      continue;
    }
    if (current === null) continue;
    current.text += `${line}\n`;
    const key = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (key !== null) current.keys.push({ key: key[1], text: line });
    else if (current.keys.length > 0) current.keys.at(-1).text += `\n${line}`;
  }
  const names = (event) =>
    bodies.some(
      (body) =>
        (body.table === `hooks.${event}` || body.table.startsWith(`hooks.${event}.`)) &&
        body.text.includes(HELPER.codex),
    ) ||
    bodies.some(
      (body) =>
        body.table === "hooks" &&
        body.keys.some((entry) => entry.key === event && entry.text.includes(HELPER.codex)),
    );
  const wired = CODEX_EVENTS.filter(names);
  return {
    hooksTable: bodies.some((body) => body.table === "hooks" || body.table.startsWith("hooks.")),
    wired,
    missing: CODEX_EVENTS.filter((event) => !wired.includes(event)),
  };
};

/** `/api/events` payloads out of an SSE byte stream, as apps/cli/src/workbench-events.ts splits it. */
const sseParser = () => {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const payloads = [];
    for (
      let boundary = buffer.indexOf("\n\n");
      boundary !== -1;
      boundary = buffer.indexOf("\n\n")
    ) {
      const data = buffer
        .slice(0, boundary)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      buffer = buffer.slice(boundary + 2);
      if (data !== "") payloads.push(data);
    }
    return payloads;
  };
};

/** Lines that write `text` to `$D/<target>` in a shell: base64 in a quoted heredoc, 76 a line. */
/**
 * Typed into the shell beside the agent: every process in the workspace that runs claude with a
 * `--settings`, as one marker line. The first one's argv is what the stand-in replays.
 */
const CLAUDE_CMDLINE_SCAN = `import { readdirSync, readFileSync } from "node:fs";
const found = [];
for (const pid of readdirSync("/proc").filter((name) => /^\\d+$/.test(name))) {
  let argv;
  try {
    argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter((word) => word !== "");
  } catch {
    continue;
  }
  const settingsAt = argv.findIndex((word) => word === "--settings" || word.startsWith("--settings="));
  if (settingsAt === -1 || !argv.some((word) => /(^|\\/)claude$/.test(word))) continue;
  found.push({ pid: Number(pid), argv0: argv[0], words: argv.length, argv });
}
console.log(
  "MEND-G4:" +
    JSON.stringify({
      cmdline: found.map(({ pid, argv0, words }) => ({ pid, argv0, words })),
      settingsArgv: found[0]?.argv ?? null,
    }),
);
`;

const heredoc = (target, text) => [
  `base64 -d > "$D/${target}" <<'MEND_G4_EOF'`,
  ...(Buffer.from(text)
    .toString("base64")
    .match(/.{1,76}/g) ?? []),
  "MEND_G4_EOF",
];

const fail = (reason) => {
  throw new Error(reason);
};

/** `waiting · permission · Bash`, `running`: what one read of the session says, in API facts. */
const said = ({ status, waiting }) =>
  waiting === null
    ? status
    : `${status} · ${waiting.kind}${waiting.tool === null ? "" : ` · ${waiting.tool}`}`;

export default async (h) => {
  const { step, note, api, state, sleep } = h;
  // The helpers carry no `--out`; the driver's own parser reads it from the driver's argv.
  const out = resolve(parseArgs(process.argv.slice(2)).options.out);
  mkdirSync(out, { recursive: true });
  const pauseMs = Number(process.env.MEND_VERIFY_G4_PAUSE_MS ?? 8_000);
  if (!Number.isInteger(pauseMs) || pauseMs < 3_000)
    fail("MEND_VERIFY_G4_PAUSE_MS is a whole number of milliseconds, at least 3000");
  const origin = state.server?.origin ?? fail("the run's ledger has no server origin: is it up?");
  const project = state.project ?? fail("the run's ledger has no project: did up finish?");
  const token = readFileSync(join(state.privateDir, "token.secret"), "utf8").trim();
  const secrets = loadSecrets(state.privateDir);
  const transient = new Set();
  const scrub = (text) => {
    let scrubbed = redact(redactValues(String(text), secrets));
    for (const value of transient) scrubbed = scrubbed.replaceAll(value, "[ticket]");
    return scrubbed;
  };
  const keep = (name, text) => writeFileSync(join(out, name), scrub(text));
  const world = await import(
    pathToFileURL(join(here, "../../../../scripts/vscode-remote-world.mjs")).href
  );

  // Opened before the session exists, so no frame about it is missed.
  const frames = [];
  let otherFrames = 0;
  const events = new AbortController();
  const stream = await fetch(`${origin}/api/events`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    signal: events.signal,
  });
  if (!stream.ok || stream.body === null)
    fail(`GET /api/events answered ${stream.status}: the event stream did not open`);
  const reading = (async () => {
    const parse = sseParser();
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) {
      for (const payload of parse(decoder.decode(chunk, { stream: true }))) {
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        if (["session", "session-process"].includes(frame.type))
          frames.push({
            at: Date.now(),
            type: frame.type,
            sessionId: frame.sessionId,
          });
        else otherFrames += 1;
      }
    }
  })().catch(() => undefined);
  const framesFor = (sessionId, since) =>
    frames.filter((frame) => frame.sessionId === sessionId && frame.at >= since);

  /** Both pointer frames for the session since `since`, waited for briefly: SSE may trail a read. */
  const pointerFrames = async (sessionId, since, what) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(250)) {
      const seen = framesFor(sessionId, since);
      if (["session-process", "session"].every((type) => seen.some((f) => f.type === type)))
        return seen.map((frame) => ({
          type: frame.type,
          ms: frame.at - since,
        }));
    }
    const seen = framesFor(sessionId, since).map((frame) => frame.type);
    return fail(
      `${what}: /api/events sent ${seen.length === 0 ? "no frame" : seen.join(", ")} for the session, not both session-process and session`,
    );
  };

  /** One read of the session: its status, the current agent's wait, and every process row's. */
  const read = async (sessionId) => {
    const detail = await api(`/sessions/${sessionId}`);
    const agent = detail.currentAgent ?? null;
    if (agent !== null && !("waiting" in agent))
      fail("GET /api/sessions/:id has a currentAgent without `waiting`: this server has no G4");
    return {
      status: detail.session.status,
      waiting: agent?.waiting ?? null,
      agent:
        agent === null
          ? null
          : {
              id: agent.id,
              kind: agent.kind,
              harness: agent.harness,
              exitedAt: agent.exitedAt,
            },
      processes: (detail.processes ?? []).map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        exitedAt: row.exitedAt,
        waiting: row.waiting ?? null,
      })),
    };
  };

  /** Reads until `matches`, or fails with the last read and `why`. */
  const until = async (sessionId, matches, ms, why, also = () => null) => {
    let last = null;
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(300)) {
      last = await read(sessionId);
      if (matches(last)) return last;
      const stop = also();
      if (stop !== null) fail(`${why}: ${stop} (last read: ${said(last)})`);
    }
    return fail(`${why} within ${ms / 1000} s; last read ${JSON.stringify(last)}`);
  };

  let shell = null;
  try {
    const session = await step(
      "a claude session in a fresh worktree, its agent launched in a PTY",
      async () => {
        const created = await api(`/projects/${project.id}/sessions`, {
          method: "POST",
          body: JSON.stringify({
            harness: "claude",
            label: "g4 terminal agent waits",
            base: null,
            name: `st-g4-${Date.now().toString(36)}`,
          }),
        });
        await api(`/sessions/${created.id}/launch`, {
          method: "POST",
          body: JSON.stringify({ permissionMode: "ask" }),
        });
        const live = await until(
          created.id,
          (now) =>
            now.status === "running" &&
            now.processes.some((row) => row.kind === "agent-pty" && row.exitedAt === null),
          600_000,
          "the session did not read running with a live agent-pty",
        );
        await sleep(5_000);
        const settled = await read(created.id);
        const agent = settled.processes.find(
          (row) => row.kind === "agent-pty" && row.exitedAt === null,
        );
        if (agent === undefined)
          fail(
            "the claude agent-pty ended within 5 s of starting: a real claude at its sign-in screen should stay live",
          );
        return {
          observed: `session ${created.id.slice(0, 8)} · ${said(settled)} · agent-pty ${agent.id.slice(0, 8)} live`,
          id: created.id,
          agentId: agent.id,
          baseline: said(live),
        };
      },
      { via: "api" },
    );

    await step(
      "a shell beside the agent, attached over the terminal socket",
      async () => {
        const opened = await api(`/sessions/${session.id}/shell`, {
          method: "POST",
          body: "{}",
        });
        const { ticket } = await api("/upgrade-tickets", {
          method: "POST",
          body: JSON.stringify({ target: "tty", process: opened.id }),
        });
        transient.add(ticket);
        const url = new URL(`${origin}/api/tty`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("process", opened.id);
        url.searchParams.set("ticket", ticket);
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        const decoder = new TextDecoder();
        const attached = { id: opened.id, socket, text: "", closed: null };
        shell = attached;
        socket.addEventListener("message", (event) => {
          attached.text +=
            typeof event.data === "string"
              ? event.data
              : decoder.decode(new Uint8Array(event.data), { stream: true });
        });
        socket.addEventListener("close", (event) => (attached.closed = event.code));
        await new Promise((resolveOpen, reject) => {
          socket.addEventListener("open", resolveOpen, { once: true });
          socket.addEventListener(
            "error",
            () => reject(new Error("the terminal socket did not open")),
            { once: true },
          );
        });
        socket.send(JSON.stringify({ t: "resize", cols: 240, rows: 50 }));
        for (const deadline = Date.now() + 60_000; attached.text.trim() === ""; await sleep(250))
          if (Date.now() > deadline || attached.closed !== null)
            fail("the shell drew nothing within 60 s");
        await sleep(1_000);
        return `shell ${opened.id.slice(0, 8)} drew its prompt`;
      },
      { via: "api" },
    );

    const encoder = new TextEncoder();
    const type = async (lines) => {
      for (const line of lines) {
        if (shell.closed !== null) fail(`the shell's socket closed (${shell.closed})`);
        shell.socket.send(encoder.encode(`${line}\r`));
        await sleep(10);
      }
    };
    const markers = (prefix) =>
      [...shell.text.matchAll(new RegExp(`${prefix}:(\\{[^\\r\\n]*\\})`, "g"))].flatMap((m) => {
        try {
          return [JSON.parse(m[1])];
        } catch {
          return [];
        }
      });
    const marker = async (prefix, predicate, ms, what) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(200)) {
        const found = markers(prefix).find(predicate);
        if (found !== undefined) return found;
        if (shell.closed !== null) fail(`${what}: the shell's socket closed (${shell.closed})`);
      }
      return fail(`${what}: no ${prefix} line in the shell within ${ms / 1000} s`);
    };
    /** A stand-in event line: its hooks ran, each exited 0 in time and printed nothing. */
    const helperRan = (line, what) => {
      if (line.hooks.length === 0) fail(`${what}: Mend's settings ran no hook for ${line.event}`);
      const off = line.hooks.filter(
        (hook) =>
          hook.exitCode !== 0 || hook.timedOut || hook.stdoutBytes > 0 || hook.stderrBytes > 0,
      );
      if (off.length > 0)
        fail(
          `${what}: mend hook claude did not exit 0 silently (${JSON.stringify(off.map(({ command: _c, ...rest }) => rest))})`,
        );
      return line.hooks.map(({ exitCode, ms }) => ({ exitCode, ms }));
    };

    // The process row's `argv` is the composed launch, without Mend's own flags, so the
    // `--settings` Mend adds shows only on the live process: read it from /proc inside the workspace.
    let settingsText = null;
    await step(
      "the live claude's command line carries --settings that run mend hook claude for every event G4 reads",
      async () => {
        await type([
          "D=$(mktemp -d /tmp/mend-g4.XXXXXX)",
          ...heredoc("scan.mjs", CLAUDE_CMDLINE_SCAN),
          'node "$D/scan.mjs"',
        ]);
        const found = await marker(
          "MEND-G4",
          (line) => "cmdline" in line,
          30_000,
          "the claude command line",
        );
        if (found.settingsArgv === null)
          fail("no process in the workspace runs claude with --settings");
        const parsed = settingsOfArgv(found.settingsArgv);
        settingsText = JSON.stringify(parsed);
        const check = claudeHookCheck(parsed);
        keep(
          "claude-settings.json",
          JSON.stringify(
            {
              cmdline: found.cmdline,
              hooks: parsed.hooks ?? null,
              otherKeys: Object.keys(parsed),
            },
            null,
            2,
          ),
        );
        if (check.missing.length > 0)
          fail(
            `the live claude's --settings runs mend hook claude for ${check.wired.join(", ") || "nothing"}, not ${check.missing.join(", ")}`,
          );
        for (const type of ["permission_prompt", "elicitation_dialog", "idle_prompt"])
          if (!check.notificationTypes[type])
            fail(`the Notification matcher does not admit ${type}`);
        return {
          observed: `pid ${found.cmdline[0]?.pid} ${found.cmdline[0]?.argv0} · hooks for ${check.wired.join(", ")} · Notification admits ${Object.entries(
            check.notificationTypes,
          )
            .filter(([, admitted]) => admitted)
            .map(([type]) => type)
            .join("|")}`,
          check,
        };
      },
      { via: "tty" },
    );

    const SEQUENCE = [
      {
        spec: "PermissionRequest",
        status: "waiting",
        kind: "permission",
        tool: "Bash",
      },
      {
        spec: "Notification:permission_prompt",
        status: "waiting",
        kind: "permission",
        tool: "Bash",
      },
      { spec: "PostToolUse", status: "running", kind: null },
      { spec: "Stop", status: "waiting", kind: "prompt" },
      { spec: "UserPromptSubmit", status: "running", kind: null },
      {
        spec: "PermissionRequest",
        status: "waiting",
        kind: "permission",
        tool: "Bash",
      },
    ];

    await step(
      "the stand-in typed into the shell runs as the session's own process",
      async () => {
        await type([
          "D=$(mktemp -d /tmp/mend-g4.XXXXXX)",
          ...heredoc("claude-standin.mjs", readFileSync(STANDIN, "utf8")),
          ...heredoc("settings.json", settingsText),
          `node -e 'const e=process.env,fs=require("fs");console.log("MEND-G4"+":"+JSON.stringify({env:{sessionId:e.MEND_SESSION_ID??null,tokenFile:Boolean(e.MEND_SESSION_TOKEN_FILE),launchToken:Boolean(e.MEND_SESSION_TOKEN),mend:(e.PATH??"").split(":").some((d)=>fs.existsSync(d+"/mend")),cwd:process.cwd(),user:require("os").userInfo().username}}))'`,
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --events ${SEQUENCE.map((item) => item.spec).join(",")} --pause-ms ${pauseMs} --marker MEND-G4`,
        ]);
        const { env } = await marker("MEND-G4", (line) => "env" in line, 60_000, "the shell's env");
        if (env.sessionId !== session.id)
          fail(`the shell's MEND_SESSION_ID is ${env.sessionId}, not the session ${session.id}`);
        if (!env.mend) fail("the shell has no mend on PATH");
        if (!env.tokenFile && !env.launchToken)
          fail("the shell has neither MEND_SESSION_TOKEN_FILE nor MEND_SESSION_TOKEN");
        await marker("MEND-G4", (line) => line.start === true, 30_000, "the stand-in's start");
        const now = await read(session.id);
        if (now.status !== "running" || now.waiting !== null)
          fail(`before any hook the session reads ${said(now)}, not running`);
        return {
          observed: `MEND_SESSION_ID is the session's · mend on PATH · ${env.tokenFile ? "person token file" : "launch token"} · user ${env.user} · cwd ${env.cwd} · session ${said(now)}`,
          env,
        };
      },
      { via: "tty" },
    );

    let since = Date.now();
    let previous = { status: "running", waiting: null };
    let firstWait = null;
    for (const [index, expected] of SEQUENCE.entries()) {
      const words =
        expected.kind === null
          ? expected.status
          : `${expected.status} · ${expected.kind}${expected.tool ? ` · ${expected.tool}` : ""}`;
      await step(
        `${expected.spec} → ${words}`,
        async () => {
          const what = `${expected.spec} (event ${index + 1})`;
          const line = await marker(
            "MEND-G4",
            (found) => found.index === index,
            pauseMs + 30_000,
            what,
          );
          const markedAt = Date.now();
          const hooks = helperRan(line, what);
          const now = await until(
            session.id,
            (seen) =>
              seen.status === expected.status &&
              (expected.kind === null
                ? seen.waiting === null
                : seen.waiting?.kind === expected.kind &&
                  (expected.tool === undefined || seen.waiting.tool === expected.tool)),
            Math.max(pauseMs - 1_500, 2_000),
            `${what}: the session did not read ${words}`,
            () =>
              markers("MEND-G4").some((found) => found.index === index + 1)
                ? "the next event fired first; raise MEND_VERIFY_G4_PAUSE_MS"
                : null,
          );
          if (expected.kind !== null && now.agent?.harness !== "claude")
            fail(`${what}: the wait is on ${JSON.stringify(now.agent)}, not the claude agent-pty`);
          if (index === 1 && now.waiting.since !== firstWait?.since)
            fail(
              `${what}: a repeat of the permission wait moved its since (${firstWait?.since} → ${now.waiting.since})`,
            );
          if (index === 0) firstWait = now.waiting;
          const changed = said(now) !== said(previous);
          const seen = changed
            ? await pointerFrames(session.id, since, what)
            : framesFor(session.id, since).map((frame) => ({
                type: frame.type,
                ms: frame.at - since,
              }));
          previous = now;
          since = Date.now();
          return {
            observed: `${said(now)} (${Date.now() - markedAt} ms after the hook) · frames ${seen.map((f) => f.type).join(", ") || "none"}`,
            status: now.status,
            waiting: now.waiting,
            hooks,
            frames: seen,
          };
        },
        { via: "tty" },
      );
    }
    await marker("MEND-G4", (line) => line.done === true, 30_000, "the stand-in's end");

    await step(
      "Stop ends the agent and its wait; the shell keeps the workspace up",
      async () => {
        const stopAt = Date.now();
        await api(`/sessions/${session.id}/stop`, {
          method: "POST",
          body: "{}",
        });
        const now = await until(
          session.id,
          (seen) =>
            seen.processes.some((row) => row.id === session.agentId && row.exitedAt !== null) &&
            !["running", "waiting", "stopping", "starting"].includes(seen.status),
          120_000,
          "after Stop the agent did not end with the session settled",
        );
        const carrying = now.processes.filter((row) => row.waiting !== null);
        if (now.waiting !== null || carrying.length > 0)
          fail(`after Stop a wait is still there: ${JSON.stringify(carrying)}`);
        if (now.status !== "idle")
          fail(`after Stop with the shell open the session reads ${now.status}, not idle`);
        const seen = await pointerFrames(session.id, stopAt, "Stop");
        since = Date.now();
        return {
          observed: `${said(now)} · agent ${session.agentId.slice(0, 8)} ended · no row waits · frames ${seen.map((f) => f.type).join(", ")}`,
          status: now.status,
          waiting: now.waiting,
          frames: seen,
        };
      },
      { via: "api" },
    );

    await step(
      "a PermissionRequest replayed after Stop is refused: the session stays idle",
      async () => {
        await type([
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --events PermissionRequest --marker MEND-G4R`,
        ]);
        const line = await marker(
          "MEND-G4R",
          (found) => found.index === 0,
          30_000,
          "the replayed PermissionRequest",
        );
        const hooks = helperRan(line, "the replayed PermissionRequest");
        const reads = [];
        for (const deadline = Date.now() + 6_000; Date.now() < deadline; await sleep(500)) {
          const now = await read(session.id);
          reads.push(said(now));
          if (now.status !== "idle" || now.processes.some((row) => row.waiting !== null))
            fail(`a report after Stop brought back ${said(now)}: ${JSON.stringify(now.processes)}`);
        }
        return {
          observed: `${reads.length} reads over 6 s, every one ${[...new Set(reads)].join(" | ")}`,
          hooks,
          frames: framesFor(session.id, since).map((frame) => frame.type),
        };
      },
      { via: "tty" },
    );

    await step(
      "a second Stop closes the shell and settles the session, with no wait",
      async () => {
        await api(`/sessions/${session.id}/stop`, {
          method: "POST",
          body: "{}",
        });
        const now = await until(
          session.id,
          (seen) => ["completed", "stopped", "failed"].includes(seen.status),
          300_000,
          "the second Stop did not settle the session",
        );
        if (now.waiting !== null || now.processes.some((row) => row.waiting !== null))
          fail(`the settled session still carries a wait: ${JSON.stringify(now.processes)}`);
        return { observed: `${said(now)} · no row waits`, status: now.status };
      },
      { via: "api" },
    );

    await step(
      "codex: the workspace's /etc/codex/config.toml wires mend hook codex",
      async () => {
        const env = {
          ...process.env,
          HOME: state.home,
          XDG_CONFIG_HOME: state.configHome,
          MEND_URL: origin,
          MEND_TOKEN: token,
        };
        const ran = await world.cli(
          ["run", "--project", project.name, "--", "cat", "/etc/codex/config.toml"],
          env,
          { allowFailure: true },
        );
        const text = ran.stdout.replaceAll("\r", "");
        keep("codex-config.toml", text);
        if (ran.status !== 0)
          fail(
            `mend run -- cat /etc/codex/config.toml exited ${ran.status}: ${scrub(ran.stderr).trim().split("\n").slice(-3).join(" / ")}`,
          );
        const check = codexHookCheck(text);
        if (!check.hooksTable) fail("/etc/codex/config.toml has no [hooks] table");
        if (check.missing.length > 0)
          fail(
            `/etc/codex/config.toml wires mend hook codex for ${check.wired.join(", ") || "nothing"}, not ${check.missing.join(", ")}`,
          );
        return {
          observed: `[hooks] names mend hook codex for ${check.wired.join(", ")}`,
          check,
        };
      },
      { via: "cli" },
    );
  } finally {
    if (shell !== null) {
      keep("shell.txt", shell.text);
      if (shell.closed === null) shell.socket.close();
    }
    events.abort();
    await reading;
    keep("events.json", JSON.stringify({ frames, otherFramesCounted: otherFrames }, null, 2));
    note(
      `evidence: steps.jsonl, shell.txt, events.json, claude-settings.json, codex-config.toml in ${out}`,
    );
  }
};
