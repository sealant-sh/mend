// Answer on Dana's own terminal agent in a workspace Ana launched (rule 8): Ana launches a claude
// terminal agent in a fresh worktree, so the workspace is hers; Dana starts her own claude
// terminal agent in that worktree, and it joins Ana's workspace. A hook stand-in
// (`fixtures/claude-standin.mjs`) replays `PermissionRequest` through the hooks on Dana's claude's
// command line, as recipes/g4-terminal-agent-waits.mjs does, so her session reads waiting; the
// claude in the PTY is real. Dana's view lists it in Needs you with Answer, and Answer attaches it
// as a terminal tab in her window over `/api/tty`, not Remote-SSH: no window opens.
//
// It needs a server with terminal-agent waits (G4), newer than 0.36.0-next.1033: an image built
// from main with `up --build`.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-answer-launcher.mjs --out <dir>

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseArgs } from "../scripts/drive-vscode.lib.mjs";
import { FAKES } from "../scripts/fakes.mjs";
import { redact } from "../scripts/redact.mjs";
import { loadSecrets, redactValues } from "../scripts/secrets.mjs";
import { expect, fail, grouped, heredoc, world } from "./vscode-answer.mjs";

const HOOK_STANDIN = join(import.meta.dirname, "../scripts/fixtures/claude-standin.mjs");
const ANA_HOLDS = "ana-holds-workspace";
const DANA_TERMINAL = "dana-in-anas-workspace";
/** What claude draws under its prompt: `shift+tab to cycle`, `Shift+Tab to change mode`. */
const CLAUDE_DRAWS = /shift\+tab/i;
/** What `TtyAttachment` writes into the tab when its ticket, its socket or the process fails. */
const ATTACH_ERROR =
  /Mend refused this terminal|could not reach Mend|reattaching|Mend did not open the terminal|connection lost|the process ended|no longer lets this editor|shared control off|tried \d+ times/;

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
    quickInput,
    watch,
    palette,
    windows,
    useWindow,
    homeWindow,
    waitUntil,
    shot,
    page,
    serverLogs,
    terminal,
    newWindows,
  } = h;
  const out = resolve(parseArgs(process.argv.slice(2)).options.out);
  mkdirSync(out, { recursive: true });
  const project = state.project ?? fail("the run's ledger has no project: did up finish?");
  const origin = state.server?.origin ?? fail("the run's ledger has no server origin");
  const secrets = loadSecrets(state.privateDir);
  const keep = (name, text) =>
    writeFileSync(join(out, name), redact(redactValues(String(text), secrets)));

  // ── the view, as vscode-answer.mjs reads it ──
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
  const rowIn = (seen, name, session) =>
    seen.groups
      .find((group) => group.group === name)
      ?.rows.find((row) => row.startsWith(`${session} · `)) ?? null;
  const rowAnywhere = (seen, session) => {
    for (const group of seen.groups) {
      const row = group.rows.find((one) => one.startsWith(`${session} · `));
      if (row !== undefined) return { group: group.group, row };
    }
    return null;
  };
  const summary = (seen) =>
    `badge "${seen.badge}" · status bar ${JSON.stringify(seen.statusBar)} · message "${seen.message}" · groups ${JSON.stringify(seen.groups.map(({ group, count, rows }) => ({ group, count, rows })))}`;
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

  const sessionRead = (id, call) => call(`/sessions/${id}`);
  /** A shell beside a session over `/api/tty`, its text kept as it arrives. */
  const tty = async (sessionId, call) => {
    const opened = await call(`/sessions/${sessionId}/shell`, { method: "POST", body: "{}" });
    const { ticket } = await call("/upgrade-tickets", {
      method: "POST",
      body: JSON.stringify({ target: "tty", process: opened.id }),
    });
    const url = new URL(`${origin}/api/tty`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("process", opened.id);
    url.searchParams.set("ticket", ticket);
    const attached = { text: "" };
    const decoder = new TextDecoder();
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      attached.text +=
        typeof event.data === "string"
          ? event.data
          : decoder.decode(new Uint8Array(event.data), { stream: true });
    });
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", () => reject(new Error("the tty did not open")), {
        once: true,
      });
    });
    socket.send(JSON.stringify({ t: "resize", cols: 240, rows: 50 }));
    await waitUntil("the shell's prompt", () => attached.text.length > 0, 60_000);
    await sleep(1_000);
    const encoder = new TextEncoder();
    return {
      attached,
      lines: async (typed) => {
        for (const line of typed) {
          socket.send(encoder.encode(`${line}\r`));
          await sleep(10);
        }
      },
      marker: (prefix, limit = 60_000) =>
        waitUntil(
          `${prefix} in the shell`,
          () =>
            [...attached.text.matchAll(new RegExp(`${prefix}:(\\{[^\\r\\n]*\\})`, "g"))]
              .flatMap((m) => {
                try {
                  return [JSON.parse(m[1])];
                } catch {
                  return [];
                }
              })
              .at(0) ?? null,
          limit,
        ),
      close: () => socket.close(),
    };
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

  let asAna = null;
  await step(
    "setup: Ana joins, the project is shared, her claude connected",
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
      const anaBearer = signUp.headers.get("set-auth-token");
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
          { mode: 0o600 },
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
    `setup: Ana's claude terminal agent ${anaLabel} in a fresh worktree, launched by her, so the workspace is hers`,
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
    `setup: Dana's own claude terminal agent ${danaLabel} in that worktree (POST /worktrees/:id/sessions), launched in ask mode: it joins Ana's workspace`,
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
    `Dana's view before her agent waits: ${danaLabel} is listed, not waiting`,
    async () => {
      const seen = await until(
        `${danaLabel} in Dana's view`,
        (now) => rowAnywhere(now, danaLabel) !== null,
        60_000,
      );
      const where = rowAnywhere(seen, danaLabel);
      await shot("before-wait");
      return {
        observed: `${where.group} "${where.row}" · ${summary(seen)}`,
        badge: seen.badge === "" ? 0 : Number(seen.badge),
      };
    },
  );

  const shell = await tty(mine.id, api);
  await step(
    `setup: from a shell beside ${danaLabel}, the hook stand-in replays PermissionRequest (Bash) through the hooks on her claude's command line (SessionStart first when her row records no --session-id, as claude's own first hook claims it): the session reads waiting · permission · Bash`,
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
    `Dana's view: ${danaLabel} in Needs you with Answer, the badge counts it`,
    async () => {
      let seen = null;
      try {
        seen = await until(
          `${danaLabel} in Needs you and the badge at ${baseline.badge + 1}`,
          (now) =>
            rowIn(now, "Needs you", danaLabel) !== null && now.badge === String(baseline.badge + 1),
          30_000,
        );
      } catch {
        seen = await observe();
      }
      const where = rowAnywhere(seen, danaLabel);
      const actions = await rowActions(danaLabel);
      await shot("waits");
      const observed = `${where.group} "${where.row}" · actions ${JSON.stringify(actions.map((one) => one.title))} · badge "${seen.badge}" (was ${baseline.badge}) · ${summary(seen)}`;
      expect(where.group === "Needs you", `not in Needs you: ${observed}`);
      expect(seen.badge === String(baseline.badge + 1), `the badge does not count it: ${observed}`);
      expect(
        actions.some((one) => /Answer/.test(one.title)),
        `the row offers no Answer: ${observed}`,
      );
      return observed;
    },
  );

  await checked(
    `Answer attaches ${danaLabel}'s claude in Dana's window: its tab is the active one and shows claude's output, no attach error, no window opens, no "no agent attached" line`,
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
      await waitUntil(
        `a ${want} tab`,
        async () =>
          (await terminal().tabs()).names.some((name) => name.includes(want)) ? true : null,
        30_000,
      ).catch(() => null);
      const drawn = await terminal()
        .waitForText(CLAUDE_DRAWS, 30_000)
        .catch(() => null);
      await sleep(3_000);
      const tabs = await terminal().tabs();
      const rows = (await terminal().read()).join("\n");
      keep(`${danaLabel}-answered-terminal.txt`, rows);
      const attachError = ATTACH_ERROR.exec(rows)?.[0] ?? null;
      const shown = await seen.stop();
      const opened = await newWindows(known);
      const bar = await statusBarItems();
      const refusal = [...(shown?.statusBar ?? []), ...bar].filter((text) =>
        text.includes("no agent attached"),
      );
      await shot("answered");
      const attached = tabs.names.some((name) => name.includes(want));
      const active = tabs.active?.includes(want) === true;
      const observed = `${gesture} · tabs before ${JSON.stringify(tabsBefore.names)} · after ${JSON.stringify(tabs.names)} (active ${JSON.stringify(tabs.active)}) · claude's output ${drawn === null ? "not drawn" : `drawn (${CLAUDE_DRAWS})`} · attach error ${attachError === null ? "none" : JSON.stringify(attachError)} · new windows ${opened.length} · status line ${refusal.length === 0 ? "none refusing" : JSON.stringify([...new Set(refusal)])}`;
      expect(refusal.length === 0, `refused: ${observed}`);
      expect(attached, `no ${want} tab: ${observed}`);
      expect(active, `the ${want} tab is not the active one: ${observed}`);
      expect(attachError === null, `the tab says it did not attach: ${observed}`);
      expect(drawn !== null, `claude's output never reached the tab: ${observed}`);
      expect(opened.length === 0, `a window opened: ${observed}`);
      return observed;
    },
  );

  keep(`${danaLabel}-shell.txt`, shell.attached.text);
  shell.close();
  note(`evidence: steps.jsonl, ${danaLabel}-shell.txt in ${out}`);
  expect(failures.length === 0, `Answer on her terminal agent: ${failures.join(" | ")}`);
};
