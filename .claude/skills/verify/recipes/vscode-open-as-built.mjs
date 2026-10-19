// Today's extension, as built: a session started the way the extension starts one (the palette's
// `Mend: New Session…`, Workbench), then the open bug as a person meets it (a double-click on the
// session row: what it shows, and whether an open runs, counted by `opens`), then one clean open
// driven through to the workspace window: the worktree's files in the Explorer, a command in the
// window's integrated terminal.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-open-as-built.mjs --out <dir>
//
// Needs a world from `up` that is signed in with workspace SSH set up (the default).

/**
 * The server's log lines holding `needle`: context beside `opens`, never the count a claim rests
 * on. A window's SSH teardown also resolves `/v1/workspaces/<id>/ssh-target`, seconds after the
 * close, and the `/v1/workspaces/<id>` reads land in the log seconds after the extension asks.
 */
const linesMatching = (log, needle) =>
  log.split("\n").filter((line) => line.includes(needle)).length;

/** `key before → after` for every counted fact. */
const delta = (before, after) =>
  Object.keys(before)
    .map((key) => `${key} ${before[key]} → ${after[key]}`)
    .join(", ");

export default async (h) => {
  const {
    view,
    palette,
    quickInput,
    treeItem,
    notification,
    notifications,
    dialogs,
    windows,
    newWindows,
    useWindow,
    homeWindow,
    closeWindow,
    statusBar,
    terminal,
    waitForText,
    waitUntil,
    shot,
    step,
    api,
    state,
    serverLogs,
    opens,
    remoteSshLogs,
    sleep,
  } = h;
  const project = state.project;

  await step("the Mend view lists the project", async () => {
    await useWindow(await homeWindow());
    if (await quickInput.isOpen()) await quickInput.cancel();
    await view("Mend");
    await treeItem(project.name).waitFor();
    await shot("mend-view");
    return `row "${await treeItem(project.name).text()}" · status bar "${await statusBar("Mend:").text()}"`;
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
    const kinds = (await quickInput.items()).map((item) => item.split("\n")[0]);
    await shot("new-session-kinds");
    await quickInput.pick("Workbench");
    const toast = notification("Preparing workbench");
    const shown = await toast
      .waitFor(15_000)
      .then(() => toast.text())
      .catch(() => "no toast seen within 15 s");
    await shot("preparing-workbench");
    return { observed: `quick input "${title}" offered ${kinds.join(" | ")} · toast: ${shown}` };
  });

  const session = await step("the new session's row reads running", async () => {
    const created = await waitUntil(
      "the new session on the server",
      async () =>
        (await api(`/projects/${project.id}`)).sessions.find((item) => !beforeIds.has(item.id)) ??
        null,
      120_000,
    );
    const label = created.label ?? `claude · ${created.id.slice(0, 8)}`;
    const row = treeItem(label);
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
      label,
      workspaceId: detail.sealantWorkspaceId,
    };
  });

  await step(
    "the start itself opens the workspace (today's extension opens right after Preparing workbench)",
    async () => {
      const opened = await newWindows(windowsBeforeStart, { settle: 10_000, limit: 90_000 });
      await shot("after-start");
      return {
        observed: `${opened.length} window(s) opened by the start · toasts ${JSON.stringify(await notifications())} · dialogs ${JSON.stringify(await dialogs())}`,
        count: opened.length,
      };
    },
  );
  const startWindows = await newWindows(windowsBeforeStart, { settle: 1_000, limit: 2_000 });

  let calibrated = false;
  if (startWindows.length > 0) {
    await step(
      "the start's window connects over Remote-SSH (the first connect of this workspace), opens +1 per window",
      async () => {
        await useWindow(startWindows[0]);
        await statusBar(/SSH:/).waitFor(600_000);
        await waitForText("README", { timeout: 120_000 });
        await shot("start-window-connected");
        const after = await opens();
        if (after - opensBeforeStart !== startWindows.length)
          throw new Error(
            `opens ${opensBeforeStart} → ${after} for ${startWindows.length} window(s): the signal does not count one per open`,
          );
        calibrated = true;
        return `status bar "${await statusBar(/SSH:/).text()}" · the Explorer shows README · ${startWindows.length} window(s), opens ${opensBeforeStart} → ${after}`;
      },
    );
    await step("the start's window(s) closed, back to the local window", async () => {
      const results = [];
      for (const window of startWindows) results.push(await closeWindow(window));
      await useWindow(await homeWindow());
      await view("Mend");
      return results.join(" · ");
    });
  }

  /** Read before and after a gesture: `opens`, which claims rest on, then the rest as context. */
  const counts = async () => {
    const log = await serverLogs();
    return {
      opens: await opens(),
      remoteSshLogs: remoteSshLogs(),
      sshTargetLookups: linesMatching(log, `/v1/workspaces/${session.workspaceId}/ssh-target`),
      workspaceReads: linesMatching(log, `/v1/workspaces/${session.workspaceId}'`),
      processes: (await api(`/sessions/${session.id}/processes`)).length,
      sessions: (await api(`/projects/${project.id}`)).sessions.length,
    };
  };

  const doubleClick = await step(
    "double-click the session row: what it shows, and whether an open runs (opens)",
    async () => {
      const row = treeItem(session.label);
      await row.waitFor();
      const known = await windows();
      const before = await counts();
      const watch = await quickInput.watch();
      await row.dblclick();
      await sleep(3_000);
      const dialogsSeen = await dialogs();
      const quickInputOpen = await quickInput.isOpen();
      const quickInputTitle = quickInputOpen ? await quickInput.title() : null;
      const quickInputItems = quickInputOpen
        ? (await quickInput.items()).map((item) => item.split("\n")[0])
        : [];
      const toasts = await notifications();
      await shot("right-after-double-click");
      const opened = await newWindows(known, { settle: 10_000, limit: 60_000 });
      const shown = await watch.stop();
      await shot("after-double-click");
      const after = await counts();
      return {
        observed:
          `opens ${before.opens} → ${after.opens} · windows opened before any answer: ${opened.length} · modal dialogs: ${dialogsSeen.length} · toasts: ${toasts.length}` +
          ` · quick input shown ${shown.length} time(s) (${shown.map((event) => `"${event.title}"`).join(", ")}), ${quickInputOpen ? `left open as "${quickInputTitle}" offering ${quickInputItems.join(" | ")}` : "none left open"}` +
          ` · ${delta(before, after)}`,
        windows: opened.length,
        dialogs: dialogsSeen,
        quickInputShown: shown,
        quickInputLeft: quickInputTitle,
        toasts,
        before,
        after,
      };
    },
  );

  await step(
    "the double-click's question answered once, Open alongside, as a person would",
    async () => {
      const known = await windows();
      const before = await counts();
      if (doubleClick.quickInputLeft === null) return "no quick input was left to answer";
      await quickInput.pick("Open alongside");
      const opened = await newWindows(known, { settle: 10_000, limit: 60_000 });
      const dialogsSeen = await dialogs();
      const quickInputOpen = await quickInput.isOpen();
      if (opened.length > 0) await useWindow(opened[0]);
      await shot("after-open-alongside");
      const after = await counts();
      return {
        observed: `opens ${before.opens} → ${after.opens} · windows opened: ${opened.length} · dialogs ${JSON.stringify(dialogsSeen)} · quick input ${quickInputOpen ? "still open" : "closed"} · ${delta(before, after)}`,
        windows: opened.length,
        titles: await Promise.all(opened.map((page) => page.title().catch(() => ""))),
      };
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

  const clean = await step(
    "one clean open: the row's inline Mend: Open in VS Code, then Open alongside",
    async () => {
      const known = await windows();
      const before = await opens();
      await treeItem(session.label).inline("Mend: Open in VS Code");
      await quickInput.waitFor(15_000);
      const asked = await quickInput.title();
      await shot("open-asks");
      await quickInput.pick("Open alongside");
      const opened = await newWindows(known, { settle: 10_000, limit: 90_000 });
      const dialogsSeen = await dialogs();
      if (opened.length > 0) await useWindow(opened[0]);
      await shot("after-open");
      return {
        observed: `asked "${asked}" · Open alongside picked · ${opened.length} window(s) opened · dialogs ${JSON.stringify(dialogsSeen)}`,
        pages: opened,
        opensBefore: before,
      };
    },
  );
  if (clean.pages.length === 0) throw new Error("the open opened no window");

  await step(
    "the workspace window: Remote-SSH connected, the worktree's files in the Explorer",
    async () => {
      await useWindow(clean.pages[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      await shot("workspace-explorer");
      const after = await opens();
      if (!calibrated && after - clean.opensBefore !== clean.pages.length)
        throw new Error(
          `opens ${clean.opensBefore} → ${after} for ${clean.pages.length} window(s): the signal does not count one per open`,
        );
      return `title "${await clean.pages[0].title()}" · status bar "${await statusBar(/SSH:/).text()}" · Explorer shows README · opens ${clean.opensBefore} → ${after} for ${clean.pages.length} window(s)`;
    },
  );

  await step("a terminal in the workspace window runs in the workspace", async () => {
    await palette("Terminal: Create New Terminal");
    await terminal().waitFor(60_000);
    await terminal().type("echo who-$(id -un) in $(pwd); ls");
    const rows = await terminal().waitForText(/who-\S+ in \/workspace\/repo/, 60_000);
    await shot("workspace-terminal");
    const line = rows.split("\n").find((row) => /who-\S+ in \//.test(row)) ?? "";
    return `terminal: "${line.trim()}" · README listed: ${rows.includes("README")}`;
  });

  await step(
    "what the server observed of the session after the opens",
    async () => {
      const detail = (await api(`/sessions/${session.id}`)).session;
      const processes = await api(`/sessions/${session.id}/processes`);
      return `session ${session.id.slice(0, 8)} · ${detail.status} · processes ${JSON.stringify(processes.map((process) => [process.kind, process.status]))}`;
    },
    { via: "api" },
  );
};
