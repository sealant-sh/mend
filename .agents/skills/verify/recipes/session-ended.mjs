// What a session says once its agent has stopped, and Delete (apps/web, route PR 13 part 2,
// SLNT-1145): the band while a stop is saving, the band when work isn't saved with Discard… and
// its dialog, the band when Services keep the workspace up with Stop services, the band when the
// workspace waits to be replaced with Replace this workspace now, and Delete session… on a
// stopped session, its dialog, and the way home. Run the CLI batch first, once per stack: it
// starts one session in `ended-a` and one in `ended-b`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/session-ended-sessions.json
//   pnpm verify drive web --recipe session-ended
//
// A local stack has no stuck save, no Service and no workspace from before 0.36: those four
// states are drawn from fixture answers to the session's reads (captures named `fixture-…`). The
// actions in them go to the real server, which refuses them, and the band or dialog says so.
// Delete is real.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { superjson } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE_KEPT = "Fix flaky checkout retry";
const TITLE_DELETED = "Add idempotency keys to refunds";
const NOT_SAVED_AT = "2026-11-18T10:00:00.000Z";

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Every signed-in page overflows by 2px while it settles: clip the sidebar's wrapper, and
      // park the mouse, so the driver keeps the picture.
      await page.evaluate(() => {
        const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
        if (wrapper instanceof HTMLElement) wrapper.style.maxHeight = "100dvh";
      });
      await page.mouse.move(2, 2);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(500);
    }
  };
  const settled = () => page.waitForTimeout(500);
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
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
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), path);
  const reread = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions"]],
      }),
    );
  const tabOf = (id) =>
    page.locator(`[data-tab="session:${id}"]`).filter({ visible: true }).getByRole("tab");
  const menu = () => page.getByRole("menu").filter({ visible: true }).last();
  const band = (title) => page.getByText(title, { exact: true }).filter({ visible: true });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();

  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  const liveIn = (worktree) =>
    rows.find(
      (row) =>
        row.worktreeName === worktree &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )?.session;
  const [kept, doomed] = [liveIn("ended-a"), liveIn("ended-b")];
  if (kept === undefined || doomed === undefined)
    throw new Error("ended-a and ended-b each need a running session: run the CLI batch");
  const me = kept.ownerUserId;
  await client(
    async (trpc, labels) => {
      for (const [id, label] of labels) await trpc.sessions.setLabel.mutate({ id, label });
    },
    [
      [kept.id, TITLE_KEPT],
      [doomed.id, TITLE_DELETED],
    ],
  );

  // The fixture states, laid over the kept session's detail.
  let state = null;
  const patchKept = (data) => {
    const json = structuredClone(data.json);
    const values = { ...data.meta?.values };
    const stoppedNow = () => {
      json.session.status = "stopped";
      json.currentAgent = null;
      json.processes = [];
      for (const key of Object.keys(values))
        if (key.startsWith("currentAgent") || key.startsWith("processes")) delete values[key];
    };
    if (state === "saving") {
      json.session.status = "stopping";
      json.session.captureDrain = "stop";
      json.session.capturePending = 3;
      json.session.capturePendingBytes = null;
    } else if (state === "not-saved") {
      stoppedNow();
      json.session.captureDrain = "stop";
      json.session.capturePending = 3;
      json.session.capturePendingBytes = null;
      json.session.captureNotSavedAt = NOT_SAVED_AT;
      values["session.captureNotSavedAt"] = ["Date"];
    } else if (state === "services") {
      stoppedNow();
      json.liveServices = 2;
    } else if (state === "retirement") {
      json.session.workspaceRetirement = "marked";
    }
    return { json, meta: { ...data.meta, values } };
  };
  const retirement = () =>
    superjson(
      {
        state: "marked",
        preRelease: true,
        launcher: me,
        stops: [
          { kind: "terminal", label: "claude · fix login" },
          { kind: "service", label: "web on :3000" },
          { kind: "process", label: "python (pid 31)" },
        ],
        reason: null,
        checkedAt: "2026-11-18T12:05:00.000Z",
        fingerprint: "fixture-fingerprint",
        canReplace: true,
      },
      ["checkedAt"],
    );
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (state === null || id !== kept.id) return null;
      if (path === "sessions.detail") return "detail";
      if (path === "sessions.workspaceRetirement" && state === "retirement") return "retirement";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((_, index) => {
      if (mine[index] === "detail" && answers[index]?.result?.data !== undefined)
        answers[index] = { result: { data: patchKept(answers[index].result.data) } };
      if (mine[index] === "retirement") answers[index] = { result: { data: retirement() } };
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });

  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${kept.id}`);
  await tabOf(kept.id).waitFor();

  // Saving: a stop still draining the workspace.
  state = "saving";
  await reread();
  await band("Saving the session's work.").first().waitFor();
  note(
    `saving: ${await page
      .getByText(/^saving · /)
      .first()
      .innerText()}`,
  );
  await both("fixture-saving");

  // Not saved: the save stalled; the owner's Discard… asks first, and the server's answer shows.
  state = "not-saved";
  await reread();
  await band("Some work isn't saved.").first().waitFor();
  note(
    `not saved: ${await page
      .getByText(/^not saved · /)
      .first()
      .innerText()}`,
  );
  await both("fixture-not-saved");
  await page.getByRole("button", { name: "Discard…" }).filter({ visible: true }).click();
  const discard = page.getByRole("dialog", { name: "Discard what isn't saved?" });
  await discard.waitFor();
  await both("fixture-discard-dialog");
  await discard.getByRole("button", { name: "Discard and stop" }).click();
  await discard.getByRole("alert").waitFor();
  note(
    `Discard and stop on a session with nothing unsaved: ${await discard.getByRole("alert").innerText()}`,
  );
  await discard.getByRole("button", { name: "Keep saving" }).click();
  await discard.waitFor({ state: "hidden" });

  // Services keep the workspace up after the agent stopped: Stop services.
  state = "services";
  await reread();
  await band("Services are still running.").first().waitFor();
  note(
    `services: ${await page
      .getByText(/services keep the workspace up/)
      .first()
      .innerText()}`,
  );
  await both("fixture-services-hold");
  await page.getByRole("button", { name: "Stop services" }).filter({ visible: true }).click();
  const servicesToast = page
    .getByRole("region", { name: /Notifications/ })
    .getByText(/services|No services/);
  await servicesToast.first().waitFor();
  note(`Stop services: ${await servicesToast.first().innerText()}`);

  // A workspace waiting to be replaced: what was checked, what would stop, and Replace.
  state = "retirement";
  await reread();
  await page.getByRole("list", { name: "What would stop" }).filter({ visible: true }).waitFor();
  note(
    `retirement: ${(
      await page
        .getByText(/shares one home/)
        .first()
        .innerText()
    ).trim()}`,
  );
  await both("fixture-retirement");
  await page
    .getByRole("button", { name: "Replace this workspace now" })
    .filter({ visible: true })
    .click();
  const refused = page.getByRole("alert").filter({ visible: true });
  await refused.first().waitFor();
  note(`Replace this workspace now, refused: ${await refused.first().innerText()}`);
  await both("fixture-replace-refused");
  state = null;
  await page.unroute("**/trpc/**");

  // A running session's menu offers no Delete.
  await reread();
  await tabOf(kept.id).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Copy link" }).waitFor();
  if ((await menu().getByRole("menuitem", { name: "Delete session…" }).count()) > 0)
    throw new Error("a running session's menu offers Delete");
  note("a running session's tab menu has no Delete session…");
  await page.keyboard.press("Escape");

  // Delete: stop the other session, then Delete session… from its tab's menu.
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), doomed.id);
  await page.waitForFunction(
    async (id) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      const detail = await trpcClient.sessions.detail.query({ id });
      return ["stopped", "completed"].includes(detail.session.status);
    },
    doomed.id,
    { timeout: 60_000, polling: 1_000 },
  );
  await page.context().clearCookies({ name: "mend-tiles" });
  await go(`/sessions/${doomed.id}`);
  await tabOf(doomed.id).waitFor();
  await tabOf(doomed.id).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Delete session…" }).click();
  const remove = page.getByRole("dialog", { name: "Delete this session?" });
  await remove.waitFor();
  note(`delete dialog: ${(await remove.innerText()).replace(/\s+/g, " ")}`);
  await both("delete-dialog");
  await page.setViewportSize(PHONE);
  await settled();
  await both("phone-delete-sheet");
  await page.setViewportSize(DESKTOP);
  await settled();
  await remove.getByRole("button", { name: "Delete session" }).click();
  await page.waitForFunction(() => location.pathname === "/", undefined, { timeout: 30_000 });
  const deleted = page.getByRole("region", { name: /Notifications/ }).getByText(/^Deleted /);
  await deleted.waitFor();
  note(`Delete session: home, and the toast says "${await deleted.innerText()}"`);
  await both("deleted");
  const listed = await page.evaluate(async (id) => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    const read = queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0];
    return read?.state.data?.some((row) => row.session.id === id) ?? true;
  }, doomed.id);
  if (listed) throw new Error("the deleted session is still in the inbox");
  note("the deleted session is gone from the inbox");
};
