// Stories c and e, driven the same way against any build of the extension: today's (main's
// `apps/vscode`, whose row button is `Mend: Open in VS Code`) and the redesign (`Mend: Open`). The
// counter is calibrated first: the row's open button twice with a gap must read `opens` +1, then +2.
// Then every step asserts the story: a double-click and a click open nothing and ask nothing (today's
// extension fails here, at the double-click), two fast Opens make one window, Open in New Window
// makes one, the workspace window attaches the session's live terminal, a stopped session opens
// through its resume, Ana's session offers what Dana may do instead of Open, and Open with VS Code's
// default setting turns the window itself into the workspace.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-open.mjs --out <dir>
//
// Needs a world from `up` that is signed in with workspace SSH set up (the default). The last lane
// turns the first window into a workspace, so it runs last and nothing can follow it.
//
// The world has no provider login: a claude terminal agent and a conversation cannot start, so a
// Workbench session's shell stands in for the agent (its tab is `shell · <session>`, where the story
// shows `claude · <session>`), and Continue here is verified-unreachable · provider login.

/** The row's open button on either manifest. */
const OPEN = /^Mend: Open( in VS Code)?$/;

/** `key before → after` for every counted fact. */
const delta = (before, after) =>
  Object.keys(before)
    .map((key) => `${key} ${before[key]} → ${after[key]}`)
    .join(", ");

const linesMatching = (log, needle) =>
  log.split("\n").filter((line) => line.includes(needle)).length;

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
    quickInput,
    treeItem,
    notifications,
    dialogs,
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
  } = h;
  const project = state.project;
  const stoppedName = "fresh worktree";

  await step("the Mend view lists the project", async () => {
    await useWindow(await homeWindow());
    if (await quickInput.isOpen()) await quickInput.cancel();
    await view("Mend");
    await treeItem(project.name).waitFor();
    await shot("mend-view");
    return `row "${await treeItem(project.name).text()}" · status bar "${await statusBar("Mend:").text()}" · opens ${await opens()} · windows ${(await windows()).length}`;
  });

  const listedBefore = await api(`/projects/${project.id}`);
  const beforeIds = new Set(listedBefore.sessions.map((session) => session.id));
  const windowsBeforeStart = await windows();
  const opensBeforeStart = await opens();

  await step("Mend: New Session… from the palette, Workbench picked", async () => {
    await palette("Mend: New Session…");
    await quickInput.waitFor();
    if ((await quickInput.title()) === "Choose a Mend project") await quickInput.pick(project.name);
    const title = await quickInput.title();
    const kinds = (await quickInput.items()).map((item) => item.split("\n")[0].trim());
    await shot("new-session-kinds");
    await quickInput.pick("Workbench");
    return `quick input "${title}" offered ${kinds.join(" | ")}`;
  });

  const session = await step("the new session's row reads running", async () => {
    const created = await waitUntil(
      "the new session on the server",
      async () =>
        (await api(`/projects/${project.id}`)).sessions.find((item) => !beforeIds.has(item.id)) ??
        null,
      120_000,
    );
    const name = created.label ?? `claude · ${created.id.slice(0, 8)}`;
    const row = treeItem(name);
    await waitUntil(
      "the row to read running",
      async () => ((await row.description()) === "running" ? true : null),
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
      tab: `shell · ${name}`,
      workspaceId: detail.sealantWorkspaceId,
    };
  });
  const banner = `Mend · ${session.name} · closing this tab detaches`;

  await step(
    "the start opens one window on either extension (story a is not built): opens +1, its terminal recorded",
    async () => {
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
      await view("Mend");
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
    await view("Mend");
    return { title, asked, before, after };
  };

  await step("calibration: the row's open button twice with a gap, opens +1 then +2", async () => {
    const first = await openOnce(session.name);
    expect(first.after - first.before === 1, `first open: opens ${first.before} → ${first.after}`);
    const second = await openOnce(session.name);
    expect(second.after - first.before === 2, `two opens: opens ${first.before} → ${second.after}`);
    return `button "${first.title}" · first ${answered(first)}, opens ${first.before} → ${first.after} · second ${answered(second)}, opens ${second.before} → ${second.after}`;
  });

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
  const selectsOnly = async (rowName, gesture, slug) => {
    const row = treeItem(rowName);
    await row.waitFor();
    const known = await windows();
    const before = await counts();
    const watching = await watch();
    await gesture(row);
    await sleep(3_000);
    const leftOpen = (await quickInput.isOpen()) ? await quickInput.title() : null;
    await shot(slug);
    const opened = await newWindows(known, { settle: 10_000, limit: 30_000 });
    const seen = await watching.stop();
    const selected = await row.selected().catch(() => false);
    const after = await counts();
    const observed = `opens ${before.opens} → ${after.opens} · windows opened ${opened.length} · quick input left open ${leftOpen === null ? "none" : `"${leftOpen}"`} · row selected ${selected} · ${shown(seen)} · ${delta(before, after)}`;
    if (leftOpen !== null) await quickInput.cancel();
    const asked =
      seen === null ? [] : [...seen.dialogs, ...seen.quickInputs, ...(leftOpen ? [leftOpen] : [])];
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
    () => selectsOnly(session.name, (row) => row.dblclick(), "after-double-click"),
  );
  await step("click the running session's row once: it selects, nothing opens, nothing asks", () =>
    selectsOnly(session.name, (row) => row.click(), "after-click"),
  );
  await step(
    `double-click the stopped ${stoppedName} row: it selects, nothing opens, nothing resumes`,
    () => selectsOnly(stoppedName, (row) => row.dblclick(), "after-double-click-stopped"),
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
    await view("Mend");
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
      await view("Mend");
      const { title } = await treeItem(session.name).inline(OPEN);
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
      await view("Mend");
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
    await view("Mend");
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
    await view("Mend");
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
      await view("Mend");
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
      await view("Mend");
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
    "window.openFoldersInNewWindow removed from settings.json: VS Code's default again",
    async () => {
      const written = userSettings({ "window.openFoldersInNewWindow": undefined });
      await sleep(2_000);
      return `window.openFoldersInNewWindow: ${JSON.stringify(written["window.openFoldersInNewWindow"] ?? "default (unset)")}`;
    },
    { via: "setup" },
  );

  await step(
    "LAST, the default setting: the open button in the local window turns that window into the workspace",
    async () => {
      const home = await homeWindow();
      await useWindow(home);
      await view("Mend");
      if (await quickInput.isOpen()) await quickInput.cancel();
      const titleBefore = await home.title();
      const before = await counts();
      const watching = await watch();
      const { title } = await treeItem(session.name).inline(OPEN);
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

  await step(
    "the window that became the workspace: the live shell attached as its tab, focused, before any gesture",
    async () => {
      const { tabs, line } = await attachedTab();
      await shot("window-becomes-workspace");
      expect(tabs.focused, `the keyboard is not in the terminal (tabs ${JSON.stringify(tabs)})`);
      return `window title "${await page().title()}" (the story wants "${session.name} — ${project.name}") · tabs ${JSON.stringify(tabs.names)} · active "${tabs.active}" · focused ${tabs.focused} · banner "${line}"`;
    },
  );

  await step("its Explorer shows the worktree's files", async () => {
    await view("Explorer");
    await waitForText("README", { timeout: 120_000 });
    await shot("window-becomes-workspace-explorer");
    const verify = await waitForText("VERIFY.md", { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    return `Explorer shows README · VERIFY.md (written in the Open in New Window lane) ${verify}`;
  });

  await step(
    "what the server observed of the sessions after the opens",
    async () => {
      const read = async (id) => {
        const detail = (await api(`/sessions/${id}`)).session;
        const processes = await api(`/sessions/${id}/processes`);
        return `${id.slice(0, 8)} ${detail.status} ${JSON.stringify(processes.map((process) => [process.kind, process.status]))}`;
      };
      return `workbench ${await read(session.id)} · ${stoppedName} ${await read(state.warmSession)} · ana ${await read(ana.id)}`;
    },
    { via: "api" },
  );
};
