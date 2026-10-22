// Flow 5 of the VS Code redesign, driven as Dana meets it: a conversation's request answered from
// VS Code (story b's conversation case, rule 8). The toast's Allow, Deny and More…, a free-text
// Answer…, the row's Answer, a request answered elsewhere first, two windows with one toast, Ana's
// session, and Mend offline.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-answer.mjs --out <dir>
//
// MEND_VERIFY_ANSWER_VIA=api answers every request through `POST /requests/:id/respond`, with the
// body the extension sends, instead of through the editor: Mend's half of each step, provable on an
// extension without flow 5. The default, `ui`, answers through the editor.
//
// What is real: Mend's engine launches the conversation with its own protocol argv in the session's
// workspace, over sealantd's pipe; ClaudeAdapter reads the request, ProtocolHost records the
// `agent_requests` row and its events, the list and respond routes answer, and the adapter writes
// its `control_response`. What is a stand-in: only the process behind the name `claude`
// (`fixtures/claude-protocol-standin.mjs`), which decides to ask. It is written into the workspace
// from a shell beside the session (as recipes/g4-terminal-agent-waits.mjs writes its hook stand-in)
// and put where `command -v claude` resolves; the terminal agent is stopped and the session launched
// again as a conversation. Each turn's text picks what it asks (`mend-ask:permission`, `question`,
// `text`), so a step raises one request at a time. Claude's login is the skill's fake setup token.
//
// MEND_VERIFY_ANSWER_LAUNCHER adds section 10: Dana's terminal agent waits in a workspace Ana
// launched, and Answer attaches it in Dana's window over `/api/tty`. `off` (the default) leaves it
// out, `on` runs it after section 9, `only` runs it with only the setup it needs (Claude connected,
// Ana a member, the project shared). The wait comes from the hook stand-in
// (`fixtures/claude-standin.mjs`) replaying `PermissionRequest` through Mend's own hooks, as
// recipes/g4-terminal-agent-waits.mjs does; the claude in the PTY is real, at its sign-in screen.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "../scripts/drive-vscode.lib.mjs";
import { FAKES } from "../scripts/fakes.mjs";
import { VERSION } from "../scripts/fixtures/claude-protocol-standin.mjs";
import { redact } from "../scripts/redact.mjs";
import { loadSecrets, redactValues } from "../scripts/secrets.mjs";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

const STANDIN = join(import.meta.dirname, "../scripts/fixtures/claude-protocol-standin.mjs");
const HOOK_STANDIN = join(import.meta.dirname, "../scripts/fixtures/claude-standin.mjs");
/** Where the stand-in lives in each workspace; its record is `record.jsonl` beside it. */
const DIR = "/tmp/mend-answer";
const NAME = "add-rate-limit";
const ANA_NAME = "ana-migrate";
const ANA_HOLDS = "ana-holds-workspace";
const DANA_TERMINAL = "dana-in-anas-workspace";

/**
 * Prints `<marker>:{…}`: every claude in the workspace (its uid, `--session-id`, whether it carries
 * `--settings`), and writes to a file the `--settings` of hers: the claude under the `--session-id`
 * given, else (`none`: her row records no id) the one running as this shell's uid. The hook
 * stand-in runs the hooks those settings wire.
 */
const SETTINGS_OF = `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const [sessionId, file, marker] = process.argv.slice(2);
const me = process.getuid();
const seen = [];
const settingsOf = (argv) => {
  const s = argv.findIndex((word) => word === "--settings" || word.startsWith("--settings="));
  return s === -1 ? null : argv[s] === "--settings" ? argv[s + 1] : argv[s].slice("--settings=".length);
};
for (const pid of readdirSync("/proc").filter((name) => /^\\d+$/.test(name))) {
  let argv, uid;
  try {
    argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
    uid = Number(/^Uid:\\s*(\\d+)/m.exec(readFileSync("/proc/" + pid + "/status", "utf8"))?.[1]);
  } catch { continue; }
  if (!argv.some((word) => /(^|\\/)claude$/.test(word))) continue;
  const at = argv.indexOf("--session-id");
  seen.push({ pid: Number(pid), uid, mine: uid === me, argv0: argv[0], sessionId: at === -1 ? null : argv[at + 1], settings: settingsOf(argv) });
}
const hers = seen.find((one) => sessionId !== "none" && one.sessionId === sessionId)
  ?? (sessionId === "none" ? seen.find((one) => one.mine && one.settings !== null) : undefined);
if (hers !== undefined) writeFileSync(file, hers.settings);
const hooksOf = (settings) => { try { return Object.keys(JSON.parse(settings).hooks ?? {}); } catch { return null; } };
console.log(marker + ":" + JSON.stringify({ me, claudes: seen.map(({ settings, ...one }) => ({ ...one, settings: settings !== null, hooks: settings === null ? null : hooksOf(settings) })), found: hers?.pid ?? null }));
`;

const QUESTION = {
  permission: "run pnpm db:migrate?",
  question: "Which database?",
  text: "What should the migration be called?",
};

/** Puts the stand-in where `command -v claude` resolves, and says how; `--restore` undoes it. */
const SWAP = `import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
const [dir, marker, mode] = process.argv.slice(2);
const sh = (cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };
const say = (fields) => console.log(marker + ":" + JSON.stringify(fields));
const capEff = /^CapEff:\\s*([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null;
const fowner = capEff !== null && (BigInt("0x" + capEff) & 8n) === 8n;
const path = sh("command -v claude").stdout.trim();
const bin = dirname(path);
const backup = path + ".mend-answer-orig";
const tried = [];
// Runs \`change\` in claude's directory: as the user can, else by CAP_FOWNER (sealantd grants it so
// pnpm can relink bins), which lets the user chmod the root-owned directory; its mode is put back.
const inBin = (change) => {
  if (writable(bin)) { change(); return "direct"; }
  tried.push(bin + " is not writable by " + userInfo().username);
  if (!fowner) { tried.push("no CAP_FOWNER (CapEff " + capEff + ")"); return null; }
  const before = statSync(bin).mode & 0o7777;
  try {
    chmodSync(bin, before | 0o002);
  } catch (error) {
    tried.push("chmod by CAP_FOWNER: " + error.message);
    return null;
  }
  try { change(); } finally { chmodSync(bin, before); }
  return "by CAP_FOWNER: " + bin + " made writable for the change, its mode " + before.toString(8) + " put back";
};
if (mode === "--restore") {
  const how = existsSync(backup) ? inBin(() => renameSync(backup, path)) : "nothing to restore";
  say({ restored: !existsSync(backup), how, tried, path, version: sh("claude --version").stdout.trim() });
  process.exit(0);
}
const shim = "#!/bin/sh\\nexec '" + process.execPath + "' '" + join(dir, "standin.mjs") + "' \\"$@\\"\\n";
const found = {
  path,
  real: path === "" ? null : realpathSync(path),
  symlink: path === "" ? null : lstatSync(path).isSymbolicLink(),
  dirWritable: path === "" ? null : writable(bin),
  capEff,
  fowner,
  user: userInfo().username,
  uid: userInfo().uid,
  pathEnv: process.env.PATH,
  node: process.execPath,
};
let how = null;
if (path === "") tried.push("no claude on PATH");
else if (existsSync(backup)) how = "already";
else how = inBin(() => { renameSync(path, backup); writeFileSync(path, shim, { mode: 0o755 }); });
if (how === null && path !== "") {
  const entries = (process.env.PATH ?? "").split(":");
  for (const entry of entries.slice(0, entries.indexOf(bin))) {
    if (entry === "" || !writable(entry)) continue;
    writeFileSync(join(entry, "claude"), shim, { mode: 0o755 });
    how = "earlier on PATH: " + entry;
    break;
  }
  if (how === null) tried.push("no writable directory before it on PATH");
}
say({ swap: { ...found, how, tried, backup, after: sh("command -v claude").stdout.trim(), version: sh("claude --version").stdout.trim() } });
`;

/** Prints the stand-in's record, one `<marker>:{i, line}` per line, then `<marker>-END:{count}`. */
const READ = `import { existsSync, readFileSync } from "node:fs";
const [file, marker] = process.argv.slice(2);
const lines = existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean) : [];
for (const [i, line] of lines.entries()) console.log(marker + ":" + JSON.stringify({ i, line: JSON.parse(line) }));
console.log(marker + "-END:" + JSON.stringify({ count: lines.length }));
`;

const heredoc = (dir, target, text) => [
  `base64 -d > "${dir}/${target}" <<'MEND_ANSWER_EOF'`,
  ...(Buffer.from(text)
    .toString("base64")
    .match(/.{1,76}/g) ?? []),
  "MEND_ANSWER_EOF",
];

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

const fail = (reason) => {
  throw new Error(reason);
};

/** The view as a person reads it: its message, then each group's rows as `name · line`. */
const grouped = ({ message, rows }) => {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.level === 1) {
      current = { group: row.label, count: row.description, rows: [] };
      groups.push(current);
    } else if (current !== null && row.level >= 2) {
      current.rows.push(row.description === "" ? row.label : `${row.label} · ${row.description}`);
    }
  }
  return { message, groups };
};

const shown = (seen) =>
  seen === null
    ? "the window navigated, its watch went with it"
    : `toasts ${JSON.stringify(seen.toasts)}`;

/** A request as the steps compare it: what Mend recorded. */
const said = (request) =>
  `${request.kind} "${request.title}" · ${request.status}${request.decision === null ? "" : ` · decision ${request.decision}`}${request.answers === null ? "" : ` · answers ${JSON.stringify(request.answers)}`}`;

export default async (h) => {
  const {
    step,
    note,
    api,
    state,
    sleep,
    view,
    viewRows,
    badge,
    statusBarItems,
    treeItem,
    notification,
    quickInput,
    watch,
    palette,
    windows,
    waitForWindow,
    useWindow,
    homeWindow,
    closeWindow,
    waitUntil,
    shot,
    page,
    serverLogs,
    terminal,
    newWindows,
  } = h;
  const via = process.env.MEND_VERIFY_ANSWER_VIA ?? "ui";
  expect(["ui", "api"].includes(via), `MEND_VERIFY_ANSWER_VIA is ui or api, not ${via}`);
  const ui = via === "ui";
  const launcher = process.env.MEND_VERIFY_ANSWER_LAUNCHER ?? "off";
  expect(
    ["off", "on", "only"].includes(launcher),
    `MEND_VERIFY_ANSWER_LAUNCHER is off, on or only, not ${launcher}`,
  );
  expect(
    launcher === "off" || ui,
    "section 10 answers through the editor: MEND_VERIFY_ANSWER_VIA=ui",
  );
  const only = launcher === "only";
  const out = resolve(parseArgs(process.argv.slice(2)).options.out);
  mkdirSync(out, { recursive: true });
  const project = state.project ?? fail("the run's ledger has no project: did up finish?");
  const origin = state.server?.origin ?? fail("the run's ledger has no server origin");
  const token = readFileSync(join(state.privateDir, "token.secret"), "utf8").trim();
  const secrets = loadSecrets(state.privateDir);
  const keep = (name, text) =>
    writeFileSync(join(out, name), redact(redactValues(String(text), secrets)));
  note(`answers go ${ui ? "through the editor" : "through the API (MEND_VERIFY_ANSWER_VIA=api)"}`);
  /** `Write an answer…` picked, then `text` typed into the input box it opens and Enter pressed. */
  const writeAnswer = async (text, slug) => {
    await quickInput.pick("Write an answer…", { exact: true });
    // The input box replaces the list a moment after the pick: typing sooner types into the list.
    await waitUntil("the answer's input box", async () =>
      (await quickInput.isOpen()) && (await quickInput.rows()).length === 0 ? true : null,
    );
    await quickInput.type(text);
    await waitUntil(`"${text}" in the input box`, async () =>
      (await quickInput.value()) === text ? true : null,
    );
    await shot(slug);
    await quickInput.accept();
  };

  /** A call that keeps the status and body, for the refusals the steps record. */
  const rawAs =
    (bearer) =>
    async (route, init = {}) => {
      const response = await fetch(`${origin}/api${route}`, {
        ...init,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      });
      const text = await response.text();
      let body = text;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {}
      return { status: response.status, body };
    };
  const raw = rawAs(token);
  const respondCount = async (requestId) =>
    (await serverLogs())
      .split("\n")
      .filter((line) => line.includes(`'/api/requests/${requestId}/respond'`)).length;

  // ── the view, as vscode-view.mjs reads it ──
  const claimFiles = () => {
    try {
      return readdirSync(
        join(state.userData, "User", "globalStorage", "sealant-sh.mend", "toasts"),
      );
    } catch {
      return [];
    }
  };
  const dismissWelcome = async () => {
    const skip = page().getByText("Continue without Signing In");
    if (await skip.isVisible().catch(() => false)) await skip.click();
  };
  const mendStatus = async () =>
    (await statusBarItems()).filter((text) => text.startsWith("Mend") || text.includes(" · "));
  const observe = async () => ({
    ...grouped(await viewRows()),
    badge: await badge("Mend"),
    statusBar: await mendStatus(),
  });
  const groupOf = (seen, name) => seen.groups.find((group) => group.group === name) ?? null;
  const rowIn = (seen, name, session) =>
    groupOf(seen, name)?.rows.find((row) => row.startsWith(`${session} · `)) ?? null;
  const rowAnywhere = (seen, session) => {
    for (const group of seen.groups) {
      const row = group.rows.find((one) => one.startsWith(`${session} · `));
      if (row !== undefined) return { group: group.group, row };
    }
    return null;
  };
  const until = async (what, check, limit = 60_000) => {
    let last = null;
    try {
      return await waitUntil(
        what,
        async () => {
          last = await observe();
          return check(last) ? last : null;
        },
        limit,
      );
    } catch (error) {
      throw new Error(`${error.message} · last read: ${last === null ? "none" : summary(last)}`);
    }
  };
  const summary = (seen) =>
    `badge "${seen.badge}" · status bar ${JSON.stringify(seen.statusBar)} · message "${seen.message}" · groups ${JSON.stringify(seen.groups.map(({ group, count, rows }) => ({ group, count, rows })))}`;
  const toastButtons = (pattern) =>
    page()
      .locator(".notifications-toasts .notification-toast-container", { hasText: pattern })
      .first()
      .locator(".notification-list-item-buttons-container .monaco-button")
      .evaluateAll((found) => found.map((button) => (button.textContent ?? "").trim()));
  /** The row's inline actions as drawn on hover: title and whether VS Code shows it disabled. */
  const rowActions = async (label) => {
    await treeItem(label).hover();
    await sleep(400);
    return page()
      .locator(".part.sidebar .monaco-list-row", { hasText: label })
      .first()
      .locator(".actions .action-label")
      .evaluateAll((found) =>
        found.map((action) => ({
          title: action.getAttribute("aria-label") ?? "",
          disabled:
            action.classList.contains("disabled") ||
            action.getAttribute("aria-disabled") === "true",
        })),
      );
  };

  // ── a conversation whose claude is the stand-in ──
  /**
   * A shell beside a session over `/api/tty`. A socket the server's restart cut attaches again to
   * the same process, or, when that process is gone, to a new shell; the text read so far is kept.
   */
  const tty = async (sessionId, call) => {
    const attached = { text: "", closed: null, processId: null, attaches: 0 };
    let socket = null;
    const decoder = new TextDecoder();
    const attach = async (processId) => {
      const { ticket } = await call("/upgrade-tickets", {
        method: "POST",
        body: JSON.stringify({ target: "tty", process: processId }),
      });
      const url = new URL(`${origin}/api/tty`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("process", processId);
      url.searchParams.set("ticket", ticket);
      const next = new WebSocket(url);
      next.binaryType = "arraybuffer";
      next.addEventListener("message", (event) => {
        attached.text +=
          typeof event.data === "string"
            ? event.data
            : decoder.decode(new Uint8Array(event.data), { stream: true });
      });
      await new Promise((resolveOpen, reject) => {
        next.addEventListener("open", resolveOpen, { once: true });
        next.addEventListener("error", () => reject(new Error("the tty did not open")), {
          once: true,
        });
      });
      next.addEventListener("close", (event) => (attached.closed = event.code));
      next.send(JSON.stringify({ t: "resize", cols: 240, rows: 50 }));
      socket = next;
      attached.closed = null;
      attached.processId = processId;
      attached.attaches += 1;
    };
    const open = async () => {
      const opened = await call(`/sessions/${sessionId}/shell`, { method: "POST", body: "{}" });
      const before = attached.text.length;
      await attach(opened.id);
      await waitUntil("the shell's prompt", () => attached.text.length > before, 60_000);
      await sleep(1_000);
    };
    await open();
    const ensure = async () => {
      if (attached.closed === null) return;
      const live = await sessionRead(sessionId, call)
        .then((detail) =>
          detail.processes.some((row) => row.id === attached.processId && row.exitedAt === null),
        )
        .catch(() => false);
      if (live) await attach(attached.processId).catch(() => open());
      else await open();
    };
    const encoder = new TextEncoder();
    let reads = 0;
    const lines = async (typed) => {
      await ensure();
      for (const line of typed) {
        expect(attached.closed === null, `the shell's socket closed (${attached.closed})`);
        socket.send(encoder.encode(`${line}\r`));
        await sleep(10);
      }
    };
    const markers = (prefix) =>
      [...attached.text.matchAll(new RegExp(`${prefix}:(\\{[^\\r\\n]*\\})`, "g"))].flatMap((m) => {
        try {
          return [JSON.parse(m[1])];
        } catch {
          return [];
        }
      });
    const marker = (prefix, limit = 60_000) =>
      waitUntil(`${prefix} in the shell`, () => markers(prefix)[0] ?? null, limit);
    return {
      attached,
      lines,
      marker,
      /** The stand-in's record as the workspace holds it now. */
      record: async () => {
        reads += 1;
        const prefix = `MEND-ANSWER-R${reads}`;
        await lines([`node "${DIR}/read.mjs" "${DIR}/record.jsonl" ${prefix}`]);
        const { count } = await marker(`${prefix}-END`, 30_000);
        const found = markers(prefix).map((entry) => entry.line);
        expect(found.length === count, `read ${found.length} of the record's ${count} lines`);
        return found;
      },
      close: () => socket?.close(),
    };
  };

  const sessionRead = (id, call) => call(`/sessions/${id}`);
  const liveProtocol = (detail) =>
    detail.processes.find((row) => row.kind === "agent-protocol" && row.exitedAt === null) ?? null;

  /** A claude session run as a terminal agent, the stand-in put in its workspace, then launched again as a conversation that asks. */
  const conversationWithStandin = async (label, call, who) => {
    const created = await call(`/projects/${project.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude", label, base: null, name: null }),
    });
    await call(`/sessions/${created.id}/launch`, {
      method: "POST",
      body: JSON.stringify({ permissionMode: "ask" }),
    });
    const pty = await waitUntil(
      `${label} running with a live agent-pty`,
      async () => {
        const now = await sessionRead(created.id, call);
        return now.session.status === "running"
          ? (now.processes.find((row) => row.kind === "agent-pty" && row.exitedAt === null) ?? null)
          : null;
      },
      600_000,
    );
    const shell = await tty(created.id, call);
    await shell.lines([
      `mkdir -p ${DIR} && chmod 777 ${DIR}`,
      ...heredoc(DIR, "standin.mjs", readFileSync(STANDIN, "utf8")),
      ...heredoc(DIR, "swap.mjs", SWAP),
      ...heredoc(DIR, "read.mjs", READ),
      `node "${DIR}/swap.mjs" ${DIR} MEND-ANSWER-SWAP`,
    ]);
    const { swap } = await shell.marker("MEND-ANSWER-SWAP", 60_000);
    keep(`${label}-swap.json`, JSON.stringify(swap, null, 2));
    if (swap.how === null)
      fail(
        `verified-unreachable · harness binary not writable: claude at ${swap.path} (${swap.real}), ${swap.tried.join("; ")}`,
      );
    expect(
      swap.version === VERSION,
      `after the swap \`claude --version\` reads "${swap.version}" (${swap.after}), not the stand-in`,
    );
    await call(`/sessions/${created.id}/stop`, { method: "POST", body: "{}" });
    const stopped = await waitUntil(
      `${label}'s terminal agent to end, the shell holding the workspace`,
      async () => {
        const now = await sessionRead(created.id, call);
        return now.processes.some((row) => row.id === pty.id && row.exitedAt !== null) &&
          !["running", "waiting", "stopping", "starting"].includes(now.session.status)
          ? now
          : null;
      },
      120_000,
    );
    await call(`/sessions/${created.id}/launch`, {
      method: "POST",
      body: JSON.stringify({
        mode: "protocol",
        permissionMode: "ask",
        prompt: `mend-ask:permission Add a rate limit to the API, then run pnpm db:migrate`,
      }),
    });
    const live = await waitUntil(
      `${label} live as a conversation`,
      async () => {
        const now = await sessionRead(created.id, call);
        return liveProtocol(now) === null ? null : now;
      },
      300_000,
    );
    const start = await waitUntil(
      "the stand-in to record Mend's protocol launch",
      async () =>
        (await shell.record()).find(
          (line) => line.start?.mode === "protocol" && line.start.argv.includes("--input-format"),
        ) ?? null,
      120_000,
    );
    return {
      id: created.id,
      name: label,
      who,
      call,
      shell,
      swap,
      launch: start.start,
      process: liveProtocol(live),
      stoppedAs: stopped.session.status,
    };
  };

  /** Mend's pending requests for a session, as `GET /sessions/:id/requests?pending=1` lists them. */
  const pending = (session) => session.call(`/sessions/${session.id}/requests?pending=1`);
  const requestById = async (session, id) =>
    (await session.call(`/sessions/${session.id}/requests`)).find((one) => one.id === id) ?? null;

  /** The open turn ended, so the next turn opens at once. */
  const settled = (session) =>
    waitUntil(
      `${session.name}'s turns to settle`,
      async () => {
        const turns = await session.call(`/sessions/${session.id}/turns`);
        return turns.every((turn) => !["queued", "running"].includes(turn.status)) ? turns : null;
      },
      60_000,
    );

  /** The next pending request, one Mend has not shown before; with `turn`, a turn sent to raise it. */
  const seenRequests = new Set();
  const nextRequest = async (session, turn = null) => {
    if (turn !== null) {
      await settled(session);
      await session.call(`/sessions/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({ input: turn }),
      });
    }
    const request = await waitUntil(
      `a new pending request on ${session.name}`,
      async () => (await pending(session)).find((one) => !seenRequests.has(one.id)) ?? null,
      60_000,
    );
    seenRequests.add(request.id);
    return request;
  };

  /** Mend recorded an answer; the stand-in received exactly one, and what it said. */
  const answered = async (session, request, want) => {
    const now = await waitUntil(
      `request ${request.id.slice(0, 8)} resolved`,
      async () => {
        const one = await requestById(session, request.id);
        return one?.status === "resolved" ? one : null;
      },
      30_000,
    );
    const responses = await waitUntil(
      "the stand-in to record the answer",
      async () => {
        const found = (await session.shell.record()).filter(
          (line) => line.responded?.requestId === request.providerRequestId,
        );
        return found.length > 0 ? found : null;
      },
      30_000,
    );
    await sleep(1_500);
    const after = (await session.shell.record()).filter(
      (line) => line.responded?.requestId === request.providerRequestId,
    );
    const got = after[0].responded;
    const observed = `Mend: ${said(now)} · decided by ${now.decidedBy === null ? "nobody" : now.decidedBy.slice(0, 8)} · the stand-in received ${after.length} response(s): ${JSON.stringify(got)}`;
    expect(after.length === 1 && responses.length === 1, `responses: ${observed}`);
    if (want.decision !== undefined) expect(now.decision === want.decision, observed);
    if (want.behavior !== undefined) expect(got.behavior === want.behavior, observed);
    if (want.answers !== undefined) {
      expect(JSON.stringify(now.answers) === JSON.stringify(want.answers), observed);
      expect(JSON.stringify(got.answers) === JSON.stringify(want.answers), observed);
    }
    return { now, got, observed };
  };

  /** The request Mend raised, in the words a step checks. */
  const asked = (request, kind) => {
    const detail = request.detail ?? {};
    const observed = `${said(request)} · provider ${request.providerRequestId}${request.questions === null ? ` · input ${JSON.stringify(detail.input ?? null)}` : ` · questions ${JSON.stringify(request.questions.map((one) => ({ id: one.id, question: one.question, options: one.options.map((option) => option.label) })))}`}`;
    if (kind === "permission")
      expect(
        request.kind === "tool-permission" &&
          request.title === "Bash" &&
          detail.input?.command === "pnpm db:migrate",
        `not Bash pnpm db:migrate: ${observed}`,
      );
    else {
      const [one] = request.questions ?? [];
      expect(request.kind === "user-input", `not user-input: ${observed}`);
      expect(one?.question === QUESTION[kind], `not "${QUESTION[kind]}": ${observed}`);
      const labels = (one?.options ?? []).map((option) => option.label).join(",");
      expect(
        kind === "question" ? labels === "staging,production" : labels === "",
        `options ${labels}: ${observed}`,
      );
    }
    return observed;
  };

  const respond = (session, request, body) =>
    session.call(`/requests/${request.id}/respond`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  /** Waits for the request's toast in the window in front: its text and buttons. */
  const toastFor = async (kind) => {
    const pattern = `${NAME} asks: ${QUESTION[kind]}`;
    const toast = notification(pattern);
    await toast.waitFor(30_000);
    return { toast, words: await toast.text(), buttons: await toastButtons(pattern) };
  };

  // ── setup ──
  await step(
    "Claude connected with the skill's fake setup token: mend connect claude --from-stdin",
    async () => {
      const ran = await world.cli(
        ["connect", "claude", "--from-stdin"],
        { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome },
        { input: FAKES.claude, allowFailure: true },
      );
      expect(ran.status === 0, `mend connect claude exited ${ran.status}: ${ran.stderr.trim()}`);
      return ran.stdout.trim();
    },
    { via: "setup" },
  );

  let dana = null;
  let ana = null;
  if (!only) {
    dana = await step(
      `1: ${NAME}, a claude terminal agent, its claude replaced by the stand-in from a shell beside it, stopped and launched again as a conversation that asks`,
      async () => {
        const session = await conversationWithStandin(NAME, api, "Dana");
        const detail = await sessionRead(session.id, api);
        return {
          observed: `claude at ${session.swap.path} (real ${session.swap.real}, symlink ${session.swap.symlink}) replaced ${session.swap.how} by ${session.swap.user} (uid ${session.swap.uid}) · terminal agent stopped, session read ${session.stoppedAs} · Mend launched the stand-in as uid ${session.launch.uid} (${session.launch.user}) with argv ${JSON.stringify(session.launch.argv)} · live ${session.process.kind} ${session.process.id.slice(0, 8)} · session ${detail.session.status}`,
          session,
        };
      },
      { via: "tty" },
    ).then((result) => result.session);

    if (ui) {
      await step("the Mend view in the home window", async () => {
        await useWindow(await homeWindow());
        await dismissWelcome();
        await view("Mend");
        return summary(await observe());
      });
    }

    // ── 2: Allow ──
    await step(
      `2: the launch's request (permission): ${ui ? "the toast reads add-rate-limit asks: run pnpm db:migrate? with Allow, Deny, More…, the row waits in Needs you, badge 1; Allow" : "respond {decision: accept}"} → accept, the stand-in allows`,
      async () => {
        const request = await nextRequest(dana);
        const raised = asked(request, "permission");
        let shown = "answered through the API";
        if (ui) {
          const seen = await until(
            `${NAME} in Needs you`,
            (now) =>
              rowIn(now, "Needs you", NAME)?.startsWith(
                `${NAME} · waiting · ${QUESTION.permission}`,
              ) === true && now.badge === "1",
            30_000,
          );
          const { toast, words, buttons } = await toastFor("permission");
          await shot("2-allow-toast");
          expect(
            JSON.stringify(buttons) === JSON.stringify(["Allow", "Deny", "More…"]),
            `buttons ${JSON.stringify(buttons)}`,
          );
          await toast.click("Allow");
          shown = `toast "${words}" · buttons ${JSON.stringify(buttons)} · ${summary(seen)}`;
        } else await respond(dana, request, { decision: "accept" });
        const result = await answered(dana, request, { decision: "accept", behavior: "allow" });
        let after = "";
        if (ui) {
          const seen = await until(
            `${NAME} to leave Needs you, the badge to clear`,
            (now) => rowIn(now, "Needs you", NAME) === null && now.badge === "",
            30_000,
          );
          await shot("2-allowed");
          after = ` · then ${summary(seen)}`;
        }
        return {
          observed: `${raised} · ${shown} · ${result.observed}${after}`,
          request: request.id,
        };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 3: Deny ──
    await step(
      `3: the next permission: ${ui ? "the toast's Deny" : "respond {decision: decline}"} → decline, the stand-in denies`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:permission run the migrations again");
        const raised = asked(request, "permission");
        let shown = "answered through the API";
        if (ui) {
          const { toast, words, buttons } = await toastFor("permission");
          await shot("3-deny-toast");
          await toast.click("Deny");
          shown = `toast "${words}" · buttons ${JSON.stringify(buttons)}`;
        } else await respond(dana, request, { decision: "decline" });
        const result = await answered(dana, request, { decision: "decline", behavior: "deny" });
        return { observed: `${raised} · ${shown} · ${result.observed}`, request: request.id };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 4: More… with a typed answer ──
    // Spaces around it: what she typed arrives as she typed it, never trimmed.
    const typed = "  the reporting replica  ";
    await step(
      `4: a question with two options: ${ui ? "the toast offers staging, production, More…; More… → Write an answer… → typed" : "respond {answers: {target: [typed]}}"} → the stand-in receives answers.target = ["${typed}"]`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:question which database?");
        const raised = asked(request, "question");
        let shown = "answered through the API";
        if (ui) {
          const { toast, words, buttons } = await toastFor("question");
          expect(
            JSON.stringify(buttons) === JSON.stringify(["staging", "production", "More…"]),
            `buttons ${JSON.stringify(buttons)}`,
          );
          await toast.click("More…");
          await quickInput.waitFor(15_000);
          const title = await quickInput.title();
          const items = (await quickInput.rows()).map((row) => row.label);
          await shot("4-more-pick");
          expect(
            title === `${NAME} asks: ${QUESTION.question}` &&
              JSON.stringify(items) ===
                JSON.stringify(["staging", "production", "Write an answer…"]),
            `quick pick "${title}" · items ${JSON.stringify(items)}`,
          );
          await writeAnswer(typed, "4-typed");
          shown = `toast "${words}" · buttons ${JSON.stringify(buttons)} · quick pick "${title}" ${JSON.stringify(items)} · typed "${typed}"`;
        } else await respond(dana, request, { answers: { target: [typed] } });
        const result = await answered(dana, request, { answers: { target: [typed] } });
        return { observed: `${raised} · ${shown} · ${result.observed}`, request: request.id };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 4b: a free-text question ──
    const named = "add_rate_limits";
    await step(
      `4b: a question with no options: ${ui ? "the toast offers Answer…; Answer… → an input box → typed" : "respond {answers: {name: [typed]}}"} → the stand-in receives answers.name = ["${named}"]`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:text name the migration");
        const raised = asked(request, "text");
        let shown = "answered through the API";
        if (ui) {
          const { toast, words, buttons } = await toastFor("text");
          expect(
            JSON.stringify(buttons) === JSON.stringify(["Answer…"]),
            `buttons ${JSON.stringify(buttons)}`,
          );
          await toast.click("Answer…");
          await quickInput.waitFor(15_000);
          const rows = (await quickInput.rows()).map((row) => row.label);
          expect(
            JSON.stringify(rows) === JSON.stringify(["Write an answer…"]),
            `rows ${JSON.stringify(rows)}`,
          );
          await writeAnswer(named, "4b-typed");
          shown = `toast "${words}" · buttons ${JSON.stringify(buttons)} · first rows ${JSON.stringify(rows)}`;
        } else await respond(dana, request, { answers: { name: [named] } });
        const result = await answered(dana, request, { answers: { name: [named] } });
        return { observed: `${raised} · ${shown} · ${result.observed}`, request: request.id };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 5: the row's Answer ──
    await step(
      `5: a question again: ${ui ? "the row's Answer opens the quick pick, production picked" : "respond {answers: {target: [production]}}"} → recorded`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:question which database now?");
        const raised = asked(request, "question");
        let shown = "answered through the API";
        if (ui) {
          await until(
            `${NAME} waiting in Needs you`,
            (now) => rowIn(now, "Needs you", NAME)?.includes(QUESTION.question) === true,
            30_000,
          );
          const found = await treeItem(NAME).inline(/Answer/);
          await quickInput.waitFor(15_000);
          const title = await quickInput.title();
          const items = (await quickInput.rows()).map((row) => row.label);
          await shot("5-row-answer");
          await quickInput.pick("production", { exact: true });
          shown = `row action "${found.title}" · quick pick "${title}" ${JSON.stringify(items)}`;
        } else await respond(dana, request, { answers: { target: ["production"] } });
        const result = await answered(dana, request, { answers: { target: ["production"] } });
        return { observed: `${raised} · ${shown} · ${result.observed}`, request: request.id };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 6: answered elsewhere ──
    await step(
      `6: answered elsewhere: a permission toasts, Mend answers it through the API first, ${ui ? "then the toast's Allow" : "then the API again"} → one respond reaches the stand-in`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:permission once more");
        const raised = asked(request, "permission");
        const toasted = ui ? await toastFor("permission") : null;
        await respond(dana, request, { decision: "accept" });
        await answered(dana, request, { decision: "accept", behavior: "allow" });
        let second;
        if (ui) {
          await toasted.toast.click("Allow");
          await sleep(3_000);
          second = "the toast's Allow clicked";
        } else {
          const again = await raw(`/requests/${request.id}/respond`, {
            method: "POST",
            body: JSON.stringify({ decision: "accept" }),
          });
          second = `a second respond answered ${again.status} ${JSON.stringify(again.body)}`;
          expect(again.status === 409, second);
        }
        const posts = await respondCount(request.id);
        const result = await answered(dana, request, { decision: "accept", behavior: "allow" });
        let bar = "";
        if (ui) {
          const items = await mendStatus();
          await shot("6-answered-elsewhere");
          bar = ` · status bar ${JSON.stringify(items)}`;
          expect(
            items.some((text) => text.startsWith(`${NAME} · `)),
            `the status bar names no ${NAME} line: ${JSON.stringify(items)}`,
          );
        }
        const observed = `${raised}${toasted === null ? "" : ` · toast "${toasted.words}"`} · ${second} · POST /api/requests/${request.id.slice(0, 8)}…/respond in the server log: ${posts} · ${result.observed}${bar}`;
        expect(posts === (ui ? 1 : 2), `respond POSTs: ${observed}`);
        return { observed, request: request.id };
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 7: two windows ──
    await step(
      `7: two windows: ${ui ? "both show the badge, one toast across them" : "the request is listed once for Dana"}`,
      async () => {
        if (!ui) {
          const request = await nextRequest(dana, "mend-ask:permission with two windows open");
          const raised = asked(request, "permission");
          const listed = (await pending(dana)).filter((one) => one.id === request.id).length;
          await respond(dana, request, { decision: "accept" });
          const result = await answered(dana, request, { decision: "accept", behavior: "allow" });
          expect(listed === 1, `listed ${listed} times`);
          return `${raised} · pending lists it ${listed} time(s) · ${result.observed}`;
        }
        const home = await homeWindow();
        await useWindow(home);
        const known = await windows();
        await palette("New Window");
        const second = await waitForWindow(known);
        await useWindow(second);
        await sleep(5_000);
        await dismissWelcome();
        await view("Mend");
        await useWindow(home);
        const homeWatch = await watch();
        await useWindow(second);
        const secondWatch = await watch();
        const claimsBefore = claimFiles();
        const request = await nextRequest(dana, "mend-ask:permission with two windows open");
        const raised = asked(request, "permission");
        await sleep(8_000);
        const claimed = claimFiles().filter((name) => !claimsBefore.includes(name));
        const secondSeen = await secondWatch.stop();
        const secondBadge = await badge("Mend");
        await shot("7-second-window");
        await useWindow(home);
        const homeSeen = await homeWatch.stop();
        const homeBadge = await badge("Mend");
        await shot("7-home-window");
        const toasts = (seen) =>
          seen === null ? 0 : seen.toasts.filter((text) => text.includes(`${NAME} asks:`)).length;
        const toasted = [homeSeen, secondSeen].filter((seen) => toasts(seen) > 0).length;
        await respond(dana, request, { decision: "accept" });
        const result = await answered(dana, request, { decision: "accept", behavior: "allow" });
        await useWindow(second);
        await closeWindow(second);
        await useWindow(await homeWindow());
        const observed = `${raised} · home ${shown(homeSeen)} badge "${homeBadge}" · second ${shown(secondSeen)} badge "${secondBadge}" · windows that toasted: ${toasted} · claims made ${JSON.stringify(claimed)} · ${result.observed}`;
        expect(homeBadge === "1" && secondBadge === "1", `badges: ${observed}`);
        expect(toasted === 1 && toasts(homeSeen) + toasts(secondSeen) === 1, `toasts: ${observed}`);
        return observed;
      },
      { via: ui ? "dom" : "api" },
    );
  }

  // ── 8: Ana's session ──
  let asAna = null;
  let anaBearer = null;
  await step(
    "8 setup: Ana joins, the project is shared, her claude connected",
    async () => {
      const { token: invitation } = await api("/organization/invitations", {
        method: "POST",
        body: JSON.stringify({ role: "member" }),
      });
      const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-mend-invitation": invitation },
        body: JSON.stringify({
          email: `ana-${state.run}-${Date.now().toString(36)}@verify.invalid`,
          password: `ana-${crypto.randomUUID()}`,
          name: "Ana",
        }),
      });
      anaBearer = signUp.headers.get("set-auth-token");
      expect(signUp.ok && anaBearer, `Ana's sign-up answered ${signUp.status}`);
      asAna = world.makeApi(origin, anaBearer);
      await api(`/projects/${project.id}/visibility`, {
        method: "PUT",
        body: JSON.stringify({ visibility: "shared" }),
      });
      const scratch = join(state.scratch, `ana-cli-${Date.now().toString(36)}`);
      try {
        mkdirSync(join(scratch, "mend"), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(scratch, "mend", "cli.json"),
          JSON.stringify({ url: origin, token: anaBearer }),
          {
            mode: 0o600,
          },
        );
        const ran = await world.cli(
          ["connect", "claude", "--from-stdin"],
          { ...process.env, HOME: scratch, XDG_CONFIG_HOME: scratch },
          { input: FAKES.claude, allowFailure: true },
        );
        expect(ran.status === 0, `mend connect claude as Ana exited ${ran.status}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      return "Ana is a member · the project is shared · her claude reads connected";
    },
    { via: "api" },
  );

  if (!only) {
    ana = await step(
      `8: Ana's own conversation ${ANA_NAME} with the stand-in, set up as she runs it, shared control off`,
      async () => {
        const session = await conversationWithStandin(ANA_NAME, asAna, "Ana");
        const { session: read } = await sessionRead(session.id, asAna);
        expect(read.sharedControlEnabledAt === null, "shared control is on");
        return {
          observed: `claude replaced ${session.swap.how} · Mend launched the stand-in as uid ${session.launch.uid} · live ${session.process.kind}, runs as ${session.process.runsAs === undefined ? "(not in the read)" : session.process.runsAs === read.ownerUserId ? "Ana" : session.process.runsAs} · shared control off`,
          session,
        };
      },
      { via: "tty" },
    ).then((result) => result.session);

    const anaRequest = await step(
      `8: Ana's request, shared control off: ${ui ? `Dana's row reads waiting · Ana's session with no Answer, the badge does not count it; ` : ""}Dana's respond is refused`,
      async () => {
        const request = await nextRequest(ana);
        const raised = asked(request, "permission");
        let row = "";
        if (ui) {
          await useWindow(await homeWindow());
          await view("Mend");
          const seen = await until(
            `${ANA_NAME} waiting in Dana's view`,
            (now) => rowAnywhere(now, ANA_NAME)?.row.startsWith(`${ANA_NAME} · waiting`) === true,
            60_000,
          );
          const where = rowAnywhere(seen, ANA_NAME);
          const actions = await rowActions(ANA_NAME);
          await shot("8-ana-off");
          row = ` · ${where.group} "${where.row}" · actions ${JSON.stringify(actions)} · ${summary(seen)}`;
          expect(where.row.startsWith(`${ANA_NAME} · waiting · Ana's session`), `row${row}`);
          expect(where.group !== "Needs you" && seen.badge === "", `counted${row}`);
          expect(!actions.some((action) => /Answer/.test(action.title)), `Answer offered${row}`);
        }
        const refused = await raw(`/requests/${request.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ decision: "accept" }),
        });
        const still = await requestById(ana, request.id);
        const observed = `${raised}${row} · Dana's respond answered ${refused.status} ${JSON.stringify(refused.body)} · the request reads ${still.status}`;
        expect(refused.status === 403 && still.status === "pending", observed);
        return { observed, request };
      },
      { via: ui ? "dom" : "api" },
    ).then((result) => result.request);

    await step(
      `8: Ana turns on shared control: Dana's respond is still refused (her agent runs as Ana)${ui ? ", and the row says so" : ""}; Ana answers`,
      async () => {
        await asAna(`/sessions/${ana.id}/shared-control`, {
          method: "PUT",
          body: JSON.stringify({ enabled: true }),
        });
        let row = "";
        if (ui) {
          await sleep(5_000);
          const seen = await observe();
          const where = rowAnywhere(seen, ANA_NAME);
          const actions = await rowActions(ANA_NAME);
          await shot("8-ana-shared");
          row = ` · ${where?.group ?? "no group"} "${where?.row ?? ""}" · actions ${JSON.stringify(actions)} · ${summary(seen)}`;
        }
        const refused = await raw(`/requests/${anaRequest.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ decision: "accept" }),
        });
        const words = typeof refused.body === "object" ? refused.body?.message : refused.body;
        expect(
          refused.status === 403 && /Only Ana can answer this/.test(String(words)),
          `Dana's respond with shared control on answered ${refused.status} ${JSON.stringify(refused.body)}`,
        );
        await asAna(`/requests/${anaRequest.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ decision: "accept" }),
        });
        const result = await answered(ana, anaRequest, { decision: "accept", behavior: "allow" });
        return `shared control on · Dana's respond answered ${refused.status} "${words}"${row} · then Ana answered: ${result.observed}`;
      },
      { via: ui ? "dom" : "api" },
    );

    // ── 9: offline ──
    await step(
      `9: offline: a request pending, the server stopped${ui ? ": the row's Answer reads Mend is offline and is disabled" : ""}; started again, what Mend says of the request`,
      async () => {
        const request = await nextRequest(dana, "mend-ask:permission while Mend is away");
        const raised = asked(request, "permission");
        let offline = "";
        if (ui) {
          await useWindow(await homeWindow());
          await view("Mend");
          await until(
            `${NAME} waiting in Needs you`,
            (now) => rowIn(now, "Needs you", NAME) !== null,
            30_000,
          );
        }
        const docker = (args) =>
          world.run("docker", ["--context", state.context, ...args], {
            timeout: 120_000,
            env: { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome },
          });
        await docker(["stop", "-t", "5", state.server.container]);
        try {
          if (ui) {
            const seen = await until(
              "the view to say Mend is unreachable",
              (now) => now.message.startsWith("last heard from Mend at"),
              90_000,
            );
            const actions = await rowActions(NAME);
            await shot("9-offline");
            offline = ` · offline: ${summary(seen)} · ${NAME}'s actions ${JSON.stringify(actions)}`;
            const answer = actions.find((action) => action.title === "Mend is offline");
            expect(answer?.disabled === true, `the Answer action${offline}`);
          }
        } finally {
          await docker(["start", state.server.container]);
        }
        const back = await waitUntil(
          "the server to answer again",
          async () => (await raw("/sessions")).status === 200 || null,
          240_000,
        );
        const after = await waitUntil(
          "Mend to read the request after the restart",
          async () => (await requestById(dana, request.id)) ?? null,
          60_000,
        );
        const detail = await sessionRead(dana.id, api);
        const protocol = liveProtocol(detail);
        let answer = "not answered (it is not pending)";
        if (after.status === "pending") {
          const sent = await raw(`/requests/${request.id}/respond`, {
            method: "POST",
            body: JSON.stringify({ decision: "accept" }),
          });
          answer = `a respond after the restart answered ${sent.status}${sent.status === 200 ? "" : ` ${JSON.stringify(sent.body)}`}`;
        }
        let recovered = "";
        if (ui) {
          const seen = await until("the view to recover", (now) => now.message === "", 240_000);
          await shot("9-online-again");
          recovered = ` · online again: ${summary(seen)}`;
        }
        const record = (await dana.shell.record()).filter(
          (line) =>
            line.responded?.requestId === request.providerRequestId || line.end !== undefined,
        );
        return `${raised}${offline} · back ${back} · after the restart Mend reads ${said(after)} · protocol process ${protocol === null ? "none live" : `${protocol.id.slice(0, 8)} live`} · ${answer} · the stand-in's record for it ${JSON.stringify(record)}${recovered}`;
      },
      { via: ui ? "dom" : "setup" },
    );
  }

  // ── 10: Dana's terminal agent in a workspace Ana launched ──
  async function launcherSection() {
    // Fresh labels, so a second drive in one world reads its own rows.
    const stamp = Date.now().toString(36).slice(-4);
    const anaLabel = `${ANA_HOLDS}-${stamp}`;
    const danaLabel = `${DANA_TERMINAL}-${stamp}`;
    const failures = [];
    /** A step whose failure is kept while the section goes on, so one run shows every defect. */
    const checked = (name, fn, options) =>
      step(name, fn, options).catch((error) => {
        failures.push(error.message);
        return null;
      });
    const livePty = (detail) =>
      detail.processes.find((row) => row.kind === "agent-pty" && row.exitedAt === null) ?? null;
    const runningPty = (label, id, call) =>
      waitUntil(
        `${label} running with a live agent-pty`,
        async () => {
          const now = await sessionRead(id, call);
          return now.session.status === "running" &&
            livePty(now) !== null &&
            now.session.sealantWorkspaceId !== null
            ? now
            : null;
        },
        600_000,
      );
    const tail = async (pattern) =>
      (await serverLogs())
        .split("\n")
        .filter((line) => pattern.test(line))
        .slice(-5)
        .join(" / ");

    const holds = await step(
      `10 setup: Ana's claude terminal agent ${anaLabel} in a fresh worktree, launched by her, so the workspace is hers`,
      async () => {
        const created = await asAna(`/projects/${project.id}/sessions`, {
          method: "POST",
          body: JSON.stringify({ harness: "claude", label: anaLabel, base: null, name: null }),
        });
        await asAna(`/sessions/${created.id}/launch`, {
          method: "POST",
          body: JSON.stringify({ permissionMode: "ask" }),
        });
        const { session } = await runningPty(anaLabel, created.id, asAna);
        expect(
          session.workspaceLauncherUserId === session.ownerUserId,
          `the workspace's launcher reads ${session.workspaceLauncherUserId}, not Ana (${session.ownerUserId})`,
        );
        return {
          observed: `${anaLabel} running · worktree ${session.worktreeId} · workspace ${session.sealantWorkspaceId} · workspaceLauncherUserId is Ana`,
          id: created.id,
          worktreeId: session.worktreeId,
          workspaceId: session.sealantWorkspaceId,
          anaId: session.ownerUserId,
        };
      },
      { via: "api" },
    );

    const mine = await step(
      `10 setup: Dana's own claude terminal agent ${danaLabel} in that worktree (POST /worktrees/:id/sessions), launched in ask mode: it joins Ana's workspace`,
      async () => {
        let created;
        try {
          created = await api(`/worktrees/${holds.worktreeId}/sessions`, {
            method: "POST",
            body: JSON.stringify({ harness: "claude", label: danaLabel }),
          });
          await api(`/sessions/${created.id}/launch`, {
            method: "POST",
            body: JSON.stringify({ permissionMode: "ask" }),
          });
        } catch (error) {
          throw new Error(
            `${error.message} · server log: ${await tail(/worktrees|launch|refus|denied|forbidden/i)}`,
          );
        }
        await runningPty(danaLabel, created.id, api);
        // A fresh claude's row records its --session-id pin at launch; a row without one is
        // claimed by the agent's first SessionStart (agentHookTarget).
        const detail = await waitUntil(
          `${danaLabel}'s agent row to record its --session-id`,
          async () => {
            const now = await sessionRead(created.id, api);
            return livePty(now)?.providerSessionId ? now : null;
          },
          15_000,
        ).catch(() => sessionRead(created.id, api));
        const { session } = detail;
        const agent = livePty(detail);
        const observed = `${danaLabel} running · owner ${session.ownerUserId === holds.anaId ? "Ana" : "Dana"} · workspace ${session.sealantWorkspaceId === holds.workspaceId ? "Ana's" : session.sealantWorkspaceId} · workspaceLauncherUserId ${session.workspaceLauncherUserId === holds.anaId ? "Ana" : session.workspaceLauncherUserId} · agent-pty ${agent.id.slice(0, 8)} --session-id ${agent.providerSessionId}`;
        expect(session.ownerUserId !== holds.anaId, `Dana's session is not hers: ${observed}`);
        expect(
          session.sealantWorkspaceId === holds.workspaceId &&
            session.workspaceLauncherUserId === holds.anaId,
          `not in the workspace Ana launched: ${observed}`,
        );
        return {
          observed,
          id: created.id,
          agentId: agent.id,
          agentSession: agent.providerSessionId ?? null,
        };
      },
      { via: "api" },
    );

    await useWindow(await homeWindow());
    await dismissWelcome();
    await view("Mend");
    const baseline = await step(
      `10: Dana's view before her agent waits: ${danaLabel} is listed, not waiting`,
      async () => {
        const seen = await until(
          `${danaLabel} in Dana's view`,
          (now) => rowAnywhere(now, danaLabel) !== null,
          60_000,
        );
        const where = rowAnywhere(seen, danaLabel);
        await shot("10-before-wait");
        return {
          observed: `${where.group} "${where.row}" · ${summary(seen)}`,
          badge: seen.badge === "" ? 0 : Number(seen.badge),
        };
      },
    );

    const shell = await tty(mine.id, api);
    await step(
      `10 setup: from a shell beside ${danaLabel}, the hook stand-in replays PermissionRequest (Bash) through the hooks on her claude's command line (SessionStart first when her row records no --session-id, as claude's own first hook claims it): the session reads waiting · permission · Bash`,
      async () => {
        const reportAs = mine.agentSession ?? crypto.randomUUID();
        const events =
          mine.agentSession === null ? "SessionStart,PermissionRequest" : "PermissionRequest";
        await shell.lines([
          "D=$(mktemp -d /tmp/mend-answer-launcher.XXXXXX)",
          ...heredoc("$D", "claude-standin.mjs", readFileSync(HOOK_STANDIN, "utf8")),
          ...heredoc("$D", "settings-of.mjs", SETTINGS_OF),
          `node "$D/settings-of.mjs" ${mine.agentSession ?? "none"} "$D/settings.json" MEND-ANSWER-SETTINGS`,
        ]);
        const found = await shell.marker("MEND-ANSWER-SETTINGS", 30_000);
        const claudes = JSON.stringify(found.claudes);
        expect(
          found.found !== null,
          `no claude of hers with --settings (--session-id ${mine.agentSession}, shell uid ${found.me}): ${claudes}`,
        );
        await shell.lines([
          `node "$D/claude-standin.mjs" --settings "$D/settings.json" --session-id ${reportAs} --events ${events} --pause-ms 1000 --marker MEND-ANSWER-HOOK`,
        ]);
        const event = await waitUntil(
          "the stand-in to fire PermissionRequest",
          () =>
            [...shell.attached.text.matchAll(/MEND-ANSWER-HOOK:(\{[^\r\n]*\})/g)]
              .map((m) => {
                try {
                  return JSON.parse(m[1]);
                } catch {
                  return null;
                }
              })
              .find((line) => line?.event === "PermissionRequest") ?? null,
          60_000,
        );
        const bad = event.hooks.filter((hook) => hook.exitCode !== 0 || hook.timedOut);
        expect(
          event.hooks.length > 0 && bad.length === 0,
          `the hooks ran ${JSON.stringify(event.hooks.map(({ exitCode, timedOut }) => ({ exitCode, timedOut })))} · claudes ${claudes} (hers pid ${found.found})`,
        );
        const detail = await waitUntil(
          `${danaLabel} to read waiting`,
          async () => {
            const now = await sessionRead(mine.id, api);
            return now.session.status === "waiting" &&
              now.currentAgent?.waiting?.kind === "permission"
              ? now
              : null;
          },
          30_000,
        );
        const { waiting } = detail.currentAgent;
        const pinned = (await sessionRead(mine.id, api)).processes.find(
          (row) => row.id === mine.agentId,
        )?.providerSessionId;
        return `claudes in the workspace ${claudes} (hers pid ${found.found}) · events ${events} under ${mine.agentSession === null ? `a fresh id, her row now records ${pinned === reportAs ? "it" : pinned}` : "her row's --session-id"} · hooks exited ${event.hooks.map((hook) => hook.exitCode).join(",")} · session ${detail.session.status} · ${waiting.kind} · ${waiting.tool} · since ${waiting.since}`;
      },
      { via: "tty" },
    );

    await checked(
      `10: Dana's view: ${danaLabel} in Needs you with Answer, the badge counts it`,
      async () => {
        let seen = null;
        try {
          seen = await until(
            `${danaLabel} in Needs you and the badge at ${baseline.badge + 1}`,
            (now) =>
              rowIn(now, "Needs you", danaLabel) !== null &&
              now.badge === String(baseline.badge + 1),
            30_000,
          );
        } catch {
          seen = await observe();
        }
        const where = rowAnywhere(seen, danaLabel);
        const actions = await rowActions(danaLabel);
        await shot("10-waits");
        const observed = `${where.group} "${where.row}" · actions ${JSON.stringify(actions.map((one) => one.title))} · badge "${seen.badge}" (was ${baseline.badge}) · ${summary(seen)}`;
        expect(where.group === "Needs you", `not in Needs you: ${observed}`);
        expect(
          seen.badge === String(baseline.badge + 1),
          `the badge does not count it: ${observed}`,
        );
        expect(
          actions.some((one) => /Answer/.test(one.title)),
          `the row offers no Answer: ${observed}`,
        );
        return observed;
      },
    );

    await checked(
      `10: Answer attaches ${danaLabel}'s claude as a terminal tab in Dana's window: no window opens, no "no agent attached" line`,
      async () => {
        await useWindow(await homeWindow());
        await view("Mend");
        const known = await windows();
        const tabsBefore = await terminal().tabs();
        const seen = await watch();
        const actions = await rowActions(danaLabel);
        let gesture;
        if (actions.some((one) => /Answer/.test(one.title))) {
          const found = await treeItem(danaLabel).inline(/Answer/);
          gesture = `the row's ${typeof found === "string" ? found : (found?.title ?? "Answer")}`;
        } else {
          // The row offers no Answer: she asks for it from the palette, as she still can.
          await palette("Mend: Answer");
          await quickInput.waitFor(15_000);
          await quickInput.pick(danaLabel);
          gesture = "the palette's Mend: Answer, the session picked (the row offered no Answer)";
        }
        const want = `claude · ${danaLabel}`;
        const tabs = await waitUntil(
          `a ${want} tab`,
          async () => {
            const now = await terminal().tabs();
            return now.names.some((name) => name.includes(want)) ? now : null;
          },
          30_000,
        ).catch(async () => terminal().tabs());
        await sleep(3_000);
        const shown = await seen.stop();
        const opened = await newWindows(known);
        const bar = await statusBarItems();
        const refusal = [...(shown?.statusBar ?? []), ...bar].filter((text) =>
          text.includes("no agent attached"),
        );
        await shot("10-answered");
        const attached = tabs.names.some((name) => name.includes(want));
        const observed = `${gesture} · tabs before ${JSON.stringify(tabsBefore.names)} · after ${JSON.stringify(tabs.names)} (active ${JSON.stringify(tabs.active)}) · new windows ${opened.length} · status line ${refusal.length === 0 ? "none refusing" : JSON.stringify([...new Set(refusal)])}`;
        expect(refusal.length === 0, `refused: ${observed}`);
        expect(attached, `no ${want} tab: ${observed}`);
        expect(opened.length === 0, `a window opened: ${observed}`);
        return observed;
      },
    );

    keep(`${danaLabel}-shell.txt`, shell.attached.text);
    shell.close();
    expect(failures.length === 0, `section 10: ${failures.join(" | ")}`);
  }

  if (launcher !== "off") await launcherSection();

  // ── evidence ──
  for (const session of [dana, ana]) {
    if (session === null || session === undefined) continue;
    keep(
      `${session.name}-record.jsonl`,
      (await session.shell.record()).map((line) => JSON.stringify(line)).join("\n"),
    );
    keep(
      `${session.name}-requests.json`,
      JSON.stringify(await session.call(`/sessions/${session.id}/requests`), null, 2),
    );
    await session.shell.lines([`node "${DIR}/swap.mjs" ${DIR} MEND-ANSWER-RESTORE --restore`]);
    const restored = await session.shell.marker("MEND-ANSWER-RESTORE", 30_000).catch(() => null);
    keep(`${session.name}-shell.txt`, session.shell.attached.text);
    session.shell.close();
    note(`${session.name}: claude restored ${JSON.stringify(restored)}`);
  }
  note(
    `evidence: steps.jsonl, ${[dana, ana]
      .filter((one) => one !== null)
      .map((one) => `${one.name}-{swap.json,record.jsonl,requests.json,shell.txt}`)
      .join(", ")} in ${out}`,
  );
};
