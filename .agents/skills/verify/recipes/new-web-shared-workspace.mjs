// Sessions that share a workspace (apps/web, route PR 36, SLNT-1163, ADR 0026 decision 7), on the
// pages already built: the composer's worktree picker, the join line (`join-line`, with
// `runs-as-yourself`), starting your own session from another person's, stopping the second
// session, and landing while another session is still editing. Run the CLI batch first, once per
// stack: it makes the worktree `shared-ws-<time>` with one session that wrote a file and two that
// keep running (`sleep`).
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-shared-workspace-sessions.json
//   pnpm verify drive new-web --recipe new-web-shared-workspace
//
// Real, against the stack: the picker's "Your running workspaces in verify-fixture" with how many
// sessions run in each, and no join line where only your own sessions run; Stop session… on the
// second session saying the workspace keeps running for the other, the stop, and its toast; the
// Land dialog naming the session still editing.
//
// A local stack has one account, so another person is drawn from fixture answers (captures named
// `fixture-…`): the project's sessions with Grace Hopper's live in the worktree (the join line in
// the composer and in the New session tab), Grace's session that the viewer can't message ("Start
// your own session in this workspace"), and the land answer (the stack's origin takes no push),
// whose toast names the session still running. Last, a project read that fails under the join line.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { history, item, patchDetail, superjson, turn } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLES = {
  first: "Fix flaky checkout retry",
  editing: "Write tests for retry",
  second: "Add a regression test for 409s",
};
const GRACE = "fixture-grace";
const SHA = "c71e0a2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49";

/** The first of `locator`'s matches a person can see: under 1024px some are in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // The sidebar's wrapper is 2px taller than the window while it settles: clip it, and park
      // the mouse, so the driver keeps the picture.
      await page.evaluate(() => {
        const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
        if (wrapper instanceof HTMLElement) wrapper.style.maxHeight = "100dvh";
        document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove());
      });
      await page.mouse.move(2, 2);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(500);
    }
  };
  const shoot = async (name, themes = ["light"]) => {
    for (const theme of themes) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const both = (name) => shoot(name, ["light", "dark"]);
  const atWidth = async (size, fn) => {
    await page.setViewportSize(size);
    await settled();
    await fn();
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
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
  /** Moves to `path` through the router: fixtures don't survive a full reload. */
  const go = (to, hash) =>
    page.evaluate(
      ([path, fragment]) =>
        window["__TSR_ROUTER__"].navigate({
          to: path,
          ...(fragment === undefined ? {} : { hash: fragment }),
        }),
      [to, hash],
    );
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const clearReads = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const dialog = () => page.getByRole("dialog").filter({ visible: true }).last();
  const tabOf = (key) =>
    page.locator(`[data-tab="${key}"]`).filter({ visible: true }).getByRole("tab");
  const tileOf = (key) =>
    page.locator("[data-tile]").filter({ has: page.locator(`[data-tab="${key}"]`) });
  const toast = (text) =>
    page.getByRole("region", { name: "Notifications" }).getByText(text).first();
  const joinLine = () => visible(page.getByText(/session is running in this worktree\./));

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();
  await page.waitForTimeout(1_500);
  await hydrated();

  // The three sessions the CLI batch made in the newest shared-ws worktree.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const worktree = rows
    .map((row) => row.worktreeName ?? "")
    .filter((name) => /^shared-ws-\d+$/.test(name))
    .toSorted()
    .at(-1);
  const inWorktree = rows
    .filter((row) => row.worktreeName === worktree)
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
    .map((row) => row.session);
  const first = inWorktree[0];
  const running = inWorktree.filter((session) => session.status === "running");
  if (first === undefined || running.length < 2)
    throw new Error("run new-web-shared-workspace-sessions.json first: two running sessions");
  const [editing, second] = running;
  const me = first.ownerUserId;
  note(`worktree ${worktree}: first ${first.id}, editing ${editing.id}, second ${second.id}`);
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [first.id, TITLES.first],
      [editing.id, TITLES.editing],
      [second.id, TITLES.second],
    ],
  );

  // Fixture answers, laid over the real reads while `state` is set.
  let state = null;
  let landAnswer = false;
  const at = "2026-11-18T10:24:00.000Z";
  const graceHistory = () => {
    const t = turn(
      editing.id,
      GRACE,
      0,
      "completed",
      "Webhook deliveries that fail 5 times are dropped. Move them to a dead-letter table instead, and add a way to replay them.",
      "2026-11-18T09:58:00.000Z",
      "2026-11-18T10:01:12.000Z",
    );
    return history({
      turns: [t],
      items: [
        item(t.id, "agent-message", "completed", at, at, {
          text: "When a delivery fails for the fifth time, it now goes into a new `webhook_dead_letters` table, and `replayDeadLetter(id)` sends it again. All 58 webhook tests passed.",
        }),
      ],
    });
  };
  const landReport = () =>
    superjson(
      {
        landing: {
          id: "fixture-landing",
          changeId: "fixture-change",
          sessionId: first.id,
          projectId: first.projectId,
          checkpointId: null,
          checkpointRef: null,
          checkpointSha: null,
          commitSha: SHA,
          remoteBranch: first.branch,
          pushedSha: SHA,
          oneOff: false,
          trigger: "manual",
          pullRequest: null,
          pullRequestCrossRepository: false,
          pullRequestHeadOwner: null,
          outcome: "pushed",
          message: null,
          userId: me,
          createdAt: at,
        },
        pullRequest: { _tag: "unavailable", reason: "origin is not on GitHub" },
      },
      ["landing.createdAt"],
    );
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this read on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const answerOf = (path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (path === "landings.land" && landAnswer) return "land";
      if (state === null) return null;
      if (path === "projects.detail" && id === first.projectId)
        return state === "project-failed" ? { error: failure.error } : "project";
      if (path === "organization.members") return "members";
      if (state !== "grace-session") return null;
      if (path === "sessions.detail" && id === editing.id) return "detail";
      if (path.startsWith("sessions.history") && id === editing.id)
        return { result: { data: graceHistory()[path] } };
      return null;
    };
    const mine = paths.map(answerOf);
    if (mine.every((each) => each === null)) return route.fallback();
    // A fixture's landing never reaches the server.
    if (mine.every((each) => each === "land")) {
      const answer = { result: { data: landReport() } };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(url.searchParams.has("batch") ? paths.map(() => answer) : answer),
      });
    }
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((_, index) => {
      const answer = mine[index];
      const data = answers[index]?.result?.data;
      if (answer === null) return;
      if (typeof answer === "object") answers[index] = answer;
      else if (data === undefined) return;
      else if (answer === "project") {
        // Grace Hopper's session is live in the worktree, and she runs in it as herself.
        const json = structuredClone(data.json);
        for (const session of json.sessions ?? [])
          if (session.id === editing.id) {
            session.ownerUserId = GRACE;
            session.livePeople = [{ accountId: GRACE, name: "Grace Hopper" }];
          }
        answers[index] = { result: { data: { ...data, json } } };
      } else if (answer === "members") {
        const json = structuredClone(data.json);
        const one = json[0];
        if (one !== undefined) json.push({ ...one, userId: GRACE, name: "Grace Hopper" });
        answers[index] = { result: { data: { ...data, json } } };
      } else if (answer === "detail") {
        const patched = patchDetail(data, {
          status: "running",
          harness: "claude",
          ownerUserId: GRACE,
          viewerSteers: false,
        });
        answers[index] = { result: { data: patched } };
      }
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });

  // The composer's worktree picker: your running workspaces, with how many sessions run in each.
  await go("/");
  const projectPick = visible(page.getByRole("button", { name: /^Project: / }));
  await projectPick.waitFor({ timeout: 60_000 });
  if (!(await projectPick.getAttribute("aria-label"))?.endsWith("verify-fixture")) {
    await projectPick.click();
    await page
      .getByRole("option", { name: /verify-fixture/ })
      .first()
      .click();
  }
  const worktreePick = () => visible(page.getByRole("button", { name: /^Worktree: / }));
  await worktreePick().click();
  const runningGroup = visible(
    page.getByRole("group", { name: "Your running workspaces in verify-fixture" }),
  );
  await runningGroup.waitFor({ timeout: 30_000 });
  const row = runningGroup.getByRole("menuitemradio", { name: new RegExp(worktree) });
  note(`picker: ${(await runningGroup.innerText()).replace(/\s+/g, " ")}`);
  if (!(await row.innerText()).includes("2 sessions"))
    throw new Error(`${worktree} doesn't say 2 sessions: ${await row.innerText()}`);
  // The branch search below lists the other worktrees, not this one again.
  const twice = await visible(page.getByRole("listbox"))
    .getByRole("option", { name: new RegExp(first.branch) })
    .count();
  note(`the branch search lists ${worktree} ${twice} times`);
  if (twice !== 0) throw new Error(`${worktree} is listed again under the branch search`);
  await both("picker");
  await row.click();
  await page.getByRole("button", { name: `Worktree: ${first.branch}` }).waitFor();
  await settled();
  if ((await joinLine().count()) !== 0) throw new Error("a join line shows for your own sessions");
  note(`picked ${worktree}: the composer starts there; no join line, only your sessions run there`);
  await atWidth(PHONE, async () => {
    await go("/new");
    await visible(page.getByRole("button", { name: /^Worktree/ })).click();
    await visible(
      page.getByRole("group", { name: "Your running workspaces in verify-fixture" }),
    ).waitFor({ timeout: 30_000 });
    await both("phone-picker");
    await page.keyboard.press("Escape");
  });

  // join-line, runs-as-yourself: Grace Hopper's session runs in the picked workspace.
  await go("/");
  state = "grace";
  await reread();
  await worktreePick().click();
  await runningGroup.getByRole("menuitemradio", { name: new RegExp(worktree) }).click();
  await joinLine().waitFor({ timeout: 30_000 });
  note(`fixture composer join line: ${await joinLine().innerText()}`);
  await shoot("fixture-composer-join-line");

  // The project read under the join line fails: it says so, with Try again.
  state = "project-failed";
  await clearReads();
  await go("/no-such-page");
  await go("/");
  await worktreePick().click();
  await runningGroup.getByRole("menuitemradio", { name: new RegExp(worktree) }).click();
  const unread = visible(page.getByText("Mend couldn't read who else works in this workspace."));
  await unread.waitFor({ timeout: 30_000 });
  await shoot("fixture-join-line-failed");
  state = "grace";
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await joinLine().waitFor({ timeout: 30_000 });
  note("project read failed: the line said so; Try again read it, and the join line showed");

  // Grace's session, which the viewer can't message: Start your own session in this workspace.
  state = "grace-session";
  await clearReads();
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${editing.id}`);
  const startOwn = () => button("Start your own session in this workspace");
  await startOwn().waitFor({ timeout: 60_000 });
  const locked = visible(page.locator('[data-slot="prompt-input-notice"]'));
  note(`fixture Grace's session: "${await locked.innerText()}" · Start your own session…`);
  await both("fixture-grace-session");
  await atWidth(PHONE, async () => {
    await startOwn().waitFor();
    await both("fixture-phone-grace-session");
  });
  await startOwn().click();
  await visible(page.getByRole("heading", { name: "New session" })).waitFor();
  await joinLine().waitFor({ timeout: 30_000 });
  const focus = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  note(
    `Start your own session: a New session tab beside Grace's, focus on "${focus}", join line: ${await joinLine().innerText()}`,
  );
  await both("fixture-join-new-session-tab");
  await atWidth(PHONE, () => shoot("fixture-phone-join-new-session-tab"));

  // Stop the second session (real): the workspace keeps running for the session still editing.
  state = null;
  await clearReads();
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${second.id}`);
  const tab = `session:${second.id}`;
  await tabOf(tab).waitFor({ timeout: 60_000 });
  await tileOf(tab)
    .getByRole("button", { name: `Actions for ${TITLES.second}` })
    .click();
  await page.getByRole("menuitem", { name: "Stop session…" }).click();
  await dialog()
    .getByText(/keeps running for/)
    .waitFor({ timeout: 30_000 });
  const keeps = (await dialog().innerText()).replace(/\s+/g, " ");
  if (!keeps.includes(TITLES.editing)) throw new Error(`the dialog doesn't name it: ${keeps}`);
  note(`Stop session…: ${keeps}`);
  await shoot("stop-second");
  await atWidth(PHONE, () => shoot("phone-stop-second"));
  await dialog().getByRole("button", { name: "Stop session" }).click();
  await toast(/still running/).waitFor({ timeout: 30_000 });
  note(`stopped: ${(await toast(/still running/).innerText()).trim()}`);
  await shoot("stopped-second");

  // Land while another session is still editing: the dialog names it, and landing goes ahead.
  await clearReads();
  await go(`/sessions/${first.id}/change`, "land");
  await dialog().getByText(`${TITLES.editing} is still editing`).waitFor({ timeout: 60_000 });
  note(
    `Land dialog: "${TITLES.editing} is still editing" · ${(
      await dialog()
        .getByText(/Mend pushes the files as they are now/)
        .innerText()
    ).trim()}`,
  );
  await shoot("land-still-editing");
  landAnswer = true;
  await dialog()
    .getByRole("button", { name: /^(Push to origin|Try again)$/ })
    .click();
  const landed = `Pushed ${first.branch} to origin. ${TITLES.editing} is still running.`;
  await toast(landed).waitFor({ timeout: 30_000 });
  note(`fixture land answer: the toast "${landed}"`);
  await shoot("fixture-landed-toast");
  landAnswer = false;
  await page.unroute("**/trpc/**");

  // Leave nothing running.
  await client(
    async (trpc, ids) => {
      for (const id of ids) await trpc.sessions.stop.mutate({ id }).catch(() => undefined);
    },
    [editing.id, second.id],
  );
  note("stopped the batch's running sessions");
};
