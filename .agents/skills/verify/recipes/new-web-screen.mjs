// The Screen view on a local stack (route PR 19, SLNT-1157, ADR 0020): the workspace's desktop,
// live, with the bar (who has input, the display and its size, Full screen, Take over or Hand
// back) and the screen log; and every state a screen can be in. It turns Screen on in
// verify-fixture's own image (and puts it back at the end), starts a shell session in a new
// worktree, opens `/sessions/<id>?view=desktop`, and when the screen is live takes over, hands back
// and opens full screen. The driver withholds a picture with a video or a canvas in it, so a live
// screen is recorded by its accessibility snapshot. Then fixture answers to `screens.read` over the
// same session draw what it can't show on demand: no screen, starting, didn't start, stopped with
// the session, and a live screen the viewer can't reach (Reconnect).
//
//   pnpm verify drive new-web --recipe new-web-screen
//
// The box's version, with a Codex turn, is new-web-screen-box.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { patchDetail, superjson } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEW = "view:screen";

const visible = (locator) => locator.filter({ visible: true }).first();
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

const liveScreen = (owner, life) => ({
  _tag: "Screen",
  display: 10,
  processId: "fixture-screen",
  width: 1280,
  height: 800,
  life,
  holder: { _tag: "Agent", awaiting: false },
  since: null,
  ownerUserId: owner,
});

/** The first family workspace image a project's detail holds. */
const imageOf = (value) => {
  if (value === null || typeof value !== "object") return null;
  if (value.mode === "family" && Array.isArray(value.packages)) return value;
  for (const child of Object.values(value)) {
    const found = imageOf(child);
    if (found !== null) return found;
  }
  return null;
};

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
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
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((button) =>
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), path);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await hydrated();

  // verify-fixture's own image with Screen on, put back at the end; a shell keeps a new
  // worktree's workspace up, and its screen runs with it.
  const fixture = await client(
    async (trpc) => (await trpc.projects.list.query()).find((p) => p.name === "verify-fixture"),
    null,
  );
  if (fixture === undefined) throw new Error("no project verify-fixture on this stack");
  const before = imageOf(
    await client(async (trpc, project) => trpc.projects.detail.query({ id: project }), fixture.id),
  );
  if (before === null) throw new Error("verify-fixture's detail holds no family image");
  note(`verify-fixture's image before: ${JSON.stringify(before)}`);
  await client(
    async (trpc, [project, image]) =>
      trpc.projects.setWorkspaceImage.mutate({ id: project, request: { workspaceImage: image } }),
    [fixture.id, { ...before, screen: true }],
  );
  const worktree = await client(
    async (trpc, [project, name]) =>
      trpc.worktrees.create.mutate({ projectId: project, worktree: { name, base: null } }),
    [fixture.id, `screen-${Date.now()}`],
  );
  const shell = await client(
    async (trpc, tree) =>
      trpc.worktrees.createSession.mutate({ id: tree, session: { harness: "shell", label: null } }),
    worktree.id,
  );
  await client(
    async (trpc, session) => trpc.sessions.launch.mutate({ id: session, request: {} }),
    shell.id,
  );
  const id = shell.id;
  note(
    `started a shell session ${id} in ${worktree.name}, Screen on; the recipe stops it at the end`,
  );
  for (let tries = 0; ; tries += 1) {
    const detail = await client(
      async (trpc, session) => trpc.sessions.detail.query({ id: session }),
      id,
    );
    if (detail.session.status === "running") break;
    if (["failed", "stopped", "completed"].includes(detail.session.status) || tries > 240)
      throw new Error(`the shell session is ${detail.session.status}`);
    await page.waitForTimeout(5_000);
  }
  note("the shell session runs");

  // The old address of the Desktop panel lands on the Screen view.
  await page.goto(`${web}/sessions/${id}?view=desktop`);
  await page.waitForURL(`**/sessions/${id}/screen`, { timeout: 30_000 });
  await hydrated();
  note(`?view=desktop went to ${new URL(page.url()).pathname}`);
  const tab = visible(page.locator(`[data-tab="${VIEW}"]`).getByRole("tab"));
  await tab.waitFor();
  note(
    `the Screen tab is selected (${await tab.getAttribute("aria-selected")}) and reads ${JSON.stringify(await textOf(tab))}`,
  );
  const body = visible(page.locator(`[data-tab-body="${VIEW}"]`));
  await body.getByText(/Reading the screen/).waitFor({ state: "hidden", timeout: 30_000 });
  const real = await client(async (trpc, session) => trpc.screens.read.query({ id: session }), id);
  note(`screens.read answers ${JSON.stringify(real)}`);
  note(`the real Screen view reads ${JSON.stringify(await textOf(body))}`);
  note(`its accessibility tree:\n${await body.ariaSnapshot()}`);
  await both("box-screen-real");

  if (real?._tag === "Screen" && real.life._tag === "Live") {
    const bar = body.getByRole("status").first();
    await visible(body.getByText(/has input/)).waitFor({ timeout: 60_000 });
    note(`live: ${JSON.stringify(await textOf(bar))}`);
    const take = visible(body.getByRole("button", { name: "Take over" }));
    await take.click();
    await visible(body.getByText("You have input")).waitFor({ timeout: 30_000 });
    note(`Take over: ${JSON.stringify(await textOf(bar))}`);
    note(`its accessibility tree:\n${await body.ariaSnapshot()}`);
    await visible(body.getByRole("button", { name: "Hand back" })).click();
    await visible(body.getByText(/has input/)).waitFor({ timeout: 30_000 });
    note(`Hand back: ${JSON.stringify(await textOf(bar))}`);
    await visible(body.getByRole("button", { name: "Full screen" })).click();
    await page.waitForFunction(() => document.fullscreenElement !== null, null, {
      timeout: 10_000,
    });
    note("Full screen: the panel is the document's full-screen element");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.fullscreenElement === null, null, {
      timeout: 10_000,
    });
    const log = visible(body.getByRole("region", { name: "Screen log" }));
    note(`the screen log: ${JSON.stringify(await textOf(log))}`);
  }

  // Fixtures over this session's reads.
  const me = (
    await client(async (trpc, session) => trpc.sessions.detail.query({ id: session }), id)
  ).session.ownerUserId;
  let state = null;
  const answers = {
    "no-screen": () => ({ _tag: "NoScreen" }),
    starting: () => liveScreen(me, { _tag: "Starting" }),
    "did-not-start": () => liveScreen(me, { _tag: "Ended", reason: "start-failed" }),
    stopped: () => liveScreen(me, { _tag: "Ended", reason: "session-stopped" }),
    unreachable: () => liveScreen(me, { _tag: "Live", degraded: null, browserSandboxOff: false }),
  };
  const log = [
    ["Started", "Mend"],
    ["Looked", "Agent"],
    ["Acted", "Agent"],
  ].map(([tag, actor], index) => ({
    screenId: "fixture-screen",
    seq: index + 1,
    at: `2026-11-19T07:0${index}:00.000Z`,
    actor:
      actor === "Mend"
        ? { _tag: "Mend" }
        : {
            _tag: "Agent",
            processId: "fixture-process",
            turnId: null,
            callKey: `call-${index}`,
            toolCall: { _tag: "Native" },
          },
    body:
      tag === "Acted"
        ? {
            _tag: "Acted",
            notes: [
              { action: { kind: "click", at: { x: 640, y: 412 }, button: "left" }, result: "done" },
            ],
          }
        : { _tag: tag },
    frame: index === 0 ? null : { id: `frame-${index}`, digest: "d".repeat(64), state: "stored" },
    checkpoint: null,
  }));
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const ours = paths.map((path, index) => {
      const input = inputs[String(index)]?.json ?? inputs.json;
      return state !== null && input?.id === id ? path : null;
    });
    if (!ours.some((path) => ["screens.read", "screens.log", "sessions.detail"].includes(path)))
      return route.continue();
    const response = await route.fetch();
    const answer = await response.json();
    const all = Array.isArray(answer) ? answer : [answer];
    ours.forEach((path, index) => {
      if (path === "screens.read")
        all[index] = { result: { data: superjson(answers[state](), []) } };
      else if (path === "screens.log")
        all[index] = {
          result: {
            data: superjson(
              log,
              log.map((_, at) => `${at}.at`),
            ),
          },
        };
      else if (path === "sessions.detail" && state === "stopped" && all[index]?.result?.data)
        all[index] = {
          result: {
            data: patchDetail(all[index].result.data, { status: "stopped", dropAgent: true }),
          },
        };
    });
    await route.fulfill({ response, json: Array.isArray(answer) ? all : all[0] });
  });
  const reread = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["screens"]],
      }),
    );
  const show = async (name, text) => {
    state = name;
    await page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions"]],
      }),
    );
    await reread();
    await visible(body.getByText(text)).waitFor({ timeout: 30_000 });
    note(`fixture ${name}: ${JSON.stringify(await textOf(body))}`);
  };

  await show("no-screen", "No screen in this workspace.");
  await both("fixture-screen-no-screen");
  await show("starting", "Starting the screen…");
  await capture("fixture-screen-starting-light");
  await show("did-not-start", "The screen didn't start.");
  await capture("fixture-screen-did-not-start-light");
  await show("stopped", "The screen stopped with the session.");
  await capture("fixture-screen-stopped-light");
  state = "unreachable";
  await reread();
  await visible(body.getByText("Mend couldn't reach the screen.")).waitFor({ timeout: 60_000 });
  note(`fixture unreachable: ${JSON.stringify(await textOf(body))}`);
  // The card sits over an empty stage: no video or canvas is mounted while it shows.
  await capture("fixture-screen-unreachable-light");
  await visible(body.getByRole("button", { name: "Reconnect" })).click();
  await visible(
    body.getByText(/Connecting to the screen|Mend couldn't reach the screen/),
  ).waitFor();
  note(`Reconnect: ${JSON.stringify(await textOf(body))}`);

  await page.setViewportSize(PHONE);
  state = "no-screen";
  await reread();
  await visible(body.getByText("No screen in this workspace.")).waitFor({ timeout: 30_000 });
  note(
    `at 390px the page is ${await page.evaluate(() => document.documentElement.scrollWidth)}px wide`,
  );
  await capture("fixture-screen-no-screen-phone-light");
  await page.setViewportSize(DESKTOP);

  state = null;
  await page.unroute("**/trpc/**");
  await go("/");
  await client(async (trpc, session) => trpc.sessions.stop.mutate({ id: session }), id);
  await client(
    async (trpc, [project, image]) =>
      trpc.projects.setWorkspaceImage.mutate({ id: project, request: { workspaceImage: image } }),
    [fixture.id, before],
  );
  note(`stopped session ${id} and put verify-fixture's image back`);
};
