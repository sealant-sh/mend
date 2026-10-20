// Story c's first open on a machine without Microsoft Remote-SSH: one gesture on a stopped session
// installs Remote-SSH, resumes the workspace and opens it, each a step of the open's progress in the
// status bar, with no question on the way.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-open-first.mjs --out <dir>
//
// Needs a world from `up --no-remote-ssh` (signed in, workspace SSH set up, Remote-SSH absent).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The extension host's log lines that name Remote-SSH or an install, for a failed install's report. */
const installLogLines = (userData) => {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "exthost.log" || name === "sharedprocess.log" || name === "main.log")
        found.push(
          ...readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => /remote-ssh|installExtension|install/i.test(line)),
        );
    }
  };
  const root = join(userData, "logs");
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return found.slice(-12);
};

export default async (h) => {
  const {
    view,
    treeItem,
    quickInput,
    notifications,
    windows,
    newWindows,
    useWindow,
    homeWindow,
    statusBar,
    watch,
    waitForText,
    waitUntil,
    shot,
    step,
    api,
    state,
    opens,
  } = h;
  const project = state.project;
  const stoppedName = "fresh worktree";

  await step(
    "the world has no Remote-SSH",
    async () => {
      if (state.remoteSsh !== false)
        throw new Error("this world has Remote-SSH: up --no-remote-ssh");
      const { session } = await api(`/sessions/${state.warmSession}`);
      return `state.remoteSsh ${state.remoteSsh} · ${stoppedName} ${session.status}`;
    },
    { via: "setup" },
  );

  await step("the Mend view lists the project and the stopped session", async () => {
    await useWindow(await homeWindow());
    if (await quickInput.isOpen()) await quickInput.cancel();
    await view("Mend");
    await treeItem(stoppedName).waitFor();
    await shot("mend-view");
    return `row "${await treeItem(project.name).text()}" · row "${await treeItem(stoppedName).text()}" · opens ${await opens()}`;
  });

  await step(
    "Mend: Open in New Window from the stopped session's context menu (it has no inline button; the inline one is Open): Remote-SSH installs, the workspace starts, one window opens, nothing asks",
    async () => {
      const known = await windows();
      const opensBefore = await opens();
      const watching = await watch();
      await treeItem(stoppedName).contextMenu("Mend: Open in New Window");
      const installing = statusBar("installing Remote-SSH");
      const sawInstalling = await installing
        .waitFor(30_000)
        .then(() => installing.text())
        .catch(() => null);
      if (sawInstalling !== null) await shot("installing-remote-ssh");
      const starting = statusBar(`starting ${stoppedName}'s workspace`);
      let sawStarting = null;
      const outcome = await waitUntil(
        "the workspace window, or an error toast",
        async () => {
          const fresh = (await windows()).filter(
            (window) => !known.some((seen) => seen.page === window.page),
          );
          if (fresh.length > 0) return { opened: fresh.length };
          const toasts = await notifications();
          const failed = toasts.find((toast) => /did not|could not|failed|error/i.test(toast));
          if (failed !== undefined) return { failed };
          if (sawStarting === null) sawStarting = await starting.text().catch(() => null);
          return null;
        },
        600_000,
      );
      if (outcome.failed !== undefined) {
        const seen = await watching.stop();
        await shot("install-failed");
        throw new Error(
          `the open failed: toast "${outcome.failed}" · status bar ${JSON.stringify(seen?.statusBar ?? [])} · log ${JSON.stringify(installLogLines(state.userData))}`,
        );
      }
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      const seen = await watching.stop();
      if (opened.length !== 1) throw new Error(`${opened.length} window(s) opened`);
      if (seen.dialogs.length > 0 || seen.quickInputs.length > 0)
        throw new Error(
          `something asked: dialogs ${JSON.stringify(seen.dialogs)} · quick inputs ${JSON.stringify(seen.quickInputs)}`,
        );
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      const opensAfter = await opens();
      await shot("first-open-window");
      if (opensAfter - opensBefore !== 1)
        throw new Error(`opens ${opensBefore} → ${opensAfter} for one window`);
      const progress = seen.statusBar.filter((text) => /installing|starting|opening/.test(text));
      return `installing ${sawInstalling === null ? "not caught" : `"${sawInstalling}"`} · starting ${sawStarting === null ? "not caught" : `"${sawStarting}"`} · progress ${JSON.stringify(progress)} · windows opened ${opened.length} · opens ${opensBefore} → ${opensAfter} · toasts ${JSON.stringify(seen.toasts)} · dialogs ${seen.dialogs.length} · quick inputs ${seen.quickInputs.length} · title "${await opened[0].title()}" · status bar "${await statusBar(/SSH:/).text()}" · Explorer shows README`;
    },
  );

  await step(
    "what the server observed of the session after the open",
    async () => {
      const { session } = await api(`/sessions/${state.warmSession}`);
      const processes = await api(`/sessions/${state.warmSession}/processes`);
      return `${stoppedName} ${session.status} · processes ${JSON.stringify(processes.map((process) => [process.kind, process.status]))}`;
    },
    { via: "api" },
  );
};
