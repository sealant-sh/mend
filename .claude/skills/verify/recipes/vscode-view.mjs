// Flow 2 of the VS Code redesign, driven as Dana meets it: the Mend view, its badge, the status
// bar and the toasts (stories f, a4 and b; rules 9, 10 and 12-16). The morning after (f1-f3), a
// session she starts that runs (a2, a3), a terminal agent that waits and the Answer that attaches
// it here (b1), two windows of which only the focused one toasts, a session's workspace window,
// the turn that ends (a4), and Mend unreachable for a moment.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-view.mjs --out <dir>
//
// Needs a world from `up` that is signed in with workspace SSH set up, on a server with G4 (#1082):
// a terminal agent's wait is replayed by claude's hook stand-in (`fixtures/claude-standin.mjs`,
// from #1082) typed into a shell beside the agent, as recipes/g4-terminal-agent-waits.mjs does.
// Until this branch has #1082 the stand-in is read from origin/main, where #1082 landed. Each report
// carries the agent's own `--session-id`, as #1082's recipe sends it. Claude runs on the skill's fake setup
// token (`scripts/fakes.mjs`): as a terminal agent it sits at its prompt. The session that
// finishes is told `/exit`, which claude answers with exit 0; the one that fails gets SIGTERM, which
// claude answers with exit 143 (SIGKILL records no exit code, and reads completed).
//
// The editor was started by `up` before the overnight sessions exist, so f1 reloads its window:
// the extension starts again on sessions that settled while it was not looking.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FAKES } from "../scripts/fakes.mjs";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

const STANDIN_PATH = ".claude/skills/verify/scripts/fixtures/claude-standin.mjs";
const G4_BRANCH = "origin/main";

/** The stand-in's source: this checkout's once it has #1082, origin/main's until then. */
const standinSource = () => {
  const local = join(import.meta.dirname, "../scripts/fixtures/claude-standin.mjs");
  if (existsSync(local)) return readFileSync(local, "utf8");
  return execFileSync("git", ["show", `${G4_BRANCH}:${STANDIN_PATH}`], {
    cwd: join(import.meta.dirname, "../../../.."),
    encoding: "utf8",
  });
};

/** Typed into the shell beside the agent: the live claude's `--settings` and `--session-id`. */
const SETTINGS_SCAN = `import { readdirSync, readFileSync } from "node:fs";
let settings = null;
let sessionId = null;
for (const pid of readdirSync("/proc").filter((name) => /^\\d+$/.test(name))) {
  let argv;
  try {
    argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
  } catch {
    continue;
  }
  if (!argv.some((word) => /(^|\\/)claude$/.test(word))) continue;
  const at = argv.findIndex((word) => word === "--settings" || word.startsWith("--settings="));
  if (at === -1) continue;
  settings = argv[at] === "--settings" ? argv[at + 1] : argv[at].slice("--settings=".length);
  const id = argv.indexOf("--session-id");
  sessionId = id === -1 ? null : (argv[id + 1] ?? null);
  break;
}
console.log("MEND-VIEW-SETTINGS:" + JSON.stringify({ settings, sessionId }));
`;

const heredoc = (target, text) => [
  `base64 -d > "$D/${target}" <<'MEND_VIEW_EOF'`,
  ...(Buffer.from(text)
    .toString("base64")
    .match(/.{1,76}/g) ?? []),
  "MEND_VIEW_EOF",
];

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

const clock = (iso) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

const GROUPS = ["Needs you", "Since you last looked", "Running", "Projects"];

/** The view as a person reads it: its message, then each group's rows as `name · line`. */
const grouped = ({ message, rows }) => {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.level === 1) {
      current = { group: row.label, count: row.description, expanded: row.expanded, rows: [] };
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
    watch,
    palette,
    terminal,
    windows,
    waitForWindow,
    useWindow,
    homeWindow,
    closeWindow,
    waitUntil,
    shot,
    opens,
    page,
  } = h;
  const project = state.project ?? fail("the run's ledger has no project: did up finish?");
  const origin = state.server?.origin ?? fail("the run's ledger has no server origin");

  /** A new window may open on VS Code's own sign-in welcome, over the workbench. */
  const dismissWelcome = async () => {
    const skip = page().getByText("Continue without Signing In");
    if (await skip.isVisible().catch(() => false)) await skip.click();
  };
  /** `Developer: Reload Window`, then the Mend view, as VS Code starting again shows it. */
  const reload = async () => {
    await palette("Developer: Reload Window");
    await page().locator(".monaco-workbench").first().waitFor({ timeout: 120_000 });
    await sleep(3_000);
    await waitUntil(
      "the Mend view after the reload",
      async () => {
        await dismissWelcome();
        await view("Mend");
        return true;
      },
      90_000,
    );
  };
  const read = async () => grouped(await viewRows());
  const mendStatus = async () =>
    (await statusBarItems()).filter((text) => text.startsWith("Mend") || text.includes(" · "));
  const observe = async () => ({
    ...(await read()),
    badge: await badge("Mend"),
    statusBar: await mendStatus(),
  });
  const groupOf = (seen, name) => seen.groups.find((group) => group.group === name) ?? null;
  const rowIn = (seen, name, session) =>
    groupOf(seen, name)?.rows.find((row) => row.startsWith(`${session} · `)) ?? null;
  const until = (what, check, limit = 60_000) =>
    waitUntil(
      what,
      async () => {
        const seen = await observe();
        return check(seen) ? seen : null;
      },
      limit,
    );
  const summary = (seen) =>
    `badge "${seen.badge}" · status bar ${JSON.stringify(seen.statusBar)} · message "${seen.message}" · groups ${JSON.stringify(seen.groups.map(({ group, count, expanded, rows }) => ({ group, count, expanded, rows })))}`;

  // ── the world's sessions, set up through the API ──
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

  const sessionRead = (id) => api(`/sessions/${id}`);
  const startClaude = async (label) => {
    const created = await api(`/projects/${project.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude", label, base: null, name: null }),
    });
    await api(`/sessions/${created.id}/launch`, {
      method: "POST",
      body: JSON.stringify({ permissionMode: "ask" }),
    });
    const agent = await waitUntil(
      `${label} running with a live agent-pty`,
      async () => {
        const now = await sessionRead(created.id);
        return now.session.status === "running"
          ? (now.processes.find((row) => row.kind === "agent-pty" && row.exitedAt === null) ?? null)
          : null;
      },
      600_000,
    );
    return { id: created.id, name: label, agent: agent.id };
  };

  /** One of a session's terminals over `/api/tty`, read and typed into as raw bytes. */
  const tty = async (processId) => {
    const { ticket } = await api("/upgrade-tickets", {
      method: "POST",
      body: JSON.stringify({ target: "tty", process: processId }),
    });
    const url = new URL(`${origin}/api/tty`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("process", processId);
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    const attached = { socket, text: "", closed: null };
    socket.addEventListener("message", (event) => {
      attached.text +=
        typeof event.data === "string"
          ? event.data
          : decoder.decode(new Uint8Array(event.data), { stream: true });
    });
    socket.addEventListener("close", (event) => (attached.closed = event.code));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("the tty did not open")), {
        once: true,
      });
    });
    socket.send(JSON.stringify({ t: "resize", cols: 220, rows: 50 }));
    const encoder = new TextEncoder();
    return {
      attached,
      send: (text) => socket.send(encoder.encode(text)),
      lines: async (lines) => {
        for (const line of lines) {
          socket.send(encoder.encode(`${line}\r`));
          await sleep(10);
        }
      },
      marker: (prefix, limit = 60_000) =>
        waitUntil(
          `${prefix} in the shell`,
          () => {
            const found = new RegExp(`${prefix}:(\\{[^\\r\\n]*\\})`).exec(attached.text);
            return found === null ? null : JSON.parse(found[1]);
          },
          limit,
        ),
      close: () => socket.close(),
    };
  };

  /** A shell beside the session's agent, with the stand-in and the agent's own hooks in `$D`. */
  const hooksBeside = async (session) => {
    const opened = await api(`/sessions/${session.id}/shell`, { method: "POST", body: "{}" });
    const shell = await tty(opened.id);
    await waitUntil("the shell's prompt", () => shell.attached.text.trim() !== "", 60_000);
    await sleep(1_000);
    await shell.lines([
      "D=$(mktemp -d /tmp/mend-view.XXXXXX)",
      ...heredoc("scan.mjs", SETTINGS_SCAN),
      ...heredoc("standin.mjs", standinSource()),
      'node "$D/scan.mjs"',
    ]);
    const { settings, sessionId } = await shell.marker("MEND-VIEW-SETTINGS");
    expect(settings !== null, "no claude in the workspace runs with --settings");
    await shell.lines(heredoc("settings.json", settings));
    let fired = 0;
    return {
      shell,
      /** The agent's own id, which #1082's server needs on every report; null before it. */
      sessionId,
      /** The agent's hooks fire as claude fires them: one event, once its line says they ran. */
      fire: async (event) => {
        fired += 1;
        const marker = `MEND-VIEW-${fired}`;
        await shell.lines([
          `node "$D/standin.mjs" --settings "$(cat "$D/settings.json")"${sessionId === null ? "" : ` --session-id ${sessionId}`} --events ${event} --pause-ms 0 --marker ${marker} && echo ${marker}-DONE:{}`,
        ]);
        await shell.marker(`${marker}-DONE`);
        return event;
      },
    };
  };

  const [migrate, docs, flaky] = await step(
    "overnight: three claude terminal agents (migrate-orders, docs-typos, flaky-auth-test) started in fresh worktrees",
    async () => {
      const started = await Promise.all(
        ["migrate-orders", "docs-typos", "flaky-auth-test"].map((label) => startClaude(label)),
      );
      return {
        observed: started.map((one) => `${one.name} ${one.id.slice(0, 8)} running`).join(" · "),
        sessions: started,
      };
    },
    { via: "api" },
  ).then((result) => result.sessions);

  const migrateHooks = await step(
    "migrate-orders waits for Dana: claude's PermissionRequest hook fired beside it (the G4 stand-in)",
    async () => {
      const hooks = await hooksBeside(migrate);
      await hooks.fire("PermissionRequest");
      const now = await waitUntil(
        "migrate-orders to read waiting",
        async () => {
          const one = await sessionRead(migrate.id);
          return one.session.status === "waiting" ? one : null;
        },
        30_000,
      );
      const agent = now.processes.find((row) => row.id === migrate.agent);
      return {
        observed: `migrate-orders ${now.session.status} · agent waiting ${JSON.stringify(agent?.waiting ?? null)}`,
        hooks,
        since: agent?.waiting?.since ?? null,
      };
    },
    { via: "tty" },
  );

  await step(
    "docs-typos finished (claude told /exit) and flaky-auth-test failed (claude sent SIGTERM)",
    async () => {
      const agent = await tty(docs.agent);
      await sleep(2_000);
      agent.send("/exit\r");
      const flakyShell = await hooksBeside(flaky);
      // The shell holds the workspace (the session would read idle): it leaves with the agent.
      await flakyShell.shell.lines(["kill -TERM $(pgrep -x claude); exit"]);
      const settled = await waitUntil(
        "both to settle",
        async () => {
          const [one, two] = await Promise.all([sessionRead(docs.id), sessionRead(flaky.id)]);
          return ["completed", "failed", "stopped"].includes(one.session.status) &&
            ["completed", "failed", "stopped"].includes(two.session.status)
            ? [one.session, two.session]
            : null;
        },
        60_000,
      );
      agent.close();
      flakyShell.shell.close();
      return settled
        .map((one) => `${one.label} ${one.status} · summary ${JSON.stringify(one.summary)}`)
        .join(" · ");
    },
    { via: "tty" },
  );

  // ── f1, f2: she opens VS Code ──
  const morning = await step(
    "f1: VS Code starts on what happened overnight (the window reloaded): badge 1, the status bar names who needs her and what finished",
    async () => {
      await reload();
      const seen = await until(
        "the view to read the overnight sessions",
        (now) => now.badge === "1" && groupOf(now, "Since you last looked") !== null,
      );
      await shot("f1-morning");
      expect(
        seen.statusBar.includes("Mend · 1 needs you · 2 finished"),
        `the status bar reads ${JSON.stringify(seen.statusBar)}`,
      );
      return { observed: summary(seen), seen };
    },
  );

  await step(
    "f2: the groups in order, Needs you, Since you last looked, then Projects collapsed, in the server's words",
    async () => {
      const seen = morning.seen;
      const order = seen.groups.map((group) => group.group);
      expect(
        JSON.stringify(order) ===
          JSON.stringify(["Needs you", "Since you last looked", "Projects"]),
        `groups ${JSON.stringify(order)}`,
      );
      const waiting = rowIn(seen, "Needs you", "migrate-orders");
      expect(
        waiting ===
          `migrate-orders · waiting · claude needs your permission to use Bash · since ${clock(migrateHooks.since)}`,
        `Needs you reads ${JSON.stringify(waiting)}`,
      );
      const finished = rowIn(seen, "Since you last looked", "docs-typos");
      expect(
        finished?.startsWith("docs-typos · completed · observed") === true,
        `docs-typos reads ${JSON.stringify(finished)}`,
      );
      const failed = rowIn(seen, "Since you last looked", "flaky-auth-test");
      expect(
        failed?.startsWith("flaky-auth-test · failed") === true,
        `flaky-auth-test reads ${JSON.stringify(failed)}`,
      );
      expect(groupOf(seen, "Projects")?.expanded === "false", "Projects is not collapsed");
      return `Needs you "${waiting}" · Since you last looked "${finished}", "${failed}" · Projects collapsed`;
    },
  );

  // ── f3: she works through it ──
  await step(
    "f3: selecting flaky-auth-test and docs-typos takes each out of Since you last looked",
    async () => {
      await treeItem("flaky-auth-test").click();
      const one = await until(
        "flaky-auth-test to leave Since you last looked",
        (now) => rowIn(now, "Since you last looked", "flaky-auth-test") === null,
        15_000,
      );
      await shot("f3-flaky-seen");
      await treeItem("docs-typos").click();
      const both = await until(
        "Since you last looked to empty",
        (now) => groupOf(now, "Since you last looked") === null,
        15_000,
      );
      await shot("f3-both-seen");
      return `after flaky-auth-test: ${summary(one)} · after docs-typos: ${summary(both)}`;
    },
  );

  await step(
    "f3: the window reloaded, they stay out of Since you last looked (stored per server)",
    async () => {
      await reload();
      const seen = await until(
        "the view after the reload",
        (now) => groupOf(now, "Needs you") !== null,
      );
      expect(groupOf(seen, "Since you last looked") === null, `after reload: ${summary(seen)}`);
      await shot("f3-after-reload");
      return summary(seen);
    },
  );

  await step(
    "answered elsewhere: claude's PostToolUse clears migrate-orders' wait, the row and badge follow and nothing toasts",
    async () => {
      const watching = await watch();
      await migrateHooks.hooks.fire("PostToolUse");
      const seen = await until(
        "migrate-orders to leave Needs you",
        (now) => groupOf(now, "Needs you") === null && now.badge === "",
        30_000,
      );
      await sleep(2_000);
      const caught = await watching.stop();
      expect(caught === null || caught.toasts.length === 0, `toasted ${shown(caught)}`);
      // The shell beside it holds the workspace too: it leaves first, so the stop settles it.
      await migrateHooks.hooks.shell.lines(["exit"]);
      await sleep(1_000);
      await api(`/sessions/${migrate.id}/stop`, { method: "POST", body: "{}" });
      migrateHooks.hooks.shell.close();
      await until("migrate-orders to leave Running", (now) => groupOf(now, "Running") === null);
      return `${summary(seen)} · ${shown(caught)} · then migrate-orders stopped (setup)`;
    },
  );

  // ── a2, a3 ──
  let rate;
  await step(
    "a2/a3: add-rate-limit started as a terminal agent: its row reads starting then running, no toast, the status bar Mend · 1 running",
    async () => {
      const watching = await watch();
      const started = startClaude("add-rate-limit");
      const starting = await until(
        "add-rate-limit starting",
        (now) => rowIn(now, "Running", "add-rate-limit")?.includes("· starting") === true,
        120_000,
      );
      await shot("a2-starting");
      rate = await started;
      const running = await until(
        "add-rate-limit running",
        (now) => rowIn(now, "Running", "add-rate-limit")?.includes("· running") === true,
        120_000,
      );
      await shot("a3-running");
      const caught = await watching.stop();
      expect(caught === null || caught.toasts.length === 0, `toasted ${shown(caught)}`);
      expect(
        running.statusBar.includes("Mend · 1 running"),
        `status bar ${JSON.stringify(running.statusBar)}`,
      );
      return `starting "${rowIn(starting, "Running", "add-rate-limit")}" · running "${rowIn(running, "Running", "add-rate-limit")}" · status bar ${JSON.stringify(running.statusBar)} · ${shown(caught)}`;
    },
  );

  // ── b1 ──
  const rateHooks = await step(
    "b1 setup: a shell beside add-rate-limit with claude's hooks",
    async () => ({
      observed: "the stand-in and the agent's --settings in $D",
      ...(await hooksBeside(rate)),
    }),
    { via: "tty" },
  );

  await step(
    "b1: claude asks for Bash: the row moves to Needs you, badge 1, one toast with Answer in the focused window",
    async () => {
      await rateHooks.fire("PermissionRequest");
      const seen = await until(
        "add-rate-limit in Needs you",
        (now) =>
          rowIn(now, "Needs you", "add-rate-limit")?.includes(
            "waiting · claude needs your permission to use Bash",
          ) === true && now.badge === "1",
        30_000,
      );
      const toast = notification("add-rate-limit is waiting");
      await toast.waitFor(15_000);
      const words = await toast.text();
      expect(
        words.includes("add-rate-limit is waiting · claude needs your permission to use Bash"),
        `the toast reads ${words}`,
      );
      await shot("b1-told");
      return `${summary(seen)} · toast "${words}"`;
    },
  );

  await step(
    "b1: Answer attaches claude · add-rate-limit in this window's panel and opens no window",
    async () => {
      const known = await windows();
      const before = await opens();
      await notification("add-rate-limit is waiting").click("Answer");
      const tabs = await waitUntil(
        "the agent's tab in this window",
        async () => {
          const now = await terminal().tabs();
          return now?.names?.includes("claude · add-rate-limit") ? now : null;
        },
        30_000,
      );
      await sleep(5_000);
      const after = await opens();
      const nowWindows = await windows();
      await shot("b1-answer");
      expect(after === before, `opens ${before} → ${after}`);
      expect(nowWindows.length === known.length, `windows ${known.length} → ${nowWindows.length}`);
      return `tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · opens ${before} → ${after} · windows ${known.length} → ${nowWindows.length}`;
    },
  );

  await step(
    "b1: claude's PostToolUse: the row reads running again and the badge clears",
    async () => {
      await rateHooks.fire("PostToolUse");
      const seen = await until(
        "add-rate-limit running, badge cleared",
        (now) =>
          rowIn(now, "Running", "add-rate-limit")?.includes("· running") === true &&
          now.badge === "",
        30_000,
      );
      await shot("b1-continues");
      return summary(seen);
    },
  );

  // ── another VS Code window ──
  await step(
    "another VS Code window: only the focused window toasts, the other shows the badge",
    async () => {
      const home = await homeWindow();
      const known = await windows();
      await palette("New Window");
      const second = await waitForWindow(known);
      await useWindow(second);
      await sleep(5_000);
      await dismissWelcome();
      await view("Mend");
      // Which windows VS Code itself holds focused: its custom title bar reads `inactive` on the
      // others, from the same focus events `vscode.window.state.focused` reports to the extension.
      const focus = async () =>
        Promise.all(
          (await windows()).map(async (one) => ({
            title: one.title,
            focused: await one.page
              .evaluate(() => {
                const bar = document.querySelector(".part.titlebar");
                return bar === null ? null : !bar.classList.contains("inactive");
              })
              .catch(() => null),
          })),
        );
      await useWindow(home);
      const homeWatch = await watch();
      await useWindow(second);
      const secondWatch = await watch();
      const focusAtEvent = await focus();
      await rateHooks.fire("PermissionRequest");
      await sleep(8_000);
      const secondSeen = await secondWatch.stop();
      const secondBadge = await badge("Mend");
      await shot("two-windows-second");
      await useWindow(home);
      const homeSeen = await homeWatch.stop();
      const homeBadge = await badge("Mend");
      await shot("two-windows-home");
      const toasts = (seen) =>
        seen === null ? 0 : seen.toasts.filter((text) => text.includes("add-rate-limit")).length;
      const toasted = [homeSeen, secondSeen].filter((seen) => toasts(seen) > 0).length;
      const focused = focusAtEvent.filter((one) => one.focused === true).length;
      await rateHooks.fire("PostToolUse");
      await useWindow(second);
      await closeWindow(second);
      await useWindow(await homeWindow());
      const said = `VS Code's focus ${JSON.stringify(focusAtEvent)} · home ${shown(homeSeen)} badge "${homeBadge}" · second ${shown(secondSeen)} badge "${secondBadge}" · windows that toasted: ${toasted}`;
      expect(homeBadge === "1" && secondBadge === "1", `badges: ${said}`);
      expect(toasts(homeSeen) <= 1 && toasts(secondSeen) <= 1, `a window toasted twice: ${said}`);
      if (focused === 1) {
        expect(toasted === 1, `one window focused, ${toasted} toasted: ${said}`);
        return said;
      }
      note(
        `not drivable headless: VS Code held ${focused} windows focused at once (Xvfb runs no window manager, so no window loses focus), and each focused window toasts by the rule`,
      );
      return `not drivable · ${said}`;
    },
  );

  // ── the workspace window ──
  await step(
    "a session's workspace window: the view shows that session and one line for the others, the status bar its dot and word",
    async () => {
      await api(`/sessions/${migrate.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ harness: "shell" }),
      });
      await view("Mend");
      await until(
        "migrate-orders live again",
        (now) => rowIn(now, "Running", "migrate-orders") !== null,
        120_000,
      );
      const known = await windows();
      await treeItem("add-rate-limit").contextMenu("Mend: Open in New Window");
      const workspace = await waitForWindow(known, 180_000);
      await useWindow(workspace);
      await waitUntil(
        "the workspace window to connect",
        async () => ((await workspace.title()).includes("[SSH:") ? true : null),
        180_000,
      );
      await sleep(8_000);
      await view("Mend");
      const flat = async () =>
        (await viewRows()).rows.map((row) =>
          row.description === "" ? row.label : `${row.label} · ${row.description}`,
        );
      const rows = await waitUntil(
        "the workspace view: its session's line and the others line",
        async () => {
          const now = await flat();
          return now.some((row) => /^running/.test(row)) &&
            now.some((row) => /other sessions?/.test(row))
            ? now
            : null;
        },
        60_000,
      );
      const seen = await observe();
      await shot("c3-workspace-view");
      expect(
        rows.some((row) => /^running/.test(row)) && rows.some((row) => /other sessions?/.test(row)),
        `rows ${JSON.stringify(rows)}`,
      );
      expect(
        !rows.some((row) => row.includes("Projects")),
        `the workspace view lists projects: ${JSON.stringify(rows)}`,
      );
      return {
        observed: `rows ${JSON.stringify(rows)} · status bar ${JSON.stringify(seen.statusBar)} · badge "${seen.badge}"`,
        workspace,
      };
    },
  );

  await step("the workspace window's status bar opens the session picker", async () => {
    const item = page()
      .locator(".part.statusbar .statusbar-item", { hasText: "add-rate-limit · " })
      .first();
    await item.click();
    const picker = await waitUntil(
      "the session picker",
      async () => {
        const title = await page()
          .locator(".quick-input-widget .quick-input-title")
          .first()
          .innerText()
          .catch(() => "");
        return title.includes("Mend sessions") ? title : null;
      },
      15_000,
    );
    const items = await page()
      .locator(".quick-input-widget .quick-input-list .monaco-list-row")
      .evaluateAll((found) =>
        found.map((row) =>
          (row instanceof HTMLElement ? row.innerText : "").replace(/\s+/g, " ").trim(),
        ),
      );
    await shot("c3-picker");
    await page().keyboard.press("Escape");
    return `picker "${picker}" · items ${JSON.stringify(items)}`;
  });

  await step("back to the local window; the workspace window closed", async () => {
    const home = await homeWindow();
    const extra = (await windows()).filter((one) => one.page !== home);
    const results = [];
    for (const one of extra) results.push(await closeWindow(one));
    await useWindow(home);
    await view("Mend");
    return `${extra.length} closed · ${results.join(" · ")}`;
  });

  // ── a4 ──
  await step(
    "a4: claude's turn ends (Stop): add-rate-limit waits with G4's words for a finished turn, and the focused window toasts it",
    async () => {
      await rateHooks.fire("Stop");
      const seen = await until(
        "add-rate-limit waiting · claude finished its turn",
        (now) =>
          rowIn(now, "Needs you", "add-rate-limit")?.includes("claude finished its turn") === true,
        30_000,
      );
      const toast = notification("add-rate-limit is waiting · claude finished its turn");
      await toast.waitFor(15_000);
      await shot("a4-turn-ended");
      return `${summary(seen)} · toast "${await toast.text()}"`;
    },
  );

  await step(
    "a4: claude exits: the row reads completed, and the focused window toasts add-rate-limit finished with Review and Open",
    async () => {
      // The hooks' shell holds the workspace too: it leaves first, so the agent's exit settles it.
      await rateHooks.shell.lines(["exit"]);
      const agent = await tty(rate.agent);
      await sleep(1_500);
      agent.send("/exit\r");
      const seen = await until(
        "add-rate-limit in Since you last looked",
        (now) =>
          rowIn(now, "Since you last looked", "add-rate-limit")?.includes("completed") === true,
        60_000,
      );
      const toast = notification("add-rate-limit finished");
      await toast.waitFor(15_000);
      const words = await toast.text();
      expect(/Review/.test(words) && /Open/.test(words), `the toast reads ${words}`);
      await shot("a4-finished");
      agent.close();
      return `${summary(seen)} · toast "${words}"`;
    },
  );

  // ── offline ──
  await step(
    "offline: the server stopped: the view says when Mend was last heard, rows keep their words with last seen, New session is disabled",
    async () => {
      rateHooks.shell.close();
      await world.run(
        "docker",
        ["--context", state.context, "stop", "-t", "5", state.server.container],
        {
          timeout: 120_000,
          // The world's Docker context is registered under its own HOME.
          env: { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome },
        },
      );
      const seen = await until(
        "the view to say Mend is unreachable",
        (now) => now.message.startsWith("last heard from Mend at"),
        90_000,
      );
      const newSession = await page()
        .locator('.part.sidebar .title-actions .action-label[aria-label^="Mend: New Session"]')
        .first()
        .evaluate((element) => ({
          disabled:
            element.classList.contains("disabled") ||
            element.getAttribute("aria-disabled") === "true",
        }))
        .catch(() => null);
      await shot("offline");
      expect(
        seen.groups.some((group) => group.rows.some((row) => row.includes("· last seen "))),
        `no row says last seen: ${summary(seen)}`,
      );
      expect(newSession?.disabled === true, `New session ${JSON.stringify(newSession)}`);
      return `${summary(seen)} · New session ${JSON.stringify(newSession)}`;
    },
    { via: "setup" },
  );

  await step(
    "offline: the server back: the view recovers, no last heard, no last seen",
    async () => {
      await world.run("docker", ["--context", state.context, "start", state.server.container], {
        timeout: 120_000,
        // The world's Docker context is registered under its own HOME.
        env: { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome },
      });
      const seen = await until(
        "the view to recover",
        (now) =>
          now.message === "" &&
          !now.groups.some((group) => group.rows.some((row) => row.includes("· last seen "))),
        240_000,
      );
      await shot("online-again");
      return summary(seen);
    },
    { via: "setup" },
  );

  note(
    `sessions: ${[migrate, docs, flaky, rate].map((one) => `${one.name} ${one.id}`).join(", ")}`,
  );
};

const fail = (reason) => {
  throw new Error(reason);
};
