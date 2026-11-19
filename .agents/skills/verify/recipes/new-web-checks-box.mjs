// The Checks view on the box, with a real Codex turn (route PR 21, SLNT-1157): Codex runs a test
// twice, a typecheck and a lint that fails, edits a file after them, and the session's Checks tab
// reads its record: one row per command, newest first, each with Codex's own exit code and
// duration, the tab's fact, and "No check ran after the last edit." Run it as the verify skill's
// section 9 says, under your own hold:
//
//   pnpm verify drive new-web --box --recipe new-web-checks-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session in
// verify-fixture from the New session composer and stops it at the end; if the drive fails before
// then, stop it with the checker CLI before release. The states a real record can't be made to
// show on demand (being read, a failed read, earlier history, an empty record) are laid over the
// same session's reads as fixtures at the end, as new-web-checks does on a local stack.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { history } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const VIEW = "view:checks";
const PROMPT = [
  "Do these steps in order, without asking. Use apply_patch for every file you create or change,",
  "and run each command on its own, as a separate shell command.",
  "1. Create `checks/test` (a sh script that prints `3 tests passed` and exits 0),",
  "`checks/typecheck` (prints `no type errors`, exits 0) and `checks/lint`",
  "(prints `src/a.ts:1 unused import`, exits 1).",
  "2. Run `sh checks/test`. 3. Run `sh checks/test` again. 4. Run `sh checks/typecheck`.",
  "5. Run `sh checks/lint`. 6. Run `ls checks`. 7. Add the line `checked` to the end of README.md.",
  "Then reply with the single word done, and nothing else.",
].join(" ");

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

/** A tRPC answer that failed on purpose, as the server words one. */
const failure = (procedure) => ({
  error: {
    json: {
      message: "The record store didn't answer.",
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
    },
  },
});

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  // The driver may withhold a picture when the page changes while it looks: look again.
  const capture = async (name) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await page.evaluate(() =>
        document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
      );
      await page.mouse.move(2, 2);
      await settled();
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`)) || existsSync(join(out, `${name}.png.withheld`)))
        return;
      await page.waitForTimeout(400);
    }
  };
  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((button) =>
      Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const pick = (name) => visible(page.getByRole("button", { name }));
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").fill("verify-fixture");
  await page
    .getByRole("option", { name: /^verify-fixture/ })
    .first()
    .click();
  await pick(/^Agent and model: /).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(PROMPT);
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started Codex session ${id} from the composer; the recipe stops it at the end`);

  // The turn ends with Codex's reply.
  await visible(page.getByText("Codex · turn 1", { exact: true })).waitFor({ timeout: TURN_MS });
  await visible(page.getByText(/^done\.?$/i)).waitFor({ timeout: TURN_MS });
  await visible(page.getByRole("button", { name: "Stop turn" })).waitFor({
    state: "hidden",
    timeout: TURN_MS,
  });
  note("Codex finished turn 1 with done");

  // The view's own address: the session with the Checks tab showing.
  await page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), `/sessions/${id}/checks`);
  const tab = visible(page.locator(`[data-tab="${VIEW}"]`).getByRole("tab"));
  await tab.waitFor();
  note(
    `/sessions/<id>/checks: the Checks tab is selected (${await tab.getAttribute("aria-selected")}) and reads ${JSON.stringify(await textOf(tab))}`,
  );
  const body = visible(page.locator(`[data-tab-body="${VIEW}"]`));
  const list = body.getByRole("list", { name: "Checks" });
  await list.waitFor({ timeout: 60_000 });
  for (const row of await list.getByRole("listitem").all())
    note(`check: ${JSON.stringify(await textOf(row))}`);
  const after = body.getByText(/^No check ran after/);
  note(
    (await after.count()) > 0
      ? `after the list: ${JSON.stringify(await textOf(after))}`
      : "after the list: no line about edits",
  );
  note(`the view's accessibility tree:\n${await body.ariaSnapshot()}`);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await page.mouse.move(2, 2);
    await settled();
    await capture(`box-checks-desktop-${theme}`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // The tile's "+" lists Checks between Change and Preview, with the same fact.
  await visible(page.getByRole("button", { name: "Open a view" })).click();
  const menu = page.getByRole("menu").filter({ visible: true }).last();
  await menu.waitFor();
  note(`the "+" menu: ${JSON.stringify(await textOf(menu))}`);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  await page.setViewportSize(PHONE);
  await settled();
  await visible(list).waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  note(`at 390px the page is ${wide}px wide`);
  await capture("box-checks-phone-light");
  await page.setViewportSize(DESKTOP);

  // Fixtures over this session's record reads: earlier windows unread, an empty record, a read
  // held open, a failed read.
  let state = null;
  const { promise: held, resolve: release } = Promise.withResolvers();
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const ours = paths.map((path, index) => {
      const input = inputs[String(index)]?.json ?? inputs.json;
      return state !== null && input?.id === id && path.startsWith("sessions.history")
        ? path
        : null;
    });
    if (ours.every((path) => path === null)) return route.continue();
    if (state === "hold") await held;
    const response = await route.fetch();
    const answer = await response.json();
    const answers = Array.isArray(answer) ? answer : [answer];
    const empty = history({ turns: [], items: [] });
    ours.forEach((path, index) => {
      if (path === null) return;
      if (state === "fail") answers[index] = failure(path);
      else if (state === "empty") answers[index] = { result: { data: empty[path] } };
      else if (state === "earlier" && path === "sessions.historyItems") {
        // Earlier windows unread, and a check Claude ran through Bash: its tool call holds no exit.
        const data = answers[index].result.data;
        data.json.next = "fixture-cursor";
        const at = new Date().toISOString();
        const position = data.json.items.length;
        data.json.items.push({
          id: "fixture-claude-build",
          seq: 1_000_000,
          turnId: data.json.items[0]?.turnId ?? "fixture-turn",
          kind: "command-execution",
          status: "completed",
          title: "Bash",
          text: null,
          data: { type: "tool_use", name: "Bash", input: { command: "pnpm run build" } },
          createdAt: at,
          updatedAt: at,
        });
        data.meta = {
          ...data.meta,
          values: {
            ...data.meta?.values,
            [`items.${position}.createdAt`]: ["Date"],
            [`items.${position}.updatedAt`]: ["Date"],
          },
        };
      }
    });
    await route.fulfill({ response, json: Array.isArray(answer) ? answers : answers[0] });
  });
  /** Forgets the record, so the view reads it again through the fixtures. */
  const forget = () =>
    page.evaluate(() => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      queryClient.removeQueries({ queryKey: [["sessions", "historyItems"]] });
      return queryClient.invalidateQueries({ queryKey: [["sessions"]] });
    });

  state = "earlier";
  await forget();
  await body.getByRole("button", { name: "Read earlier history" }).waitFor({ timeout: 30_000 });
  await body.getByText(/^Build ran/).waitFor({ timeout: 30_000 });
  note(`fixture, earlier history unread and Claude's build: ${JSON.stringify(await textOf(body))}`);
  await capture("fixture-checks-earlier-desktop-light");

  state = "empty";
  await forget();
  await body.getByText(/^No test, typecheck, lint or build/).waitFor({ timeout: 30_000 });
  note(`fixture, empty record: ${JSON.stringify(await textOf(body))}`);
  await capture("fixture-checks-empty-desktop-light");

  state = "hold";
  await forget();
  await body.getByText("Reading the record…").waitFor({ timeout: 30_000 });
  note(`fixture, the record being read: ${JSON.stringify(await textOf(body))}`);
  await capture("fixture-checks-loading-desktop-light");
  state = "fail";
  release();

  await forget();
  await body.getByText("This didn't load.").waitFor({ timeout: 30_000 });
  note(`fixture, a failed read: ${JSON.stringify(await textOf(body))}`);
  await capture("fixture-checks-failed-desktop-light");
  state = null;
  await body.getByRole("button", { name: "Try again" }).click();
  await list.waitFor({ timeout: 30_000 });
  note(`Try again: the list is back with ${await list.getByRole("listitem").count()} rows`);
  await page.unroute("**/trpc/**");

  await page.evaluate(
    async (session) =>
      window["__TSR_ROUTER__"].options.context.trpcClient.sessions.stop.mutate({ id: session }),
    id,
  );
  note(`stopped session ${id}`);
};
