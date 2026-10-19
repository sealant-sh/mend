// Stories c and e, driven the same way against any build of the extension: today's (main's
// `apps/vscode`, whose row button is `Mend: Open in VS Code`) and the redesign (`Mend: Open`). The
// lanes open a shell session started from the palette: with flow 3 from `Mend: New session`
// (`workbench` typed as its name, Change… → harness shell), which opens no window; on main's from
// `Mend: New Session…` (Workbench), whose window is the counter's first +1. The counter is then
// calibrated: the row's open button twice with a gap must read `opens` +1, then +2.
// Then every step asserts the story: a double-click and a click open nothing and ask nothing (today's
// extension fails here, at the double-click), two fast Opens make one window, Open in New Window
// makes one, the workspace window attaches the session's live terminal, a stopped session opens
// through its resume, a conversation's tab offers Continue here and becomes claude's TUI, Ana's
// session is never opened from the row, the palette or a deep link (each offers what Dana may do
// instead, the status bar's pick too), two live sessions in one worktree each open to their own
// agent (and Open in New Window from inside that workspace shows its agent there), a session caught
// stopping is resumed once it has stopped, a stopped session's Open from its own workspace window
// resumes it before showing its agent there, and Open with VS Code's default setting turns the window
// itself into the workspace of a claude terminal agent, attached and focused, that she types into,
// though a newer session shares its worktree.
//
// A double-click is judged by the server's reads: an open's first act is `GET /api/sessions/<id>`
// (today's extension makes one per click, two per double-click), and selecting a row reads nothing.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-open.mjs --out <dir>
//
// Needs a world from `up` that is signed in with workspace SSH set up (the default). The last lane
// turns the first window into a workspace, so it runs last and nothing can follow it.
//
// Claude is connected with the skill's published fake setup token (`scripts/fakes.mjs`). The real
// claude starts on it: as a terminal agent it sits at its `❯` prompt, and as a conversation its
// first turn completes with the provider's 401 as its answer, which leaves the saved turn a mode
// handoff needs. Nothing reaches the provider beyond that refusal.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FAKES } from "../scripts/fakes.mjs";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

/** The row's open button on either manifest. */
const OPEN = /^Mend: Open( in VS Code)?$/;
/**
 * A workspace window's own row, on either build: its label is the session's name with its line
 * beside it, or (before #1088's round 2) the line itself.
 */
const ownRow = (name) =>
  new RegExp(
    `^(?:${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*)?(?:starting|running|waiting|idle|stopping|stopped|completed|failed|landed)`,
  );
/** What Remote-SSH would refuse, said where Open would have been. */
const ANA_WHY = "Ana launched this workspace · Remote-SSH opens it only for them";

/** `key before → after` for every counted fact. */
const delta = (before, after) =>
  Object.keys(before)
    .map((key) => `${key} ${before[key]} → ${after[key]}`)
    .join(", ");

const linesMatching = (log, needle) =>
  log.split("\n").filter((line) => line.includes(needle)).length;

/** A stop settles a claude terminal agent as `stopped` or, when claude exits non-zero on it, `failed`. */
const SETTLED = new Set(["stopped", "failed", "completed"]);

const liveProcess = (processes, kind) =>
  processes.find((process) => process.kind === kind && process.exitedAt === null);

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

/** What an open asked before its window came, and the answer given. */
const answered = (open) =>
  open.asked === null ? "nothing asked" : `asked "${open.asked}", Open alongside picked`;

/** A watch's catch, as one line: what showed beyond what was there already. */
const shown = (seen) =>
  seen === null
    ? "the window navigated, its watch went with it"
    : `toasts ${JSON.stringify(seen.toasts)} · dialogs ${JSON.stringify(seen.dialogs)} · quick inputs ${JSON.stringify(seen.quickInputs)} · status bar ${JSON.stringify(seen.statusBar)}`;

export default async (h) => {
  const {
    view,
    palette,
    paletteRows,
    quickInput,
    treeItem,
    notification,
    notifications,
    dialog,
    dialogs,
    openUrl,
    windows,
    newWindows,
    useWindow,
    homeWindow,
    closeWindow,
    statusBar,
    terminal,
    watch,
    userSettings,
    waitForText,
    waitUntil,
    shot,
    step,
    api,
    state,
    serverLogs,
    opens,
    page,
    sleep,
    viewRows,
    statusBarItems,
  } = h;
  const project = state.project;
  const stoppedName = "fresh worktree";

  /**
   * The Mend view with its Projects group and the project open: every session, the stopped one
   * included, has a row there (Needs you, Since you last looked and Running list only some).
   */
  const mendView = async () => {
    await view("Mend");
    // The view draws its groups once its first read lands; a workspace window has none.
    await waitUntil(
      "the Mend view's first rows",
      async () =>
        (await viewRows()).rows.some(
          (one) => one.label === "Projects" || /other sessions?$/.test(one.label),
        )
          ? true
          : null,
      120_000,
    );
    for (const label of ["Projects", project.name]) {
      const row = (await viewRows()).rows.find((one) => one.label === label);
      if (row?.expanded === "false") {
        await treeItem(label).click();
        await waitUntil(
          `${label} open`,
          async () =>
            (await viewRows()).rows.find((one) => one.label === label)?.expanded === "true"
              ? true
              : null,
          15_000,
        );
      }
    }
  };

  await step("the Mend view lists the project", async () => {
    await useWindow(await homeWindow());
    if (await quickInput.isOpen()) await quickInput.cancel();
    await mendView();
    await treeItem(project.name).waitFor();
    await shot("mend-view");
    return `row "${await treeItem(project.name).text()}" · status bar "${(await statusBarItems()).filter((text) => text.includes("Mend")).join(" | ")}" · opens ${await opens()} · windows ${(await windows()).length}`;
  });

  const listedBefore = await api(`/projects/${project.id}`);
  const beforeIds = new Set(listedBefore.sessions.map((session) => session.id));
  const windowsBeforeStart = await windows();
  const opensBeforeStart = await opens();

  // Main's extension starts a Workbench from `Mend: New Session…` and opens its window; flow 3's
  // `Mend: New session` starts a shell from Change… and opens nothing.
  const asBuiltStart = (await paletteRows("Mend: New Session")).some(
    (row) => row.label === "Mend: New Session…",
  );

  await step(
    asBuiltStart
      ? "Mend: New Session… from the palette, Workbench picked"
      : "Mend: New session from the palette: the name workbench typed, Change… → harness shell, the rest kept, Enter",
    async () => {
      if (asBuiltStart) {
        await palette("Mend: New Session…");
        await quickInput.waitFor();
        if ((await quickInput.title()) === "Choose a Mend project")
          await quickInput.pick(project.name);
        const title = await quickInput.title();
        const kinds = (await quickInput.items()).map((item) => item.split("\n")[0].trim());
        await shot("new-session-kinds");
        await quickInput.pick("Workbench");
        return `quick input "${title}" offered ${kinds.join(" | ")}`;
      }
      await palette("Mend: New session");
      await quickInput.waitFor();
      await quickInput.type("workbench");
      const keyOf = async () =>
        `${(await quickInput.step())?.step ?? null}|${await quickInput.placeholder()}`;
      let last = await keyOf();
      await quickInput.button("Change…");
      const trail = [];
      for (let guard = 0; guard < 8; guard += 1) {
        const seen = await waitUntil(
          "a step of Change…, or the prompt again",
          async () => {
            const key = await keyOf();
            const rows = await quickInput.rows();
            return key !== last && rows.length > 0
              ? {
                  key,
                  step: (await quickInput.step())?.step ?? null,
                  rows,
                  placeholder: await quickInput.placeholder(),
                }
              : null;
          },
          30_000,
        );
        last = seen.key;
        if (seen.step === null) {
          await shot("new-session-shell");
          const line = seen.rows[0]?.description ?? "";
          expect(line.startsWith("shell · "), `the dim line reads "${line}"`);
          await quickInput.accept();
          return `${trail.join(" · ")} · prompt step "${seen.placeholder}", value "${await quickInput.value().catch(() => "")}", dim line "${line}"`;
        }
        const pick =
          seen.placeholder === "Harness"
            ? "shell"
            : (seen.rows.find((row) => row.icons.includes("check"))?.label ?? seen.rows[0].label);
        await quickInput.pick(pick, { exact: true });
        trail.push(`${seen.step} ${seen.placeholder} → ${pick}`);
      }
      throw new Error(`Change… did not return to the prompt: ${JSON.stringify(trail)}`);
    },
  );

  const session = await step("the new session's row reads running", async () => {
    const created = await waitUntil(
      "the new session on the server",
      async () =>
        (await api(`/projects/${project.id}`)).sessions.find((item) => !beforeIds.has(item.id)) ??
        null,
      120_000,
    );
    const short = created.id.slice(0, 8);
    const name = created.label ?? `claude · ${short}`;
    const row = treeItem(name);
    await waitUntil(
      "the row to read running",
      async () => ((await row.description()).startsWith("running") ? true : null),
      300_000,
    );
    await shot("row-running");
    const detail = await waitUntil(
      "the session to report its workspace",
      async () => {
        const { session: read } = await api(`/sessions/${created.id}`);
        return read.sealantWorkspaceId ? read : null;
      },
      120_000,
    );
    return {
      observed: `row "${await row.text()}" · session ${created.id.slice(0, 8)} · workspace ${detail.sealantWorkspaceId}`,
      id: created.id,
      name,
      tab: `shell · ${created.label ?? short}`,
      workspaceId: detail.sealantWorkspaceId,
    };
  });
  const banner = `Mend · ${session.name} · closing this tab detaches`;

  await step(
    asBuiltStart
      ? "the start opens one window on main's extension: opens +1, its terminal recorded"
      : "the start opened no window: opens and windows unchanged (calibrated by the open button next)",
    async () => {
      if (!asBuiltStart) {
        const opened = await newWindows(windowsBeforeStart, { settle: 10_000, limit: 30_000 });
        const after = await opens();
        await shot("start-no-window");
        const observed = `windows opened ${opened.length} · opens ${opensBeforeStart} → ${after}`;
        expect(opened.length === 0 && after === opensBeforeStart, observed);
        return observed;
      }
      const opened = await newWindows(windowsBeforeStart, { settle: 10_000, limit: 120_000 });
      expect(opened.length === 1, `the start opened ${opened.length} windows`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      const after = await opens();
      expect(after - opensBeforeStart === 1, `opens ${opensBeforeStart} → ${after} for 1 window`);
      const tabs = await waitUntil(
        "a terminal tab, if one comes",
        async () => {
          const read = await terminal().tabs();
          return read.names.length > 0 ? read : null;
        },
        15_000,
      ).catch(() => null);
      const rows = await terminal().read();
      await shot("start-window");
      const result = await closeWindow(opened[0]);
      await useWindow(await homeWindow());
      await mendView();
      return `1 window · opens ${opensBeforeStart} → ${after} · tabs ${JSON.stringify(tabs?.names ?? [])} · active "${tabs?.active ?? ""}" · focused ${tabs?.focused ?? false} · terminal ${JSON.stringify(rows.slice(0, 2))} · ${result}`;
    },
  );

  await step(
    "window.openFoldersInNewWindow set to on in settings.json, so every open keeps the local window",
    async () => {
      const written = userSettings({ "window.openFoldersInNewWindow": "on" });
      await sleep(2_000);
      return `window.openFoldersInNewWindow: ${JSON.stringify(written["window.openFoldersInNewWindow"])}`;
    },
    { via: "setup" },
  );

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

  /** A claude session in a fresh worktree, launched as story a launches one (or the phone, in protocol). */
  const startClaude = async (label, launch) => {
    const created = await api(`/projects/${project.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude", label, base: null, name: null }),
    });
    await api(`/sessions/${created.id}/launch`, { method: "POST", body: JSON.stringify(launch) });
    return created.id;
  };

  const agent = await step(
    "a claude terminal agent, started the way story a starts one: POST /projects/:id/sessions, then launch in a PTY",
    async () => {
      const id = await startClaude("add-rate-limit", { permissionMode: "ask" });
      const pty = await waitUntil(
        "a running session with a live agent-pty",
        async () => {
          const read = await api(`/sessions/${id}`);
          return read.session.status === "running" && read.session.sealantWorkspaceId
            ? (liveProcess(read.processes, "agent-pty") ?? null)
            : null;
        },
        600_000,
      );
      return {
        observed: `session ${id.slice(0, 8)} · running · agent-pty ${pty.id.slice(0, 8)} ${pty.harness} live`,
        id,
        name: "add-rate-limit",
        tab: "claude · add-rate-limit",
      };
    },
    { via: "api" },
  );

  const conversation = await step(
    "a claude conversation started elsewhere (launch in protocol mode with a prompt, as the phone starts one): its first turn completes",
    async () => {
      const id = await startClaude("from-phone", { mode: "protocol", prompt: "say hi" });
      const turn = await waitUntil(
        "the first turn to complete",
        async () => {
          const turns = await api(`/sessions/${id}/turns`);
          return turns.find((item) => item.status === "completed") ?? null;
        },
        600_000,
      );
      const items = await api(`/sessions/${id}/items`);
      const read = await api(`/sessions/${id}`);
      const protocol = liveProcess(read.processes, "agent-protocol");
      expect(protocol !== undefined, `no live agent-protocol: ${JSON.stringify(read.processes)}`);
      return {
        observed: `session ${id.slice(0, 8)} · ${read.session.status} · agent-protocol ${protocol.id.slice(0, 8)} live · turn "${turn.input}" ${turn.status} · the agent answered ${JSON.stringify(items.map((item) => item.text).filter(Boolean))}`,
        id,
        name: "from-phone",
        tab: "claude · from-phone",
      };
    },
    { via: "api" },
  );

  // Run r1c: an inline Open clicked while these rows were still arriving ran `mend.open` without
  // its row (the palette's session pick showed). The calibration starts once the view has them.
  await step(
    "the Mend view lists both claude sessions, then rests",
    async () => {
      await mendView();
      await treeItem(agent.name).waitFor(60_000);
      await treeItem(conversation.name).waitFor(60_000);
      await sleep(5_000);
      return `rows "${await treeItem(agent.name).text()}" and "${await treeItem(conversation.name).text()}"`;
    },
    { via: "setup" },
  );

  /**
   * The row's open button once, the way a person answers what it shows: a `<label> is running`
   * pick (today's extension) gets Open alongside. One window, connected, then closed.
   */
  const openOnce = async (rowName) => {
    const known = await windows();
    const before = await opens();
    const { title } = await treeItem(rowName).inline(OPEN);
    const asked = await waitUntil(
      "a question",
      async () => ((await quickInput.isOpen()) ? await quickInput.title() : null),
      5_000,
    ).catch(() => null);
    if (asked !== null) await quickInput.pick("Open alongside");
    const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
    expect(opened.length === 1, `${opened.length} window(s) opened`);
    await useWindow(opened[0]);
    await statusBar(/SSH:/).waitFor(600_000);
    const after = await opens();
    await closeWindow(opened[0]);
    await useWindow(await homeWindow());
    await mendView();
    return { title, asked, before, after };
  };

  /**
   * Open attempts by the server's log: bursts of the reads only an open makes, a burst being reads
   * less than 3 s apart. Every open reads the workspace SSH facts; today's extension (its button is
   * `Mend: Open in VS Code`) reads the session first and may stop at its takeover question before
   * that, so on it the session's reads count too. The redesign's Mend view reads a session
   * whenever an event names it, so on it only the workspace SSH reads tell an open.
   */
  let asBuilt = false;
  const openAttempts = async (id) => {
    const needles = [`'/api/workspace-ssh'`, ...(asBuilt ? [`'/api/sessions/${id}'`] : [])];
    const times = (await serverLogs())
      .split("\n")
      .filter((line) => needles.some((needle) => line.includes(needle)))
      .map((line) => Date.parse(`${line.slice(0, 23)}Z`))
      .filter((at) => Number.isFinite(at))
      .toSorted((left, right) => left - right);
    let bursts = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const at of times) {
      if (at - last > 3_000) bursts += 1;
      last = at;
    }
    return bursts;
  };

  await step(
    "calibration: the row's open button twice with a gap, opens +1 then +2, and open attempts +1 then +2",
    async () => {
      asBuilt = (await treeItem(session.name).actions()).includes("Mend: Open in VS Code");
      const attemptsBefore = await openAttempts(session.id);
      const first = await openOnce(session.name);
      const attemptsFirst = await openAttempts(session.id);
      expect(
        first.after - first.before === 1,
        `first open: opens ${first.before} → ${first.after}`,
      );
      const second = await openOnce(session.name);
      const attemptsSecond = await openAttempts(session.id);
      expect(
        second.after - first.before === 2,
        `two opens: opens ${first.before} → ${second.after}`,
      );
      const said = `button "${first.title}" · first ${answered(first)}, opens ${first.before} → ${first.after} · second ${answered(second)}, opens ${second.before} → ${second.after} · open attempts ${attemptsBefore} → ${attemptsFirst} → ${attemptsSecond}`;
      expect(
        attemptsFirst - attemptsBefore === 1 && attemptsSecond - attemptsBefore === 2,
        `the open attempts counter is not calibrated: ${said}`,
      );
      return said;
    },
  );

  const resumes = async () =>
    linesMatching(await serverLogs(), `'/api/sessions/${state.warmSession}/resume'`);

  /** Read before and after a gesture; claims rest on `opens`, `windows` and `resumes`. */
  const counts = async () => {
    const log = await serverLogs();
    return {
      opens: await opens(),
      windows: (await windows()).length,
      resumes: linesMatching(log, `'/api/sessions/${state.warmSession}/resume'`),
      sshTargetLookups: linesMatching(log, `/v1/workspaces/${session.workspaceId}/ssh-target`),
      processes: (await api(`/sessions/${session.id}/processes`)).length,
      sessions: (await api(`/projects/${project.id}`)).sessions.length,
    };
  };

  /**
   * One gesture on a row that must open nothing and ask nothing. Everything seen is in the
   * failure's message too, so a failing line names what showed.
   */

  const selectsOnly = async (rowName, id, gesture, slug) => {
    const row = treeItem(rowName);
    await row.waitFor();
    const known = await windows();
    const before = await counts();
    const readsBefore = await openAttempts(id);
    const watching = await watch();
    await gesture(row);
    await sleep(3_000);
    const leftOpen = (await quickInput.isOpen()) ? await quickInput.title() : null;
    await shot(slug);
    const opened = await newWindows(known, { settle: 10_000, limit: 30_000 });
    const seen = await watching.stop();
    const selected = await row.selected().catch(() => false);
    const after = await counts();
    const readsAfter = await openAttempts(id);
    const observed = `open attempts ${readsBefore} → ${readsAfter} (session ${id.slice(0, 8)}) · opens ${before.opens} → ${after.opens} · windows opened ${opened.length} · quick input left open ${leftOpen === null ? "none" : `"${leftOpen}"`} · row selected ${selected} · ${shown(seen)} · ${delta(before, after)}`;
    if (leftOpen !== null) await quickInput.cancel();
    // The watch lists each distinct title once, and the pick left open is one of them.
    const asked = [
      ...new Set(
        seen === null
          ? []
          : [...seen.dialogs, ...seen.quickInputs, ...(leftOpen ? [leftOpen] : [])],
      ),
    ];
    expect(
      readsAfter === readsBefore,
      `${readsAfter - readsBefore} open(s) ran, by the server's reads: ${observed}`,
    );
    expect(after.opens === before.opens, `an open ran: ${observed}`);
    expect(opened.length === 0, `a window opened: ${observed}`);
    expect(asked.length === 0, `it asked ${JSON.stringify(asked)}: ${observed}`);
    expect(seen.toasts.length === 0, `a toast showed: ${observed}`);
    expect(after.resumes === before.resumes, `a resume ran: ${observed}`);
    expect(selected, `the row is not selected: ${observed}`);
    return observed;
  };

  await step(
    "double-click the running session's row: it selects, nothing opens, nothing asks",
    () => selectsOnly(session.name, session.id, (row) => row.dblclick(), "after-double-click"),
  );
  await step("click the running session's row once: it selects, nothing opens, nothing asks", () =>
    selectsOnly(session.name, session.id, (row) => row.click(), "after-click"),
  );
  await step(
    `double-click the stopped ${stoppedName} row: it selects, nothing opens, nothing resumes`,
    () =>
      selectsOnly(
        stoppedName,
        state.warmSession,
        (row) => row.dblclick(),
        "after-double-click-stopped",
      ),
  );

  const twice = await step(
    "the row's open button clicked twice, fast: exactly one new window, nothing asks",
    async () => {
      const known = await windows();
      const before = await counts();
      const watching = await watch();
      const { title, landed } = await treeItem(session.name).inline(OPEN, { clicks: 2 });
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      const seen = await watching.stop();
      expect(opened.length === 1, `${opened.length} window(s) opened · ${shown(seen)}`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      const after = await counts();
      await shot("open-twice");
      const observed = `button "${title}" · clicks landed ${landed} · windows opened ${opened.length} · ${shown(seen)} · ${delta(before, after)}`;
      expect(
        after.opens - before.opens === 1,
        `opens ${before.opens} → ${after.opens}: ${observed}`,
      );
      expect(
        seen !== null && seen.dialogs.length === 0 && seen.quickInputs.length === 0,
        `it asked: ${observed}`,
      );
      return { observed, page: opened[0] };
    },
  );

  await step("that window closed", async () => {
    const result = await closeWindow(twice.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  /** The workspace window's attached tab, read before any terminal gesture. */
  const attachedTab = async () => {
    const tabs = await waitUntil(
      `the tab "${session.tab}" attached and active`,
      async () => {
        const read = await terminal().tabs();
        return read.names.includes(session.tab) && read.active === session.tab ? read : null;
      },
      120_000,
    );
    const rows = await terminal().waitForText(banner, 60_000);
    const line = rows.split("\n").find((row) => row.includes(banner)) ?? "";
    return { tabs, line: line.trim() };
  };

  const alongside = await step(
    "context menu Mend: Open in New Window: exactly one new window, nothing asks",
    async () => {
      const known = await windows();
      const before = await counts();
      const watching = await watch();
      await treeItem(session.name).contextMenu("Mend: Open in New Window");
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      const seen = await watching.stop();
      expect(opened.length === 1, `${opened.length} window(s) opened · ${shown(seen)}`);
      expect(
        seen !== null && seen.dialogs.length === 0 && seen.quickInputs.length === 0,
        `it asked: ${shown(seen)}`,
      );
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      const after = await counts();
      expect(after.opens - before.opens === 1, `opens ${before.opens} → ${after.opens}`);
      await shot("open-in-new-window");
      return {
        observed: `windows opened ${opened.length} · ${shown(seen)} · status bar "${await statusBar(/SSH:/).text()}" · Explorer shows README · ${delta(before, after)}`,
        page: opened[0],
      };
    },
  );

  await step(
    "that window: the live shell attached as its tab, focused, banner shown, before any terminal gesture",
    async () => {
      const { tabs, line } = await attachedTab();
      await shot("new-window-attached-tab");
      expect(tabs.focused, `the keyboard is not in the terminal (tabs ${JSON.stringify(tabs)})`);
      return `title "${await alongside.page.title()}" · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · banner "${line}"`;
    },
  );

  await step("a new terminal in that window runs in the workspace and writes a file", async () => {
    await palette("Terminal: Create New Terminal");
    await terminal().waitFor(60_000);
    await terminal().type("echo who-$(id -un) in $(pwd); printf 'verified\\n' > VERIFY.md; ls");
    const rows = await terminal().waitForText(/who-\S+ in \/workspace\/repo/, 60_000);
    await terminal().waitForText("VERIFY.md", 30_000);
    await shot("workspace-terminal");
    const line = rows.split("\n").find((row) => /who-\S+ in \//.test(row)) ?? "";
    return `terminal "${line.trim()}" · VERIFY.md listed · tabs ${JSON.stringify((await terminal().tabs()).names)}`;
  });

  await step(
    "the open button again in that window, which already is the workspace: the attached tab focused, no reload, nothing opens",
    async () => {
      const url = alongside.page.url();
      const before = await counts();
      const watching = await watch();
      await mendView();
      const { title } = await treeItem(ownRow(session.name)).inline(OPEN);
      const tabs = await waitUntil(
        "the attached tab to be active and focused",
        async () => {
          const read = await terminal().tabs();
          return read.active === session.tab && read.focused ? read : null;
        },
        30_000,
      );
      await sleep(5_000);
      const seen = await watching.stop();
      const after = await counts();
      await shot("open-again-focuses");
      expect(seen !== null, "the window navigated: it reloaded");
      expect(alongside.page.url() === url, "the window's page changed");
      expect(after.windows === before.windows, `windows ${before.windows} → ${after.windows}`);
      expect(after.opens === before.opens, `opens ${before.opens} → ${after.opens}`);
      expect(seen.dialogs.length === 0, `dialogs ${JSON.stringify(seen.dialogs)}`);
      return `button "${title}" · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · page unchanged · ${shown(seen)} · ${delta(before, after)}`;
    },
  );

  await step(
    "the open button in the local window while the other window has the session: what VS Code does",
    async () => {
      const home = await homeWindow();
      await useWindow(home);
      await mendView();
      const homeUrl = home.url();
      const homeTitle = await home.title();
      const known = await windows();
      const before = await counts();
      const watching = await watch();
      await treeItem(session.name).inline(OPEN);
      const opened = await newWindows(known, { settle: 10_000, limit: 60_000 });
      const seen = await watching.stop();
      const after = await counts();
      const focus = await Promise.all(
        (await windows()).map(async (window) => ({
          title: window.title,
          focused: await window.page.evaluate(() => document.hasFocus()).catch(() => null),
        })),
      );
      await shot("open-while-elsewhere");
      return `windows opened ${opened.length} · local window ${home.url() === homeUrl && (await home.title()) === homeTitle ? "did not navigate" : `navigated to "${await home.title()}"`} · document.hasFocus ${JSON.stringify(focus)} · ${shown(seen)} · ${delta(before, after)}`;
    },
  );

  await step("every workspace window closed, back to the local window", async () => {
    const home = await homeWindow();
    const extra = (await windows()).filter((window) => window.page !== home);
    const results = [];
    for (const window of extra) results.push(await closeWindow(window));
    await useWindow(home);
    await mendView();
    return `${extra.length} closed · ${results.join(" · ")}`;
  });

  const stopped = await step(
    `the stopped ${stoppedName}'s open button: it resumes, the status bar reads "starting ${stoppedName}'s workspace · <n> s", one window, nothing asks`,
    async () => {
      const row = treeItem(stoppedName);
      await row.waitFor();
      const description = await row.description();
      const known = await windows();
      const opensBefore = await opens();
      const resumesBefore = await resumes();
      const watching = await watch();
      await row.inline(OPEN);
      const starting = statusBar(`starting ${stoppedName}'s workspace`);
      const caught = await starting
        .waitFor(60_000)
        .then(() => starting.text())
        .catch(() => null);
      if (caught !== null) await shot("stopped-starting");
      const opened = await newWindows(known, { settle: 10_000, limit: 600_000 });
      const seen = await watching.stop();
      expect(opened.length === 1, `${opened.length} window(s) opened · ${shown(seen)}`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      const opensAfter = await opens();
      const resumesAfter = await waitUntil(
        "the resume in the server's log",
        async () => {
          const now = await resumes();
          return now > resumesBefore ? now : null;
        },
        60_000,
      ).catch(() => resumesBefore);
      await shot("stopped-opened");
      const observed = `row read "${description}" · status bar ${caught === null ? "never showed starting" : `"${caught}"`} · windows opened ${opened.length} · opens ${opensBefore} → ${opensAfter} · resumes ${resumesBefore} → ${resumesAfter} · status bar "${await statusBar(/SSH:/).text()}" · Explorer shows README · ${shown(seen)}`;
      expect(caught !== null, `no starting progress: ${observed}`);
      expect(seen !== null && seen.dialogs.length === 0, `dialogs: ${observed}`);
      expect(seen.quickInputs.length === 0, `quick inputs: ${observed}`);
      expect(seen.toasts.length === 0, `toasts: ${observed}`);
      expect(opensAfter - opensBefore === 1, `opens: ${observed}`);
      expect(resumesAfter - resumesBefore === 1, `resumes: ${observed}`);
      return { observed, page: opened[0] };
    },
  );

  await step("that window closed", async () => {
    const result = await closeWindow(stopped.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  const caughtStopping = await step(
    `SLNT-143: the open button on ${stoppedName} the moment its row turns from running: the open targets it, waits the stop out, resumes it once, one window, no Choose a session`,
    async () => {
      await useWindow(await homeWindow());
      await mendView();
      const known = await windows();
      const opensBefore = await opens();
      const resumesBefore = await resumes();
      // The stop is the setup; Open is clicked as soon as the server reads it stopping.
      const stopping = api(`/sessions/${state.warmSession}/stop`, { method: "POST", body: "{}" });
      const atClick = await waitUntil(
        "the server to read it stopping",
        async () => {
          const { session: read } = await api(`/sessions/${state.warmSession}`);
          return read.status === "running" ? null : read.status;
        },
        60_000,
      );
      const watching = await watch();
      // The click lands as the row's own status redraws (SLNT-143): a redraw that dropped the row
      // ran Open with no row, which asks `Choose a session`.
      const row = treeItem(stoppedName);
      const before = await row.description();
      let redrawn = before;
      for (const until = Date.now() + 60_000; Date.now() < until && /^running/.test(redrawn); )
        redrawn = await row.description();
      await row.inline(OPEN);
      await stopping;
      const opened = await newWindows(known, { settle: 10_000, limit: 600_000 });
      const seen = await watching.stop();
      expect(opened.length === 1, `${opened.length} window(s) opened · ${shown(seen)}`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      const opensAfter = await opens();
      await sleep(5_000);
      const resumesAfter = await resumes();
      const bar = await statusBarItems();
      await shot("stopping-opened");
      const observed = `the server read "${atClick}" · the row read "${before}", then "${redrawn}" at the click · windows opened ${opened.length} · its status bar ${JSON.stringify(bar.filter((text) => text.includes(stoppedName) || text.includes("SSH:")))} · opens ${opensBefore} → ${opensAfter} · resumes ${resumesBefore} → ${resumesAfter} · ${shown(seen)}`;
      expect(!/^running/.test(redrawn), `the row never turned from running: ${observed}`);
      expect(seen !== null && seen.dialogs.length === 0, `dialogs: ${observed}`);
      expect(
        !seen.quickInputs.some((title) => title.includes("Choose a session")),
        `Choose a session: ${observed}`,
      );
      expect(seen.quickInputs.length === 0, `quick inputs: ${observed}`);
      expect(
        bar.some((text) => text.includes(stoppedName)),
        `the window is not ${stoppedName}'s: ${observed}`,
      );
      expect(opensAfter - opensBefore === 1, `opens: ${observed}`);
      expect(resumesAfter - resumesBefore === 1, `resumes: ${observed}`);
      return { observed, page: opened[0] };
    },
  );

  await step("that window closed", async () => {
    const result = await closeWindow(caughtStopping.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  /** The center of `text` where the active terminal draws it, for a pointer to go to. */
  const terminalTextAt = (text) =>
    page().evaluate((wanted) => {
      for (const row of document.querySelectorAll(
        ".terminal-wrapper.active .xterm-rows > div, .terminal .xterm-rows > div",
      )) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const at = (node.textContent ?? "").indexOf(wanted);
          if (at === -1) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + wanted.length);
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
      }
      return null;
    }, text);

  const handoffs = async () =>
    linesMatching(await serverLogs(), `'/api/sessions/${conversation.id}/handoff'`);

  const elsewhere = await step(
    "context menu Mend: Open in New Window on the conversation: its tab says it runs as a conversation, with Continue here",
    async () => {
      await useWindow(await homeWindow());
      await mendView();
      const known = await windows();
      await treeItem(conversation.name).contextMenu("Mend: Open in New Window");
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      expect(opened.length === 1, `${opened.length} window(s) opened`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      const tabs = await waitUntil(
        `the tab "${conversation.tab}" active`,
        async () => {
          const read = await terminal().tabs();
          return read.active === conversation.tab ? read : null;
        },
        120_000,
      );
      const rows = await terminal().waitForText("Continue here", 60_000);
      await shot("conversation-tab");
      const line = rows.split("\n").find((row) => row.includes("Continue here")) ?? "";
      expect(
        line.includes("claude is running as a conversation"),
        `the tab reads ${JSON.stringify(rows)}`,
      );
      return {
        observed: `tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · line "${line.trim()}"`,
        page: opened[0],
      };
    },
  );

  await step(
    "Ctrl+click Continue here: one handoff, the tab becomes claude's TUI with the conversation, she types to it",
    async () => {
      const before = await handoffs();
      const at = await terminalTextAt("Continue here");
      expect(at !== null, "Continue here is not on the screen");
      await page().mouse.move(at.x, at.y);
      const hover = await waitUntil(
        "the link's hover",
        async () =>
          page().evaluate(
            () =>
              document.querySelector(".monaco-hover, .workbench-hover")?.textContent?.trim() ||
              null,
          ),
        10_000,
      ).catch(() => null);
      await shot("continue-here-hover");
      await page().keyboard.down("Control");
      await page().mouse.click(at.x, at.y);
      await page().keyboard.up("Control");
      const read = await waitUntil(
        "a live agent-pty and no live agent-protocol",
        async () => {
          const now = await api(`/sessions/${conversation.id}`);
          return liveProcess(now.processes, "agent-pty") &&
            !liveProcess(now.processes, "agent-protocol")
            ? now
            : null;
        },
        120_000,
      );
      const tui = await terminal().waitForText("❯", 120_000);
      const tabs = await terminal().tabs();
      await shot("continue-here-tui");
      const prompt = () => tui.split("\n").findLast((row) => row.includes("❯")) ?? "";
      const promptBefore = prompt();
      await page().keyboard.type("go on");
      const typed = await terminal().waitForText(/❯\s+go on/, 30_000);
      await shot("continue-here-typed");
      const after = await handoffs();
      const observed = `hover ${JSON.stringify(hover)} · handoffs ${before} → ${after} · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · processes ${JSON.stringify(read.processes.map((process) => [process.kind, process.status]))} · the conversation in the TUI ${typed.includes("say hi")} · prompt before "${promptBefore.trim()}" · after "${(typed.split("\n").findLast((row) => /❯\s+go on/.test(row)) ?? "").trim()}"`;
      expect(after - before === 1, observed);
      expect(tabs.active === conversation.tab, observed);
      return observed;
    },
  );

  await step("that window closed", async () => {
    const result = await closeWindow(elsewhere.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  // Ana is a second account in the organization. Her token stays in `asAna` and out of every
  // observation.
  let asAna = null;
  const ana = await step(
    "Ana joins, the project is shared, she runs a session as a shell and turns on shared control",
    async () => {
      const origin = state.server.origin;
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
      const bearer = signUp.headers.get("set-auth-token");
      expect(signUp.ok && bearer, `Ana's sign-up answered ${signUp.status}`);
      asAna = async (route, init = {}) => {
        const response = await fetch(`${origin}/api${route}`, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        });
        const text = await response.text();
        expect(response.ok, `${init.method ?? "GET"} ${route} as Ana → ${response.status}`);
        return text === "" ? null : JSON.parse(text);
      };
      await api(`/projects/${project.id}/visibility`, {
        method: "PUT",
        body: JSON.stringify({ visibility: "shared" }),
      });
      const created = await asAna(`/projects/${project.id}/sessions`, {
        method: "POST",
        body: JSON.stringify({ harness: "claude", label: "ana", base: null, name: null }),
      });
      await asAna(`/sessions/${created.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ harness: "shell" }),
      });
      await waitUntil(
        "Ana's session to run with a workspace",
        async () => {
          const { session: read } = await asAna(`/sessions/${created.id}`);
          return read.sealantWorkspaceId && ["running", "idle", "waiting"].includes(read.status)
            ? true
            : null;
        },
        300_000,
      );
      await asAna(`/sessions/${created.id}/shared-control`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      const row = (await api(`/projects/${project.id}`)).sessions.find(
        (item) => item.id === created.id,
      );
      return {
        observed: `Ana's session ${created.id.slice(0, 8)} · ${row.status} · its launcher is its owner (Ana) ${row.workspaceLauncherUserId !== null && row.workspaceLauncherUserId === row.ownerUserId} · live people ${JSON.stringify(row.livePeople?.map((person) => person.name ?? person))} · shared control ${row.sharedControlEnabledAt !== null}`,
        id: created.id,
      };
    },
    { via: "api" },
  );

  await step(
    "Ana's row, shared control on: Watch terminal and Review change offered, no Open, the tooltip says why",
    async () => {
      await useWindow(await homeWindow());
      await mendView();
      await palette("Mend: Refresh");
      const row = treeItem("ana");
      await row.waitFor(60_000);
      const actions = await row.actions();
      const menu = await row.menu();
      const tooltip = await row.tooltip();
      await shot("ana-row-tooltip");
      const observed = `row "${await row.text()}" · inline ${JSON.stringify(actions)} · menu ${JSON.stringify(menu)} · tooltip ${JSON.stringify(tooltip)}`;
      expect(actions.includes("Mend: Watch terminal"), observed);
      expect(actions.includes("Mend: Review change"), observed);
      expect(!actions.some((title) => OPEN.test(title)), observed);
      expect(
        !menu.some((item) => OPEN.test(item) || item === "Mend: Open in New Window"),
        observed,
      );
      expect(tooltip.includes("Ana launched this workspace"), observed);
      return observed;
    },
  );

  await step("Mend: Watch terminal on Ana's row: her shell, read-only", async () => {
    await page().mouse.move(1, 1);
    await treeItem("ana").inline("Mend: Watch terminal");
    const rows = await terminal().waitForText("read-only · Ana's session", 60_000);
    const tabs = await terminal().tabs();
    await shot("ana-watch-terminal");
    const line = rows.split("\n").find((row) => row.includes("read-only")) ?? "";
    return `banner "${line.trim()}" · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}"`;
  });

  /** Opens and windows, which no gesture at Ana's session may change. */
  const openCounts = async () => ({ opens: await opens(), windows: (await windows()).length });

  /** Mend: Open from the palette in the local window: the session pick, Ana's item as listed. */
  const paletteAna = async () => {
    await useWindow(await homeWindow());
    await palette("Mend: Open");
    await quickInput.waitFor();
    const title = await quickInput.title();
    const items = (await quickInput.items()).map((item) => item.replace(/\s+/g, " ").trim());
    return { title, items, anas: items.find((item) => item.includes(ANA_WHY)) ?? null };
  };

  await step(
    "Mend: Open from the palette, shared control on: the pick lists Ana's session with Watch terminal and why; picking it watches, nothing opens",
    async () => {
      await useWindow(await homeWindow());
      await palette("Terminal: Kill All Terminals");
      await waitUntil(
        "no terminal tab left",
        async () => ((await terminal().tabs()).names.length === 0 ? true : null),
        30_000,
      );
      const before = await openCounts();
      const tabsBefore = (await terminal().tabs()).names.length;
      const watching = await watch();
      const { title, items, anas } = await paletteAna();
      await shot("palette-ana-watch");
      const listed = `pick "${title}" · items ${JSON.stringify(items)}`;
      expect(anas !== null && anas.includes("Watch terminal"), listed);
      await quickInput.pick(ANA_WHY);
      const rows = await terminal().waitForText("read-only · Ana's session", 60_000);
      const tabs = await terminal().tabs();
      await sleep(3_000);
      const seen = await watching.stop();
      const after = await openCounts();
      await shot("palette-ana-watched");
      const observed = `${listed} · Ana's item "${anas}" · then tabs ${tabsBefore} → ${tabs.names.length}, active "${tabs.active}", banner ${rows.includes("read-only · Ana's session")} · ${shown(seen)} · ${delta(before, after)}`;
      expect(after.opens === before.opens && after.windows === before.windows, observed);
      expect(tabs.names.length === tabsBefore + 1, `no new tab: ${observed}`);
      expect(seen !== null && seen.dialogs.length === 0, observed);
      return observed;
    },
  );

  /**
   * A deep link to Ana's session followed from outside VS Code. VS Code asks first whether Mend may
   * have the URI (its own dialog, before the extension sees anything); Open is the person's answer.
   * Then Mend must open nothing and say why once, offering `offer`, which she clicks at once (the
   * toast hides itself after a few seconds). `after` reads what the click led to.
   */
  const deepLinkAna = async (offer, slug, after) => {
    await useWindow(await homeWindow());
    const before = await openCounts();
    const watching = await watch();
    await openUrl(`vscode://sealant-sh.mend/open?session=${ana.id}`);
    const asked = dialog("open this URI");
    await asked.waitFor(30_000);
    const vscodeAsked = await asked.text();
    await asked.click("Open");
    const toast = notification(ANA_WHY);
    await toast.waitFor(60_000);
    const said = await toast.text();
    await shot(slug);
    expect(said.includes(offer), `the toast "${said}" does not offer ${offer}`);
    await toast.click(offer);
    const followed = await after();
    await sleep(3_000);
    const seen = await watching.stop();
    const counted = await openCounts();
    await shot(`${slug}-clicked`);
    const told = seen === null ? [] : seen.toasts.filter((text) => text.includes(ANA_WHY));
    const observed = `VS Code asked "${vscodeAsked}", Open clicked · toast "${said}" · ${offer} clicked: ${followed} · ${shown(seen)} · ${delta(before, counted)}`;
    expect(counted.opens === before.opens && counted.windows === before.windows, observed);
    expect(told.length === 1, `said why ${told.length} times: ${observed}`);
    expect(!/\bOpen\b/.test(said.replace(ANA_WHY, "")), `the toast offers Open: ${observed}`);
    return observed;
  };

  await step(
    "vscode://sealant-sh.mend/open?session=<Ana's> from outside, shared control on: nothing opens, Mend says why once and offers Watch terminal, which watches",
    () =>
      deepLinkAna("Watch terminal", "deep-link-ana-watch", async () => {
        const rows = await terminal().waitForText("read-only · Ana's session", 60_000);
        const tabs = await terminal().tabs();
        return `tabs ${JSON.stringify(tabs.names)}, active "${tabs.active}", banner ${rows.includes("read-only · Ana's session")}`;
      }),
  );

  await step(
    "Ana turns shared control off",
    async () => {
      await asAna(`/sessions/${ana.id}/shared-control`, {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      await sleep(5_000);
      return "shared control off";
    },
    { via: "api" },
  );

  await step(
    "Ana's row, shared control off: Review change, no Watch terminal, no Open",
    async () => {
      const tabs = await terminal().tabs();
      const toasts = await notifications();
      await shot("ana-shared-control-off");
      await mendView();
      await palette("Mend: Refresh");
      const row = treeItem("ana");
      const actions = await waitUntil(
        "the row to drop Watch terminal",
        async () => {
          const read = await row.actions();
          return read.includes("Mend: Watch terminal") ? null : read;
        },
        30_000,
      );
      const menu = await row.menu();
      await shot("ana-row-review-only");
      const observed = `the watching tab after shared control went off: tabs ${JSON.stringify(tabs.names)}, toasts ${JSON.stringify(toasts)} · inline ${JSON.stringify(actions)} · menu ${JSON.stringify(menu)}`;
      expect(actions.includes("Mend: Review change"), observed);
      expect(!actions.some((title) => OPEN.test(title)), observed);
      return observed;
    },
  );

  await step(
    "the deep link again, shared control off: nothing opens, Mend says why once and offers Review; what its click leads to",
    () =>
      deepLinkAna("Review", "deep-link-ana-review", async () => {
        await sleep(3_000);
        const shownDialogs = await dialogs();
        const toasts = await notifications();
        if (shownDialogs.length > 0) await page().keyboard.press("Escape");
        return `dialogs ${JSON.stringify(shownDialogs)} (dismissed) · toasts ${JSON.stringify(toasts)}`;
      }),
  );

  await step(
    "Mend: Open from the palette, shared control off: the pick lists Ana's session with Review, not Open",
    async () => {
      const { title, items, anas } = await paletteAna();
      await shot("palette-ana-review");
      await quickInput.cancel();
      const observed = `pick "${title}" · Ana's item "${anas}" · items ${JSON.stringify(items)}`;
      expect(anas !== null && anas.includes("Review"), observed);
      expect(!anas.includes("Watch terminal"), observed);
      return observed;
    },
  );

  await step(
    "Mend: Choose a session, shared control off: its pick lists Ana's session with Review, not Open; nothing opens",
    async () => {
      await useWindow(await homeWindow());
      const before = await openCounts();
      const itemText = (await statusBarItems()).filter((text) => text.includes("Mend")).join(" | ");
      await palette("Mend: Choose a session");
      await quickInput.waitFor();
      const title = await quickInput.title();
      const items = (await quickInput.items()).map((entry) => entry.replace(/\s+/g, " ").trim());
      const anas = items.find((entry) => entry.includes(ANA_WHY)) ?? null;
      await shot("session-pick-ana");
      await quickInput.cancel();
      const after = await openCounts();
      const observed = `status bar "${itemText}" · pick "${title}" · Ana's item "${anas}" · items ${JSON.stringify(items)} · ${delta(before, after)}`;
      expect(anas !== null && /running.* · Review/.test(anas), observed);
      expect(!anas.includes("Watch terminal"), observed);
      expect(after.opens === before.opens && after.windows === before.windows, observed);
      return observed;
    },
  );

  const second = await step(
    `a second claude session joins ${agent.name}'s worktree, launched in a PTY: two live sessions in one workspace, the second the newer`,
    async () => {
      const { session: first } = await api(`/sessions/${agent.id}`);
      const created = await api(`/projects/${project.id}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          harness: "claude",
          label: "second-look",
          base: null,
          name: first.worktree,
        }),
      });
      await api(`/sessions/${created.id}/launch`, {
        method: "POST",
        body: JSON.stringify({ permissionMode: "ask" }),
      });
      const pty = await waitUntil(
        "the second session running in the same workspace with a live agent-pty",
        async () => {
          const read = await api(`/sessions/${created.id}`);
          return read.session.status === "running" &&
            read.session.sealantWorkspaceId === first.sealantWorkspaceId
            ? (liveProcess(read.processes, "agent-pty") ?? null)
            : null;
        },
        600_000,
      );
      const { session: now } = await api(`/sessions/${created.id}`);
      const firstNow = await api(`/sessions/${agent.id}`);
      expect(
        liveProcess(firstNow.processes, "agent-pty") !== undefined,
        `${agent.name}'s agent is no longer live: ${JSON.stringify(firstNow.processes)}`,
      );
      expect(now.createdAt > first.createdAt, `created ${first.createdAt} then ${now.createdAt}`);
      return {
        observed: `worktree "${first.worktree}" · workspace ${first.sealantWorkspaceId} · ${agent.name} ${agent.id.slice(0, 8)} created ${first.createdAt}, agent-pty live · second-look ${created.id.slice(0, 8)} created ${now.createdAt}, agent-pty ${pty.id.slice(0, 8)} live`,
        id: created.id,
        name: "second-look",
        tab: "claude · second-look",
      };
    },
    { via: "api" },
  );

  const older = await step(
    `the open button on ${agent.name}, the older of the two (the setting is on, so a new window): its claude is attached and focused, not second-look's`,
    async () => {
      await useWindow(await homeWindow());
      await mendView();
      await palette("Mend: Refresh");
      await treeItem(second.name).waitFor(60_000);
      const known = await windows();
      const before = await openCounts();
      await treeItem(agent.name).inline(OPEN);
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      expect(opened.length === 1, `${opened.length} window(s) opened`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      const tabs = await waitUntil(
        `the tab "${agent.tab}" attached, active and focused`,
        async () => {
          const read = await terminal().tabs();
          return read.active === agent.tab && read.focused ? read : null;
        },
        120_000,
      ).catch(async () => {
        throw new Error(`the attached tabs are ${JSON.stringify(await terminal().tabs())}`);
      });
      await sleep(5_000);
      const later = await terminal().tabs();
      await shot("older-of-two-attached");
      const after = await openCounts();
      const observed = `tabs ${JSON.stringify(later.names)} · active "${later.active}" · focused ${tabs.focused} · ${delta(before, after)}`;
      expect(!later.names.includes(second.tab), `second-look's tab attached: ${observed}`);
      expect(later.active === agent.tab, observed);
      return { observed, page: opened[0] };
    },
  );

  await step(
    `in ${agent.name}'s window, second-look picked from the others line (it shares the workspace): its own claude attached and focused, nothing opens`,
    async () => {
      const url = older.page.url();
      const before = await openCounts();
      const watching = await watch();
      await mendView();
      // The workspace window lists only its own session; the others line opens the picker.
      await treeItem(/other sessions?/).click();
      await quickInput.waitFor();
      await quickInput.pick(second.name);
      const tabs = await waitUntil(
        `the tab "${second.tab}" attached, active and focused`,
        async () => {
          const read = await terminal().tabs();
          return read.active === second.tab && read.focused ? read : null;
        },
        120_000,
      );
      const rows = await terminal().waitForText("❯", 120_000);
      await sleep(3_000);
      const seen = await watching.stop();
      const after = await openCounts();
      await shot("second-of-two-focused");
      const observed = `tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · prompt "${(rows.split("\n").findLast((row) => row.includes("❯")) ?? "").trim()}" · page unchanged ${older.page.url() === url} · ${shown(seen)} · ${delta(before, after)}`;
      expect(seen !== null && older.page.url() === url, `the window reloaded: ${observed}`);
      expect(after.opens === before.opens && after.windows === before.windows, observed);
      return observed;
    },
  );

  await step(
    `in that window, now ${second.name}'s workspace, context menu Open in New Window on its own row: VS Code keeps one window per folder, so it focuses ${second.name}'s agent here, nothing asks`,
    async () => {
      const url = older.page.url();
      const known = await windows();
      const before = await openCounts();
      const watching = await watch();
      await mendView();
      await treeItem(ownRow(second.name)).contextMenu("Mend: Open in New Window");
      const tabs = await waitUntil(
        `the tab "${second.tab}" active and focused again`,
        async () => {
          const read = await terminal().tabs();
          return read.active === second.tab && read.focused ? read : null;
        },
        60_000,
      );
      const opened = await newWindows(known, { settle: 10_000, limit: 30_000 });
      const seen = await watching.stop();
      const after = await openCounts();
      await shot("new-window-from-inside");
      const observed = `windows opened ${opened.length} · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · page unchanged ${older.page.url() === url} · ${shown(seen)} · ${delta(before, after)}`;
      expect(opened.length === 0, `windows: ${observed}`);
      expect(after.opens === before.opens, `opens: ${observed}`);
      expect(seen !== null && seen.dialogs.length === 0 && seen.quickInputs.length === 0, observed);
      return observed;
    },
  );

  await step(
    `${second.name} stopped while ${agent.name} keeps their shared workspace running`,
    async () => {
      const { session: before } = await api(`/sessions/${second.id}`);
      await api(`/sessions/${second.id}/stop`, { method: "POST", body: "{}" });
      const stopped = await waitUntil(
        `${second.name} to settle`,
        async () => {
          const { session: read } = await api(`/sessions/${second.id}`);
          return SETTLED.has(read.status) ? read : null;
        },
        120_000,
      );
      const { session: holder } = await api(`/sessions/${agent.id}`);
      const observed = `${second.name} ${stopped.status} · workspace ${before.sealantWorkspaceId} → ${stopped.sealantWorkspaceId} · ${agent.name} ${holder.status} in ${holder.sealantWorkspaceId}`;
      expect(
        stopped.sealantWorkspaceId === before.sealantWorkspaceId &&
          holder.sealantWorkspaceId === before.sealantWorkspaceId,
        `the workspace moved: ${observed}`,
      );
      return observed;
    },
    { via: "api" },
  );

  await step(
    `in that window, which is ${second.name}'s workspace, the open button on the stopped ${second.name}: it resumes as a step, then shows its agent here; nothing opens, nothing asks`,
    async () => {
      const resumesOf = async () =>
        linesMatching(await serverLogs(), `'/api/sessions/${second.id}/resume'`);
      const url = older.page.url();
      const known = await windows();
      const before = await openCounts();
      const resumedBefore = await resumesOf();
      const watching = await watch();
      await view("Mend");
      await treeItem(ownRow(second.name)).inline(OPEN);
      const starting = statusBar(`starting ${second.name}'s workspace`);
      const caught = await starting
        .waitFor(60_000)
        .then(() => starting.text())
        .catch(() => null);
      const shellTab = `shell · ${second.name}`;
      const tabs = await waitUntil(
        `the tab "${shellTab}" attached, active and focused`,
        async () => {
          const read = await terminal().tabs();
          return read.active === shellTab && read.focused ? read : null;
        },
        300_000,
      ).catch(async () => {
        throw new Error(`the tabs are ${JSON.stringify(await terminal().tabs())}`);
      });
      await sleep(3_000);
      const opened = await newWindows(known, { settle: 5_000, limit: 15_000 });
      const seen = await watching.stop();
      const after = await openCounts();
      const resumedAfter = await resumesOf();
      const { session: now } = await api(`/sessions/${second.id}`);
      await shot("stopped-in-own-window-resumed");
      const observed = `status bar ${caught === null ? "never showed starting" : `"${caught}"`} · resumes of ${second.name} ${resumedBefore} → ${resumedAfter} · ${second.name} now ${now.status} in ${now.sealantWorkspaceId} · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · windows opened ${opened.length} · page unchanged ${older.page.url() === url} · ${shown(seen)} · ${delta(before, after)}`;
      expect(caught !== null, `no starting progress: ${observed}`);
      expect(resumedAfter - resumedBefore === 1, `resumes: ${observed}`);
      expect(opened.length === 0 && after.opens === before.opens, `a window opened: ${observed}`);
      expect(older.page.url() === url, `the window reloaded: ${observed}`);
      expect(
        seen !== null && seen.dialogs.length === 0 && seen.quickInputs.length === 0,
        `it asked: ${observed}`,
      );
      return observed;
    },
  );

  await step("that workspace window closed, back to the local window", async () => {
    const result = await closeWindow(older.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  await step(
    "window.openFoldersInNewWindow removed from settings.json: VS Code's default again",
    async () => {
      const written = userSettings({ "window.openFoldersInNewWindow": undefined });
      await sleep(2_000);
      return `window.openFoldersInNewWindow: ${JSON.stringify(written["window.openFoldersInNewWindow"] ?? "default (unset)")}`;
    },
    { via: "setup" },
  );

  await step(
    "LAST, the default setting: Open on the claude terminal agent in the local window turns that window into its workspace",
    async () => {
      const home = await homeWindow();
      await useWindow(home);
      await mendView();
      if (await quickInput.isOpen()) await quickInput.cancel();
      const titleBefore = await home.title();
      const before = await counts();
      const watching = await watch();
      const { title } = await treeItem(agent.name).inline(OPEN);
      await waitUntil(
        "the window's title to gain [SSH:",
        async () => ((await home.title().catch(() => "")).includes("[SSH:") ? true : null),
        600_000,
      );
      const seen = await watching.stop();
      await statusBar(/SSH:/).waitFor(600_000);
      const after = await counts();
      const leftOpen = await quickInput.isOpen();
      const shownDialogs = await dialogs();
      const observed = `button "${title}" · title before "${titleBefore}" · title now "${await home.title()}" · ${delta(before, after)} · ${shown(seen)} · dialogs now ${JSON.stringify(shownDialogs)} · quick input open ${leftOpen} · status bar "${await statusBar(/SSH:/).text()}"`;
      expect(after.windows === before.windows, observed);
      expect(after.opens - before.opens === 1, observed);
      expect(shownDialogs.length === 0, observed);
      expect(!leftOpen, observed);
      return observed;
    },
  );

  const typedAt = await step(
    `the window that became the workspace: "${agent.tab}" attached and focused, claude's TUI at its prompt, before any gesture; the newer second-look sharing the worktree is not the one attached`,
    async () => {
      const tabs = await waitUntil(
        `the tab "${agent.tab}" attached, active and focused`,
        async () => {
          const read = await terminal().tabs();
          return read.active === agent.tab && read.focused ? read : null;
        },
        120_000,
      );
      const rows = await terminal().waitForText("❯", 120_000);
      await shot("window-becomes-workspace");
      const prompt = rows.split("\n").findLast((row) => row.includes("❯")) ?? "";
      expect(
        !tabs.names.includes(second.tab),
        `second-look's tab attached: ${JSON.stringify(tabs)}`,
      );
      return {
        observed: `window title "${await page().title()}" (the story wants "${agent.name} — ${project.name}") · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · prompt "${prompt.trim()}"`,
        prompt: prompt.trim(),
      };
    },
  );

  await step("she types into the attached claude: the keystrokes reach its TUI", async () => {
    await page().keyboard.type("add a test for the limit");
    const rows = await terminal().waitForText(/❯\s+add a test for the limit/, 30_000);
    await shot("typed-into-claude");
    const prompt = rows.split("\n").findLast((row) => row.includes("❯")) ?? "";
    return `prompt before "${typedAt.prompt}" · after "${prompt.trim()}"`;
  });

  await step("its Explorer shows the worktree's files", async () => {
    await view("Explorer");
    await waitForText("README", { timeout: 120_000 });
    await shot("window-becomes-workspace-explorer");
    return "Explorer shows README";
  });

  await step(
    "a terminal she opens there runs in the workspace: she writes a file and lists it",
    async () => {
      await palette("Terminal: Create New Terminal");
      await terminal().waitFor(60_000);
      await terminal().type("echo who-$(id -un) in $(pwd); printf 'limit\\n' > LIMIT.md; ls");
      const rows = await terminal().waitForText(/who-\S+ in \/workspace\/repo/, 60_000);
      await terminal().waitForText("LIMIT.md", 30_000);
      await shot("claude-workspace-terminal");
      const line = rows.split("\n").find((row) => /who-\S+ in \//.test(row)) ?? "";
      return `terminal "${line.trim()}" · LIMIT.md listed · tabs ${JSON.stringify((await terminal().tabs()).names)}`;
    },
  );

  await step(
    `verified-unreachable: a window asked for a session its running workspace no longer holds. ${second.name} stopped and removed while ${agent.name} holds the workspace stays listed in it`,
    async () => {
      await api(`/sessions/${second.id}/stop`, { method: "POST", body: "{}" });
      await waitUntil(
        `${second.name} to settle`,
        async () =>
          SETTLED.has((await api(`/sessions/${second.id}`)).session.status) ? true : null,
        120_000,
      );
      const removal = await api(`/sessions/${second.id}`, { method: "DELETE" });
      const listed = (await api(`/projects/${project.id}`)).sessions.find(
        (item) => item.id === second.id,
      );
      const { session: holder } = await api(`/sessions/${agent.id}`);
      return `DELETE answered ${JSON.stringify(removal)} · ${second.name} listed ${listed === undefined ? "no" : `${listed.status} in ${listed.sealantWorkspaceId}`} · ${agent.name} ${holder.status} in ${holder.sealantWorkspaceId}. A session leaves its workspace only once that workspace stops, and a workspace window closes when its workspace stops, so no running window can take an intent for a session it lost; the unit tests cover that branch`;
    },
    { via: "api" },
  );

  await step(
    "what the server observed of the sessions after the opens",
    async () => {
      const read = async (id) => {
        const detail = (await api(`/sessions/${id}`)).session;
        const processes = await api(`/sessions/${id}/processes`);
        return `${id.slice(0, 8)} ${detail.status} ${JSON.stringify(processes.map((process) => [process.kind, process.status]))}`;
      };
      return `workbench ${await read(session.id)} · ${stoppedName} ${await read(state.warmSession)} · ${agent.name} ${await read(agent.id)} · ${second.name} ${await read(second.id)} · ${conversation.name} ${await read(conversation.id)} · ana ${await read(ana.id)}`;
    },
    { via: "api" },
  );
};
