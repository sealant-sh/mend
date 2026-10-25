// What a Mend workspace window asks while Mend brings the editor into it: a live shell session
// started over the API, opened from its row, then every modal dialog the workspace window shows
// counted until none has shown for 20 s. Each dialog is answered with the button named by
// MEND_VERIFY_DIALOG_ANSWER (default `Install (Do not sync)`), so the next install can ask too.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run .claude/skills/verify/recipes/vscode-editor-dialogs.mjs --out <dir>
//
// Needs a world from `up --settings-sync --local-extensions <ids>` (signed in, workspace SSH set
// up).

const OPEN = /^Mend: Open( in VS Code)?$/;
const QUIET_MS = 20_000;
const MAX_DIALOGS = 80;

export default async (h) => {
  const {
    view,
    treeItem,
    dialogs,
    dialog,
    windows,
    newWindows,
    useWindow,
    homeWindow,
    statusBar,
    userSettings,
    watch,
    waitUntil,
    shot,
    step,
    api,
    state,
    sleep,
  } = h;
  if (!state.settingsSync || (state.localExtensions ?? []).length === 0)
    throw new Error("this recipe needs a world from up --settings-sync --local-extensions <ids>");
  const project = state.project;
  const label = `dialogs-${Date.now().toString(36)}`;
  const answer = process.env.MEND_VERIFY_DIALOG_ANSWER ?? "Install (Do not sync)";

  await step(
    "window.openFoldersInNewWindow on, so the open keeps the local window",
    async () => {
      const written = userSettings({ "window.openFoldersInNewWindow": "on" });
      return `window.openFoldersInNewWindow: ${JSON.stringify(written["window.openFoldersInNewWindow"])}`;
    },
    { via: "setup" },
  );

  const session = await step(
    "a shell session in a fresh worktree of the project runs",
    async () => {
      const created = await api(`/projects/${project.id}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          harness: "shell",
          label,
          base: null,
          name: label,
        }),
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
        observed: `session ${created.id.slice(0, 8)} ${read.status} · workspace ${read.sealantWorkspaceId}`,
        id: created.id,
      };
    },
    { via: "api" },
  );

  const workspaceWindow = await step("Open on the session's row opens its workspace", async () => {
    await useWindow(await homeWindow());
    await view("Mend");
    await treeItem(label).waitFor(120_000);
    const known = await windows();
    await treeItem(label).inline(OPEN);
    const [opened] = await newWindows(known, {
      settle: 10_000,
      limit: 180_000,
    });
    if (opened === undefined) throw new Error("no window opened");
    await useWindow(opened);
    await statusBar(/SSH:/).waitFor(600_000);
    await shot("workspace-connected");
    return {
      observed: `workspace window connected for ${session.id.slice(0, 8)}`,
      opened,
    };
  });

  await step(
    `every dialog the workspace window shows, each answered "${answer}", until none for ${QUIET_MS / 1000} s`,
    async () => {
      await useWindow(workspaceWindow.opened);
      const watching = await watch();
      const seen = [];
      const startedAt = Date.now();
      let lastAt = Date.now();
      while (Date.now() - lastAt < QUIET_MS && seen.length < MAX_DIALOGS) {
        const shown = await dialogs();
        if (shown.length === 0) {
          await sleep(500);
          continue;
        }
        const text = shown[0];
        seen.push({ atMs: Date.now() - startedAt, text });
        if (seen.length === 1) await shot("first-dialog");
        await dialog(/\S/).click(new RegExp(answer.replace(/[()]/g, "\\$&")));
        lastAt = Date.now();
        await sleep(300);
      }
      await shot("after-dialogs");
      const shown = await watching.stop();
      const asking = seen.filter(({ text }) => /install and synchronize/i.test(text));
      return {
        observed: `${seen.length} dialog(s) · ${asking.length} "install and synchronize" · at ms ${seen.map(({ atMs }) => atMs).join(", ")} · texts ${JSON.stringify([...new Set(seen.map(({ text }) => text))])} · toasts ${JSON.stringify(shown?.toasts ?? "window navigated")} · status bar ${JSON.stringify(shown?.statusBar.filter((text) => /extension|sync/i.test(text)) ?? [])}`,
        count: seen.length,
        asking: asking.length,
      };
    },
  );
};
