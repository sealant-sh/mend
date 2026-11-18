// A session's actions, stopping and resuming (apps/web, route PR 13, SLNT-1145, ADR 0026): a
// session tab's right-click menu and its tile's "…", the workspace "…", Rename by F2, the Stop
// session dialog when another session keeps the workspace running and when the workspace stops
// too, the stop, the stopped session's banner and line, Resume session, the phone's "…" sheet, and
// the dialog when Mend can't read what else runs. The sessions are `mend run` commands, so the
// stopped one resumes as a shell; an agent's Resume session needs a real agent (the box). Run the CLI batch first, once per stack: it
// starts two sessions in the worktree `actions-ws` and one alone in `actions-solo`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-session-actions-sessions.json
//   pnpm verify drive new-web --recipe new-web-session-actions
//
// A local stack runs no agent: the sessions are `mend run … -- sleep`, so the dialog has no turn to
// stop and no Services to name. The failed preview is forced by answering its read with a 500, and
// that capture is named `fixture-…`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const TITLE_A = "Fix flaky checkout retry";
const TITLE_B = "Write tests for retry";
const TITLE_C = "Add idempotency keys to refunds";
const RENAMED = "Fix the checkout retry";

export default async ({ page, web, capture: captureOnce, note }) => {
  // The driver withholds a picture when the page inserts a subtree while it looks: look again.
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(400);
    }
  };
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const tabOf = (key) =>
    page.locator(`[data-tab="${key}"]`).filter({ visible: true }).getByRole("tab");
  const tileOf = (key) =>
    page.locator("[data-tile]").filter({ has: page.locator(`[data-tab="${key}"]`) });
  const menu = () => page.getByRole("menu").filter({ visible: true }).last();
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("menu").filter({ visible: true }).first().waitFor({ state: "hidden" });
  };
  const menuWords = async () =>
    (await menu().locator('[role="menuitem"], [role="group"] > div').allInnerTexts())
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter((text) => text !== "");
  const stopDialog = () => page.getByRole("dialog", { name: "Stop session?" });
  const toastSaying = (words) =>
    page.getByRole("region", { name: /Notifications/ }).getByText(words, { exact: false });

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The batch's sessions: the two in actions-ws (older first) and the one in actions-solo.
  const readRows = async () => {
    const read = await page.evaluate(async () => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
      return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
        .data;
    });
    if (!Array.isArray(read)) throw new Error("the page holds no inbox read");
    return read;
  };
  // A drive that failed part way leaves sessions stopped: bring them back as shells first.
  const stopped = (await readRows()).filter(
    (row) =>
      ["actions-ws", "actions-solo"].includes(row.worktreeName) && row.session.status === "stopped",
  );
  for (const row of stopped)
    await client(async (trpc, id) => {
      await trpc.sessions.resume
        .mutate({ id, request: { harness: "shell" } })
        .catch(() => undefined);
    }, row.session.id);
  if (stopped.length > 0) {
    note(`resumed ${stopped.length} session(s) an earlier drive left stopped`);
    await page.waitForTimeout(5_000);
  }
  const rows = await readRows();
  const live = (worktree) =>
    rows
      .filter(
        (row) =>
          row.worktreeName === worktree &&
          !["completed", "stopped", "failed"].includes(row.session.status),
      )
      .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)));
  const shared = live("actions-ws");
  const alone = live("actions-solo");
  if (shared.length < 2 || alone.length < 1)
    throw new Error("actions-ws needs two running sessions and actions-solo one: run the batch");
  const [A, B, C] = [shared[0].session.id, shared[1].session.id, alone[0].session.id];
  const [tabA, tabB, tabC] = [`session:${A}`, `session:${B}`, `session:${C}`];
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [A, TITLE_A],
      [B, TITLE_B],
      [C, TITLE_C],
    ],
  );
  await page.context().clearCookies({ name: "mend-tiles" });

  // T25: the session tab's right-click menu.
  await open(`/sessions/${A}`);
  await tabOf(tabB).waitFor();
  await tabOf(tabA).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Stop session…" }).waitFor();
  const tabMenu = await menuWords();
  for (const item of [
    "Rename…",
    "Snooze",
    "Mark done",
    "Copy link",
    "Split right",
    "Split down",
    "Close tab",
    "Stop session…",
  ])
    if (!tabMenu.some((text) => text.startsWith(item)))
      throw new Error(`the tab's menu has no ${item}: ${tabMenu.join(" | ")}`);
  if (tabMenu.some((text) => /Copy branch name|Land/.test(text)))
    throw new Error("the tab's menu holds a workspace action");
  note(`tab menu: ${tabMenu.join(" | ")}`);
  await both("tab-menu");
  await closeMenu();

  // T26: the conversation tile's "…": the same session actions, Maximise tile instead of splits.
  await tileOf(tabA)
    .getByRole("button", { name: `Actions for ${TITLE_A}` })
    .click();
  await menu().getByRole("menuitem", { name: "Stop session…" }).waitFor();
  const tileMenu = await menuWords();
  if (!tileMenu.some((text) => text.startsWith("Close tab")))
    throw new Error(`the tile's menu reads ${tileMenu.join(" | ")}`);
  note(`tile menu: ${tileMenu.join(" | ")}`);
  await both("tile-menu");
  await closeMenu();

  // T21: the workspace "…": workspace actions only.
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await menu().getByRole("menuitem", { name: "Copy branch name" }).waitFor();
  const workspaceMenu = await menuWords();
  if (workspaceMenu.some((text) => /Stop session|Rename|Snooze/.test(text)))
    throw new Error(`the workspace menu holds a session action: ${workspaceMenu.join(" | ")}`);
  note(`workspace menu: ${workspaceMenu.join(" | ")}`);
  await both("workspace-menu");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await menu().getByRole("menuitem", { name: "Copy branch name" }).click();
  await toastSaying("Copied the branch name.").waitFor();
  note(
    `Copy branch name: the toast said so; the clipboard holds ${await page.evaluate(() => navigator.clipboard.readText())}`,
  );

  // Workspace "…" → New session in this workspace opens a New session tab beside A's.
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await menu().getByRole("menuitem", { name: "New session in this workspace" }).click();
  await page.getByRole("heading", { name: "New session", level: 2 }).waitFor();
  const withNew = await page
    .locator("[data-tile] [data-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab));
  if (!withNew[1]?.startsWith("new:")) throw new Error(`the tabs read ${withNew.join(", ")}`);
  await tabOf(withNew[1]).focus();
  await page.keyboard.press("Delete");
  note("New session in this workspace: a New session tab opened beside the active tab");

  // Rename by F2 on the tab: the dialog, the tab's new name, then the old one back.
  await tabOf(tabA).focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("dialog", { name: "Rename session" });
  await rename.waitFor();
  await rename.getByRole("textbox", { name: "Session name" }).fill(RENAMED);
  await both("rename-dialog");
  await rename.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("tab", { name: new RegExp(`^${RENAMED}`) })
    .first()
    .waitFor();
  note(`F2 → Rename session → Save: the tab reads ${RENAMED}`);
  await client(
    async (trpc, [id, label]) => trpc.sessions.setLabel.mutate({ id, label }),
    [A, TITLE_A],
  );
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.queryClient.refetchQueries({
      queryKey: [["sessions", "inbox"]],
    }),
  );
  await page
    .getByRole("tab", { name: new RegExp(`^${TITLE_A}`) })
    .first()
    .waitFor();

  // Stop session… while B runs in the workspace: it keeps running, and the dialog names B.
  await tabOf(tabA).click();
  await tileOf(tabA)
    .getByRole("button", { name: `Actions for ${TITLE_A}` })
    .click();
  await menu().getByRole("menuitem", { name: "Stop session…" }).click();
  await stopDialog()
    .getByText(/keeps running for/)
    .waitFor();
  const keeps = (await stopDialog().innerText()).replace(/\s+/g, " ");
  if (!keeps.includes(TITLE_B)) throw new Error(`the dialog doesn't name ${TITLE_B}: ${keeps}`);
  note(`keeps running: ${keeps}`);
  await both("stop-keeps-running");

  // A stop the server can't preview: the dialog says so, with Try again; Stop still works.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!paths.includes("sessions.stopPreview")) return route.continue();
    await route.fulfill({
      status: 500,
      json: paths.map(() => ({
        error: {
          json: {
            message: "Mend couldn't reach the workspace.",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      })),
    });
  });
  await stopDialog().getByRole("button", { name: "Cancel" }).click();
  await stopDialog().waitFor({ state: "hidden" });
  await tileOf(tabA)
    .getByRole("button", { name: `Actions for ${TITLE_A}` })
    .click();
  await menu().getByRole("menuitem", { name: "Stop session…" }).click();
  await stopDialog().getByRole("button", { name: "Try again" }).waitFor({ timeout: 15_000 });
  note(`preview failed: ${(await stopDialog().innerText()).replace(/\s+/g, " ")}`);
  await both("fixture-stop-preview-failed");
  await page.unroute("**/trpc/**");
  await stopDialog().getByRole("button", { name: "Try again" }).click();
  await stopDialog()
    .getByText(/keeps running for/)
    .waitFor();
  note("Try again read the preview: the dialog names the session keeping the workspace up");

  // Stop A: the toast says B still runs; A's banner and line say the workspace keeps running.
  await stopDialog().getByRole("button", { name: "Stop session" }).click();
  await stopDialog().waitFor({ state: "hidden", timeout: 30_000 });
  await toastSaying(`Stopped "${TITLE_A}"`).waitFor({ timeout: 30_000 });
  note(`toast: ${(await toastSaying(`Stopped "${TITLE_A}"`).innerText()).trim()}`);
  await page
    .getByText("This session is stopped.")
    .filter({ visible: true })
    .waitFor({ timeout: 30_000 });
  await page.getByText(/You stopped the session at/).waitFor({ timeout: 15_000 });
  note(
    `stopped, B still running: ${(await page.getByText("This session is stopped.").filter({ visible: true }).locator("..").innerText()).replace(/\s+/g, " ")}`,
  );
  note(`line: ${await page.getByText(/You stopped the session at/).innerText()}`);
  await both("stopped-other-running");

  // The tab's menu on a stopped session offers no Stop session.
  await tabOf(tabA).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Copy link" }).waitFor();
  if ((await menuWords()).some((text) => text.startsWith("Stop session")))
    throw new Error("a stopped session's menu offers Stop session");
  note("a stopped session's tab menu has no Stop session…");
  await closeMenu();

  // The session alone in its workspace: the dialog says the workspace stops too.
  await page.context().clearCookies({ name: "mend-tiles" });
  await open(`/sessions/${C}`);
  await tabOf(tabC).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Stop session…" }).click();
  await stopDialog()
    .getByText(/so Mend stops the workspace/)
    .waitFor();
  note(`stops too: ${(await stopDialog().innerText()).replace(/\s+/g, " ")}`);
  await both("stop-stops-too");
  await stopDialog().getByRole("button", { name: "Stop session" }).click();
  await stopDialog().waitFor({ state: "hidden", timeout: 30_000 });
  await page
    .getByText("This session is stopped.")
    .filter({ visible: true })
    .waitFor({ timeout: 30_000 });
  await page.getByText(/The workspace has stopped\./).waitFor({ timeout: 30_000 });
  note(`stopped, workspace too: ${await page.getByText(/You stopped the session at/).innerText()}`);
  await both("stopped");

  // Resume: the banner goes, and the session runs again. A `mend run` command has nothing of its
  // own to resume, so the banner offers Resume as a shell.
  await page.getByRole("button", { name: "Resume as a shell" }).filter({ visible: true }).click();
  await page
    .getByText("This session is stopped.")
    .filter({ visible: true })
    .waitFor({ state: "hidden", timeout: 60_000 });
  const resumed = await page.waitForFunction(
    (id) => {
      const detail = window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["sessions", "detail"]] })
        .map((query) => query.state.data)
        .find((data) => data?.session?.id === id);
      return detail !== undefined && ["starting", "running"].includes(detail.session.status)
        ? detail.session.status
        : false;
    },
    C,
    { timeout: 60_000 },
  );
  note(`Resume session: the banner left; the session reads ${await resumed.jsonValue()}`);
  await both("resumed");

  // The phone: the header's "…" sheet, then Stop session… as a sheet.
  await page.context().clearCookies({ name: "mend-tiles" });
  await open(`/sessions/${B}`);
  await page.setViewportSize(PHONE);
  await settled();
  await page
    .getByRole("button", { name: `Actions for ${TITLE_B}` })
    .filter({ visible: true })
    .click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("menuitem", { name: "Stop session…" }).waitFor();
  note(`phone sheet: ${(await sheet.getByRole("menuitem").allInnerTexts()).join(" | ")}`);
  await both("phone-actions");
  await sheet.getByRole("menuitem", { name: "Stop session…" }).click();
  await stopDialog()
    .getByText(/so Mend stops the workspace/)
    .waitFor();
  note(`phone stop sheet: ${(await stopDialog().innerText()).replace(/\s+/g, " ")}`);
  await both("phone-stop-stops-too");
  await stopDialog().getByRole("button", { name: "Cancel" }).click();
  await stopDialog().waitFor({ state: "hidden" });

  // Leave every session running again (A as a shell), so the recipe can run again; no arrangement.
  await page.setViewportSize(DESKTOP);
  await client(async (trpc, id) => {
    await trpc.sessions.resume.mutate({ id, request: { harness: "shell" } }).catch(() => undefined);
  }, A);
  await page.context().clearCookies({ name: "mend-tiles" });
};
