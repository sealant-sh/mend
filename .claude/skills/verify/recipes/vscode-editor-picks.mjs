// An extension the person installs from the Extensions panel in one session of a project, carried
// into the next: in session 1 she installs EditorConfig in the workspace and Mend logs it carried;
// session 2, in a new worktree of the same project, gets it with no dialog, and her local User
// setting `editorconfig.generateAuto: false` applies there; she uninstalls it in session 2, Mend
// logs it no longer carried, and session 3 does not get it.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-editor-picks.mjs --out <dir>
//
// Needs a world from `up --settings-sync` (signed in, workspace SSH set up): with Settings Sync on,
// every install Mend made asked before mend#1156.

const OPEN = /^Mend: Open( in VS Code)?$/;
const ID = "editorconfig.editorconfig";
const SETTING = "editorconfig.generateAuto";
const ROW = `[data-extension-id="${ID}" i]`;
const INSTALL = /^Install(?: in SSH: .+)?$/;
const SYNC_QUESTION_ANSWER = /^Install \(Do not sync\)$/;
// Remote-SSH's host label, or the bare authority before its label formatter registers.
const SSH_INSTALLED = /^(?:SSH: |ssh-remote\+).+ - Installed$/;
const IN_SYNC = /extensions in sync/;
const SETTLE_MS = 180_000;
const LOG_MS = 15_000;
// Scopes VS Code applies from the local User settings in a remote window (none declared is window).
const APPLIED_SCOPES = [null, "window", "resource", "language-overridable"];
// Each prints a `NAME=…;` line the typed command itself does not contain.
const READ_IDS = String.raw`printf '%s=%s;\n' IDS "$(grep -o '"id":"[^"]*"' ~/.vscode-server/extensions/extensions.json | cut -d'"' -f4 | tr '\n' ' ')"`;
const READ_SCOPE = String.raw`p=$(find ~/.vscode-server/extensions -maxdepth 2 -ipath '*editorconfig.editorconfig-*/package.json' | head -1); n=$(find ~/.vscode-server -maxdepth 6 -type f -name node -perm -u+x | head -1); "$n" -e 'const c=[].concat(require(process.argv[1]).contributes.configuration);const s=Object.assign({},...c.map((x)=>x.properties||{}))["editorconfig.generateAuto"]||{};console.log("GA"+"="+JSON.stringify({scope:s.scope??null,default:s.default??null})+";")' "$p"`;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const merged = (...lists) => [...new Set(lists.flat())];

export default async (h) => {
  const {
    page,
    view,
    palette,
    treeItem,
    dialogs,
    dialog,
    notifications,
    windows,
    waitForWindow,
    useWindow,
    homeWindow,
    closeWindow,
    statusBarItems,
    terminal,
    userSettings,
    watch,
    waitUntil,
    shot,
    step,
    api,
    state,
    sleep,
  } = h;
  if (!state.settingsSync)
    throw new Error("this recipe needs a world from up --settings-sync (Settings Sync on)");
  const project = state.project;
  const run = Date.now().toString(36);

  const startSession = (n) =>
    step(
      `session ${n}: a shell session in a fresh worktree of the project runs`,
      async () => {
        const label = `picks-${n}-${run}`;
        const created = await api(`/projects/${project.id}/sessions`, {
          method: "POST",
          body: JSON.stringify({ harness: "shell", label, base: null, name: label }),
        });
        await api(`/sessions/${created.id}/resume`, {
          method: "POST",
          body: JSON.stringify({ harness: "shell" }),
        });
        const read = await waitUntil(
          "the session to run with a workspace",
          async () => {
            const { session: current } = await api(`/sessions/${created.id}`);
            return current.sealantWorkspaceId &&
              ["running", "idle", "waiting"].includes(current.status)
              ? current
              : null;
          },
          300_000,
        );
        return {
          observed: `session ${created.id.slice(0, 8)} "${label}" ${read.status} · workspace ${read.sealantWorkspaceId}`,
          id: created.id,
          label,
        };
      },
      { via: "api" },
    );

  const openFromRow = (n, session) =>
    step(`session ${n}: Open on its row opens its workspace window`, async () => {
      await useWindow(await homeWindow());
      await view("Mend");
      await treeItem(session.label).waitFor(120_000);
      const known = await windows();
      await treeItem(session.label).inline(OPEN);
      const opened = await waitForWindow(known, 180_000);
      await useWindow(opened);
      return {
        observed: `1 window opened for ${session.id.slice(0, 8)} · title ${JSON.stringify(await opened.title())}`,
        opened,
      };
    });

  /**
   * A window that navigates loses its watch, so the samples carry on alone; a dialog ends the wait
   * at once.
   */
  const settleInSync = async (slug) => {
    const startedAt = Date.now();
    const watching = await watch();
    const sampled = { dialogs: [], toasts: [], statusBar: [] };
    const relevant = (texts) => texts.filter((text) => /extension|sync|SSH/i.test(text));
    for (;;) {
      if (Date.now() - startedAt > SETTLE_MS)
        throw new Error(
          `no "extensions in sync" after ${SETTLE_MS / 1000} s · status bar seen ${JSON.stringify(sampled.statusBar)}`,
        );
      const [shown, toasts, status] = await Promise.all([
        dialogs(),
        notifications(),
        statusBarItems(),
      ]).catch(() => [[], [], []]);
      sampled.dialogs = merged(sampled.dialogs, shown);
      sampled.toasts = merged(sampled.toasts, toasts);
      sampled.statusBar = merged(sampled.statusBar, relevant(status));
      if (shown.length > 0) {
        await shot(`${slug}-dialog`);
        throw new Error(`a dialog showed: ${JSON.stringify(shown[0])}`);
      }
      if (status.some((text) => IN_SYNC.test(text))) break;
      await sleep(250);
    }
    const ms = Date.now() - startedAt;
    await shot(`${slug}-in-sync`);
    const watched = await watching.stop();
    const seen = {
      dialogs: merged(watched?.dialogs ?? [], sampled.dialogs),
      toasts: merged(watched?.toasts ?? [], sampled.toasts),
      statusBar: merged(relevant(watched?.statusBar ?? []), sampled.statusBar),
    };
    if (seen.dialogs.length > 0)
      throw new Error(`a dialog showed: ${JSON.stringify(seen.dialogs)}`);
    return { ms, ...seen, navigated: watched === null };
  };

  const searchExtensions = async (query) => {
    await view("Extensions");
    const box = page().locator(
      ".part.sidebar .extensions-search-container .suggest-input-container",
    );
    await box.first().click();
    await page().keyboard.press("Control+A");
    await page().keyboard.press("Backspace");
    if (query !== "") await page().keyboard.type(query);
  };

  const installButton = () =>
    page()
      .locator(`.part.sidebar ${ROW} .action-label`)
      .filter({ hasText: INSTALL, visible: true })
      .first();

  const sshPane = () =>
    page()
      .locator(".part.sidebar .pane")
      .filter({ has: page().locator(".pane-header .title", { hasText: SSH_INSTALLED }) })
      .first();

  const sshInstalled = async () => {
    await searchExtensions("");
    const pane = sshPane();
    await pane.waitFor({ timeout: 60_000 });
    const header = pane.locator(".pane-header").first();
    if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
    let last = null;
    let same = 0;
    return waitUntil(
      "the SSH section's list to hold still",
      async () => {
        const now = await pane.evaluate((root) => ({
          title: (root.querySelector(".pane-header .title")?.textContent ?? "").trim(),
          ids: [...root.querySelectorAll("[data-extension-id]")].map((row) =>
            (row.getAttribute("data-extension-id") ?? "").toLowerCase(),
          ),
          names: [...root.querySelectorAll(".extension-list-item .name")].map((name) =>
            (name.textContent ?? "").trim(),
          ),
        }));
        const key = JSON.stringify(now);
        same = key === last ? same + 1 : 0;
        last = key;
        return same >= 8 ? now : null;
      },
      60_000,
    );
  };

  const logText = () =>
    page().evaluate(() =>
      [...document.querySelectorAll(".output-view .view-lines .view-line")]
        .map((line) => ({ top: Number.parseFloat(line.style.top) || 0, text: line.textContent }))
        .sort((a, b) => a.top - b.top)
        .map((line) => line.text ?? "")
        .join("")
        .replace(/\u00a0/g, " "),
    );

  const waitForLog = async (phrase, since, deadline) => {
    const pattern = new RegExp(
      `(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)\\s*${escapeRegExp(ID)}:\\s*${phrase.split(" ").map(escapeRegExp).join("\\s*")}`,
      "gi",
    );
    let last = "";
    try {
      return await waitUntil(
        `the log to say "${ID}: ${phrase}"`,
        async () => {
          last = await logText();
          for (const match of last.matchAll(pattern)) {
            const at = Date.parse(match[1]);
            if (at >= since - 1_000) return { at, seenAt: Date.now(), line: match[0] };
          }
          return null;
        },
        Math.max(deadline - Date.now(), 1_000),
      );
    } catch (cause) {
      throw new Error(`${cause.message} · the log's end reads ${JSON.stringify(last.slice(-400))}`);
    }
  };

  const readWorkspace = async (commands, names) => {
    const before = (await terminal().tabs()).names.length;
    await palette("Terminal: Create New Terminal");
    await waitUntil(
      "a new terminal tab",
      async () => (await terminal().tabs()).names.length > before,
      60_000,
    );
    await terminal().waitFor(60_000);
    await terminal().type(commands.join("; "));
    return waitUntil(
      `the terminal to print ${names.join(" and ")}`,
      async () => {
        const rows = (await terminal().read()).join("");
        const found = names.map((name) => new RegExp(`${name}=([^;]*);`).exec(rows)?.[1]);
        return found.every((value) => value !== undefined)
          ? Object.fromEntries(names.map((name, index) => [name, found[index].trim()]))
          : null;
      },
      60_000,
    );
  };

  const settingsUi = async () => {
    await palette("Preferences: Open Settings (UI)");
    const box = page().locator(".settings-editor .search-container .suggest-input-container");
    await box.first().waitFor({ timeout: 30_000 });
    await box.first().click();
    await page().keyboard.press("Control+A");
    await page().keyboard.type(SETTING);
    const item = page().locator(`.settings-editor [data-key="${SETTING}"]`).first();
    await item.waitFor({ timeout: 30_000 });
    return {
      checked: await item.locator(".setting-value-checkbox").first().getAttribute("aria-checked"),
      text: (await item.innerText()).replace(/\s+/g, " ").trim(),
    };
  };

  await step(
    `window.openFoldersInNewWindow on, and ${SETTING} false in the local User settings`,
    async () => {
      const written = userSettings({ "window.openFoldersInNewWindow": "on", [SETTING]: false });
      return `window.openFoldersInNewWindow: ${JSON.stringify(written["window.openFoldersInNewWindow"])} · ${SETTING}: ${JSON.stringify(written[SETTING])}`;
    },
    { via: "setup" },
  );

  const first = await startSession(1);
  const firstWindow = await openFromRow(1, first);

  await step(
    "session 1: the window settles `extensions in sync` before anything is installed",
    async () => {
      const settled = await settleInSync("session-1");
      return {
        observed: `in sync after ${settled.ms} ms · ${settled.dialogs.length} dialog(s) · status bar ${JSON.stringify(settled.statusBar)} · toasts ${JSON.stringify(settled.toasts)}`,
        ...settled,
      };
    },
  );

  const installed = await step(
    `session 1: Install on ${ID} in the Extensions view installs it in the workspace`,
    async () => {
      await searchExtensions(ID);
      await installButton().waitFor({ timeout: 60_000 });
      const label = ((await installButton().textContent()) ?? "").trim();
      await shot("session-1-search");
      await installButton().click();
      const clickedAt = Date.now();
      let question = null;
      let trust = null;
      let answeredAt = 0;
      const manage = page()
        .locator(`.part.sidebar ${ROW} .action-label.manage`)
        .filter({ visible: true });
      for (;;) {
        if (Date.now() - clickedAt > 120_000)
          throw new Error(`${ID} was not installed 120 s after the click`);
        const shown = await dialogs();
        if (shown.length > 0) {
          // The answered question can still be on screen for a moment.
          if (Date.now() - answeredAt < 2_000) {
            await sleep(250);
            continue;
          }
          // VS Code asks once per publisher before a person's first install from it.
          if (trust === null && /trust the publisher/i.test(shown[0])) {
            trust = shown[0];
            await shot("session-1-trust-publisher");
            await dialog(/trust the publisher/i).click(/^Trust Publisher & Install$/);
            answeredAt = Date.now();
            continue;
          }
          if (question !== null || !/install and synchronize/i.test(shown[0])) {
            await shot("session-1-unexpected-dialog");
            throw new Error(
              `a dialog showed${question === null ? "" : " after the Settings Sync question"}: ${JSON.stringify(shown[0])}`,
            );
          }
          question = shown[0];
          await shot("session-1-sync-question");
          await dialog(/install and synchronize/i).click(SYNC_QUESTION_ANSWER);
          answeredAt = Date.now();
          continue;
        }
        if ((await manage.count()) > 0 && (await installButton().count()) === 0) break;
        await sleep(250);
      }
      const doneAt = Date.now();
      await shot("session-1-installed");
      return {
        observed: `clicked "${label}" · VS Code's publisher trust question ${trust === null ? "did not show" : 'showed once, answered "Trust Publisher & Install"'} · VS Code's Settings Sync question ${question === null ? "did not show" : `showed once: "${question}", answered "Install (Do not sync)"`} · installed ${doneAt - clickedAt} ms after the click`,
        clickedAt,
        doneAt,
        question,
      };
    },
  );

  await step(
    `session 1: Mend's log says "${ID}: carried to later sessions of this project"`,
    async () => {
      await palette("Mend: Show workspace editor log");
      const found = await waitForLog(
        "carried to later sessions of this project",
        installed.clickedAt,
        installed.doneAt + LOG_MS,
      );
      await shot("session-1-carried");
      return `"${found.line}" · stamped ${found.at - installed.clickedAt} ms after the click, ${found.at - installed.doneAt} ms after the install finished · seen ${found.seenAt - installed.clickedAt} ms after the click`;
    },
  );

  await step("session 1: its window closes", async () => closeWindow(firstWindow.opened));

  const second = await startSession(2);
  const secondWindow = await openFromRow(2, second);

  await step(
    "session 2: from its open until `extensions in sync`, no dialog; the toasts and statuses it showed",
    async () => {
      const settled = await settleInSync("session-2");
      return {
        observed: `in sync ${settled.ms} ms after the window appeared · ${settled.dialogs.length} dialog(s) · ${settled.toasts.length} toast(s) ${JSON.stringify(settled.toasts)} · status bar ${JSON.stringify(settled.statusBar)}${settled.navigated ? " · the window navigated, so these are the samples alone" : ""}`,
        ...settled,
      };
    },
  );

  await step(
    `session 2: the Extensions view lists ${ID} as installed in the SSH section`,
    async () => {
      const section = await sshInstalled();
      await shot("session-2-ssh-installed");
      if (!section.ids.includes(ID))
        throw new Error(`"${section.title}" lists ${JSON.stringify(section.ids)}, not ${ID}`);
      return `"${section.title}" lists ${section.ids.length} extension(s) ${JSON.stringify(section.names)} · ${ID} among them`;
    },
  );

  await step(
    `session 2: the workspace's extensions.json lists ${ID}, and the installed manifest declares ${SETTING}`,
    async () => {
      const read = await readWorkspace([READ_IDS, READ_SCOPE], ["IDS", "GA"]);
      await shot("session-2-terminal");
      const ids = read.IDS.split(" ").filter(Boolean);
      const declared = JSON.parse(read.GA);
      if (!ids.some((id) => id.toLowerCase() === ID))
        throw new Error(`extensions.json lists ${JSON.stringify(ids)}, not ${ID}`);
      if (!APPLIED_SCOPES.includes(declared.scope))
        throw new Error(
          `${SETTING} declares scope ${declared.scope}: a remote window does not apply it`,
        );
      if (declared.default !== true)
        throw new Error(
          `${SETTING} defaults to ${JSON.stringify(declared.default)}, so false proves nothing`,
        );
      return `extensions.json (read with grep in a new terminal) lists ${ids.length} id(s) ${JSON.stringify(ids)} · ${SETTING} declares scope ${declared.scope ?? "none (window)"}, default ${declared.default}`;
    },
  );

  await step(`session 2: the Settings editor shows ${SETTING} unchecked`, async () => {
    const shown = await settingsUi();
    await shot("session-2-settings-ui");
    if (shown.checked !== "false")
      throw new Error(`the checkbox reads aria-checked ${shown.checked} · row "${shown.text}"`);
    return `aria-checked "${shown.checked}" · row "${shown.text}"`;
  });

  await step(
    `session 2: Uninstall on ${ID} in the Extensions view, then Mend's log says "no longer carried"`,
    async () => {
      // VS Code 1.142 opens the Settings editor as a modal over the Extensions view.
      await page().keyboard.press("Escape");
      await sleep(500);
      await palette("Mend: Show workspace editor log");
      await sshInstalled();
      const row = sshPane().locator(ROW).first();
      await row.hover();
      await row.locator(".action-label.manage").first().click();
      const item = page()
        .locator(".context-view .monaco-menu .action-item:not(.disabled) .action-label", {
          hasText: /^Uninstall$/,
        })
        .first();
      await item.waitFor({ timeout: 30_000 });
      // VS Code's menu ignores a click that lands right after it opens.
      await item.hover();
      await sleep(300);
      await item.click();
      const clickedAt = Date.now();
      const found = await waitForLog("no longer carried", clickedAt, clickedAt + LOG_MS);
      const shown = await dialogs();
      await shot("session-2-no-longer-carried");
      if (shown.length > 0) throw new Error(`a dialog showed: ${JSON.stringify(shown[0])}`);
      return `"${found.line}" · stamped ${found.at - clickedAt} ms after the click · seen ${found.seenAt - clickedAt} ms after · 0 dialogs`;
    },
  );

  await step("session 2: its window closes", async () => closeWindow(secondWindow.opened));

  const third = await startSession(3);
  await openFromRow(3, third);

  await step(
    "session 3: the window settles `extensions in sync` with nothing installed",
    async () => {
      const settled = await settleInSync("session-3");
      const installing = settled.statusBar.filter((text) => /installing extensions/i.test(text));
      if (installing.length > 0)
        throw new Error(`the status bar showed ${JSON.stringify(installing)}`);
      return {
        observed: `in sync after ${settled.ms} ms · ${settled.dialogs.length} dialog(s) · 0 "installing extensions" · status bar ${JSON.stringify(settled.statusBar)} · toasts ${JSON.stringify(settled.toasts)}`,
        ...settled,
      };
    },
  );

  await step(`session 3: the Extensions view's SSH section does not list ${ID}`, async () => {
    const section = await sshInstalled();
    await shot("session-3-ssh-installed");
    if (section.ids.includes(ID)) throw new Error(`"${section.title}" lists ${ID}`);
    return `"${section.title}" lists ${section.ids.length} extension(s) ${JSON.stringify(section.names)} · 0 ${ID}`;
  });
};
