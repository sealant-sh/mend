//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/g4-terminal-agent-waits.mjs --out <dir>
//
// MEND_VERIFY_G4_PAUSE_MS (default 8000) is the stand-in's pause before each event: every state
// must be read inside it. Needs a world from `up` built from a checkout with G4 (`--build`).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs } from "../scripts/drive-vscode.lib.mjs";
import { FAKES } from "../scripts/fakes.mjs";
import { EVENTS, handlersFor } from "../scripts/fixtures/claude-standin.mjs";
import { redact } from "../scripts/redact.mjs";
import { loadSecrets, redactValues } from "../scripts/secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const STANDIN = join(here, "../scripts/fixtures/claude-standin.mjs");

export const HELPER = {
  claude: "/run/mend/bin/mend hook claude",
  codex: "/run/mend/bin/mend hook codex",
};
export const CLAUDE_EVENTS = [
  "SessionStart",
  "PermissionRequest",
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "PostToolUse",
];
export const CODEX_EVENTS = [
  "SessionStart",
  "PermissionRequest",
  "Stop",
  "UserPromptSubmit",
  "PostToolUse",
];
export const XTERM_ATTACH_REPLIES = [
  "\x1b[?1;2c",
  "\x1b[>0;276;0c",
  "\x1b[24;1R",
  "\x1b[?0u",
  "\x1b[I",
  "\x1b[?997;1n",
];
const NOTIFICATION_TYPES = [
  "permission_prompt",
  "elicitation_dialog",
  "idle_prompt",
  "auth_success",
];

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

export const sessionIdOfArgv = (argv) => {
  const at = argv.indexOf("--session-id");
  return at === -1 ? null : (argv[at + 1] ?? null);
};

// A session's launch reads the claude account named `default` (the one `mend connect` writes).
// Core stores a fresh setup token `active` without asking Anthropic, and marks it `invalid` the
// first time inference is refused on it, so the fake reads `active` only until a pass spends it.
// An archived row can sit beside a live one under the same name, so a live status wins.
export const claudeLoginOf = (accounts) => {
  const mine = accounts.filter(
    (account) => account.provider === "claude" && account.name === "default",
  );
  if (mine.length === 0) return "missing";
  const live = mine.filter((account) => account.status !== "archived");
  if (live.some((account) => account.status === "active")) return "active";
  return (live[0] ?? mine[0]).status;
};

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
 * Which codex events a config.toml wires to the helper: an array of tables
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

const said = ({ status, waiting }) =>
  waiting === null
    ? status
    : `${status} · ${waiting.kind}${waiting.tool === null ? "" : ` · ${waiting.tool}`}`;

export default async (h) => {
  const { step, note, api, state, sleep } = h;
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
        providerSessionId: row.providerSessionId ?? null,
      })),
    };
  };

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

  const cliEnv = {
    ...process.env,
    HOME: state.home,
    XDG_CONFIG_HOME: state.configHome,
    MEND_URL: origin,
    MEND_TOKEN: token,
  };

  let shell = null;
  let agentTerminal = null;
  try {
    await step(
      "the account's Claude login reads active: the skill's fake setup token, connected now if it reads anything else",
      async () => {
        const login = async () => claudeLoginOf((await api("/me/sealant")).accounts);
        const before = await login();
        if (before === "active") {
          return {
            observed: "GET /me/sealant: claude default reads active · nothing sent",
            connected: false,
          };
        }
        const ran = await world.cli(["connect", "claude", "--from-stdin"], cliEnv, {
          input: FAKES.claude,
          allowFailure: true,
        });
        if (ran.status !== 0)
          fail(
            `mend connect claude --from-stdin exited ${ran.status}: ${scrub(ran.stderr).trim().split("\n").slice(-3).join(" / ")}`,
          );
        const after = await login();
        if (after !== "active")
          fail(
            `claude default read ${before}; after mend connect claude with the fake setup token, GET /me/sealant reads it ${after}, not active`,
          );
        return {
          observed: `claude default read ${before} · connected the fake Claude setup token · GET /me/sealant reads it active`,
          connected: true,
        };
      },
      { via: "cli" },
    );

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

    const attach = async (processId) => {
      const { ticket } = await api("/upgrade-tickets", {
        method: "POST",
        body: JSON.stringify({ target: "tty", process: processId }),
      });
      transient.add(ticket);
      const url = new URL(`${origin}/api/tty`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("process", processId);
      url.searchParams.set("ticket", ticket);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const decoder = new TextDecoder();
      const attached = { id: processId, socket, text: "", closed: null };
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
      return attached;
    };

    await step(
      "a shell beside the agent, attached over the terminal socket",
      async () => {
        const opened = await api(`/sessions/${session.id}/shell`, {
          method: "POST",
          body: "{}",
        });
        const attached = await attach(opened.id);
        shell = attached;
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
    const helperRan = (line, what) => {
      if (line.hooks.length === 0) fail(`${what}: Mend's settings ran no hook for ${line.event}`);
      const off = line.hooks.filter(
        (hook) =>
          hook.exitCode !== 0 || hook.timedOut || hook.stdoutBytes > 0 || hook.stderrBytes > 0,
      );
      if (off.length > 0)
        fail(
          `${what}: the helper did not exit 0 silently (${JSON.stringify(off.map(({ command: _c, ...rest }) => rest))})`,
        );
      return line.hooks.map(({ exitCode, ms }) => ({ exitCode, ms }));
    };

    let settingsText = null;
    let agentSessionId = null;
    await step(
      "the live claude's command line carries --settings that run the helper for every event G4 reads, and the --session-id its row records",
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
        agentSessionId = sessionIdOfArgv(found.settingsArgv);
        if (agentSessionId === null) fail("the live claude's command line has no --session-id");
        const recorded =
          (await read(session.id)).processes.find((row) => row.id === session.agentId)
            ?.providerSessionId ?? null;
        if (recorded !== agentSessionId)
          fail(
            `the agent row records providerSessionId ${recorded}, not the --session-id ${agentSessionId} on its command line`,
          );
        const check = claudeHookCheck(parsed);
        keep(
          "claude-settings.json",
          JSON.stringify(
            {
              cmdline: found.cmdline,
              sessionId: agentSessionId,
              hooks: parsed.hooks ?? null,
              otherKeys: Object.keys(parsed),
            },
            null,
            2,
          ),
        );
        if (check.missing.length > 0)
          fail(
            `the live claude's --settings runs the helper for ${check.wired.join(", ") || "nothing"}, not ${check.missing.join(", ")}`,
          );
        for (const type of ["permission_prompt", "elicitation_dialog", "idle_prompt"])
          if (!check.notificationTypes[type])
            fail(`the Notification matcher does not admit ${type}`);
        return {
          observed: `pid ${found.cmdline[0]?.pid} ${found.cmdline[0]?.argv0} · --session-id ${agentSessionId} recorded on the row · hooks for ${check.wired.join(", ")} · Notification admits ${Object.entries(
            check.notificationTypes,
          )
            .filter(([, admitted]) => admitted)
            .map(([type]) => type)
            .join("|")}`,
          sessionId: agentSessionId,
          check,
        };
      },
      { via: "tty" },
    );

    const SEQUENCE = [
      { spec: "SessionStart", status: "running", kind: null },
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
        sameSince: true,
      },
      { spec: "PostToolUse", status: "running", kind: null },
      { spec: "Stop", status: "idle", kind: "prompt" },
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
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --session-id ${agentSessionId} --events ${SEQUENCE.map((item) => item.spec).join(",")} --pause-ms ${pauseMs} --marker MEND-G4`,
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
          observed: `MEND_SESSION_ID is the session's · mend on PATH · ${env.tokenFile ? "person token file" : "launch token"} · user ${env.user} · cwd ${env.cwd} · reports as --session-id ${agentSessionId} · session ${said(now)}`,
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
          if (expected.sameSince && now.waiting.since !== firstWait?.since)
            fail(
              `${what}: a repeat of the permission wait moved its since (${firstWait?.since} → ${now.waiting.since})`,
            );
          if (expected.kind === "permission" && firstWait === null) firstWait = now.waiting;
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

    const waitHeld = async (ms, what) => {
      const reads = [];
      const start = await read(session.id);
      if (start.waiting?.kind !== "permission")
        fail(`${what}: the session reads ${said(start)} before it starts, not a permission wait`);
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(500)) {
        const now = await read(session.id);
        reads.push(`${said(now)} · since ${now.waiting?.since ?? "none"}`);
        if (now.status !== "waiting" || now.waiting?.since !== start.waiting.since)
          fail(
            `${what}: the wait changed to ${said(now)} (since ${now.waiting?.since ?? "none"}, was ${start.waiting.since})`,
          );
      }
      return { since: start.waiting.since, reads };
    };

    await step(
      "a PermissionRequest under another session id changes nothing: the wait keeps its since, no process frame",
      async () => {
        const other = randomUUID();
        const from = Date.now();
        await type([
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --session-id ${other} --events PermissionRequest --marker MEND-G4O`,
        ]);
        const line = await marker(
          "MEND-G4O",
          (found) => found.index === 0,
          30_000,
          "the other process's PermissionRequest",
        );
        const hooks = helperRan(line, "the other process's PermissionRequest");
        const held = await waitHeld(6_000, "after the other process's report");
        const processFrames = framesFor(session.id, from).filter(
          (frame) => frame.type === "session-process",
        );
        if (processFrames.length > 0)
          fail(
            `/api/events sent ${processFrames.length} session-process frame(s) for a refused report`,
          );
        return {
          observed: `helper exited 0 silently for session id ${other.slice(0, 8)}… · ${held.reads.length} reads over 6 s, every one ${[...new Set(held.reads)].join(" | ")} · no session-process frame`,
          otherSessionId: other,
          hooks,
          since: held.since,
          reads: held.reads.length,
        };
      },
      { via: "tty" },
    );

    await step(
      "the agent's own terminal attached, the replies a real xterm sends, nothing typed: the wait survives",
      async () => {
        const from = Date.now();
        agentTerminal = await attach(session.agentId);
        for (const reply of XTERM_ATTACH_REPLIES) agentTerminal.socket.send(encoder.encode(reply));
        const held = await waitHeld(3_000, "with the agent's terminal attached");
        if (agentTerminal.closed !== null)
          fail(`the agent's terminal socket closed (${agentTerminal.closed})`);
        const processFrames = framesFor(session.id, from).filter(
          (frame) => frame.type === "session-process",
        );
        if (processFrames.length > 0)
          fail(
            `/api/events sent ${processFrames.length} session-process frame(s) while nothing was typed`,
          );
        return {
          observed: `attached agent ${session.agentId.slice(0, 8)} · sent ${XTERM_ATTACH_REPLIES.length} emulator replies · ${held.reads.length} reads over 3 s, every one ${[...new Set(held.reads)].join(" | ")} · no session-process frame`,
          replies: XTERM_ATTACH_REPLIES.map((reply) => JSON.stringify(reply)),
          since: held.since,
          reads: held.reads.length,
        };
      },
      { via: "tty" },
    );

    await step(
      "one key in the agent's terminal clears the permission wait: running, both pointer frames",
      async () => {
        const from = Date.now();
        agentTerminal.socket.send(encoder.encode("\r"));
        const now = await until(
          session.id,
          (seen) => seen.status === "running" && seen.waiting === null,
          10_000,
          "after a key in the agent's terminal the session did not read running",
        );
        const seen = await pointerFrames(session.id, from, "the key's clear");
        previous = now;
        since = Date.now();
        return {
          observed: `${said(now)} (${Date.now() - from} ms after the key) · frames ${seen.map((f) => f.type).join(", ")}`,
          status: now.status,
          waiting: now.waiting,
          frames: seen,
        };
      },
      { via: "tty" },
    );

    await step(
      "PermissionRequest again, so Stop ends a live wait",
      async () => {
        const from = Date.now();
        await type([
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --session-id ${agentSessionId} --events PermissionRequest --marker MEND-G4A`,
        ]);
        const line = await marker("MEND-G4A", (found) => found.index === 0, 30_000, "the re-arm");
        const hooks = helperRan(line, "the re-arm");
        const now = await until(
          session.id,
          (seen) => seen.status === "waiting" && seen.waiting?.kind === "permission",
          10_000,
          "the re-armed PermissionRequest did not read waiting · permission",
        );
        const seen = await pointerFrames(session.id, from, "the re-arm");
        previous = now;
        since = Date.now();
        return {
          observed: `${said(now)} · frames ${seen.map((f) => f.type).join(", ")}`,
          status: now.status,
          waiting: now.waiting,
          hooks,
          frames: seen,
        };
      },
      { via: "tty" },
    );

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
          `node "$D/claude-standin.mjs" --settings "$(cat "$D/settings.json")" --session-id ${agentSessionId} --events PermissionRequest --marker MEND-G4R`,
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
        const ran = await world.cli(
          ["run", "--project", project.name, "--", "cat", "/etc/codex/config.toml"],
          cliEnv,
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
            `/etc/codex/config.toml wires the helper for ${check.wired.join(", ") || "nothing"}, not ${check.missing.join(", ")}`,
          );
        return {
          observed: `[hooks] names ${HELPER.codex} for ${check.wired.join(", ")}`,
          check,
        };
      },
      { via: "cli" },
    );
  } finally {
    if (agentTerminal !== null) {
      keep("agent-terminal.txt", agentTerminal.text);
      if (agentTerminal.closed === null) agentTerminal.socket.close();
    }
    if (shell !== null) {
      keep("shell.txt", shell.text);
      if (shell.closed === null) shell.socket.close();
    }
    events.abort();
    await reading;
    keep("events.json", JSON.stringify({ frames, otherFramesCounted: otherFrames }, null, 2));
    note(
      `evidence: steps.jsonl, shell.txt, agent-terminal.txt, events.json, claude-settings.json, codex-config.toml in ${out}`,
    );
  }
};
