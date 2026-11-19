// The Screen view on the box (route PR 19, SLNT-1157, ADR 0020): the workspace's desktop, live,
// with the bar (who has input, the display and its size, Full screen, Take over or Hand back) and
// the screen log; and every state a screen can be in. Run it under your own hold:
//
//   pnpm verify drive new-web --box --recipe new-web-screen-box
//
// The drive signs in as the box's checker account. The recipe looks for a project of the account's
// whose workspace image has Screen on and starts a Codex session there (verify-fixture when none
// has), opens `/sessions/<id>/screen` and its old address `?view=desktop`, and, when the screen is
// live, takes over, hands back and opens full screen. The driver withholds a picture with a video
// or a canvas in it, so a live screen is recorded by its accessibility snapshot. Then fixture
// answers to `screens.read` over the same session draw the states it can't show on demand: no
// screen, starting, didn't start, stopped with the session, and a live screen the viewer can't
// reach (Reconnect). The recipe stops the session at the end; if the drive fails before then,
// stop it with the checker CLI before release.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { patchDetail, superjson } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
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

export default async ({ page, web, capture: captureOnce, note }) => {
  /** The view drawn after the read it shows, with no spinner left in it. */
  const settledScreen = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["screens"]],
      }),
    );
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

  // A project whose workspace image has Screen on.
  const withScreen = await client(async (trpc) => {
    for (const project of await trpc.projects.list.query()) {
      const detail = await trpc.projects.detail.query({ id: project.id }).catch(() => null);
      if (detail !== null && JSON.stringify(detail).includes('"screen":true')) return project.name;
    }
    return null;
  });
  const projectName = withScreen ?? "verify-fixture";
  note(
    withScreen === null
      ? "no project of the checker account has Screen on: the session runs in verify-fixture, and live states are drawn by fixtures only"
      : `the project ${withScreen} has Screen on: the session runs there`,
  );

  const pick = (name) => visible(page.getByRole("button", { name }));
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").fill(projectName);
  await page
    .getByRole("option", { name: new RegExp(`^${projectName}`) })
    .first()
    .click();
  await pick(/^Agent and model: /).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(
    "Reply with the single word ready, and nothing else.",
  );
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started Codex session ${id}; the recipe stops it at the end`);
  await visible(page.getByText(/^ready\.?$/i)).waitFor({ timeout: TURN_MS });

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
  // A screen starts with its session: wait up to four minutes for it to go live.
  let real = null;
  for (let tries = 0; tries < 48; tries += 1) {
    real = await client(async (trpc, session) => trpc.screens.read.query({ id: session }), id);
    if (real?._tag !== "Screen" || !["NotStarted", "Starting"].includes(real.life._tag)) break;
    await page.waitForTimeout(5_000);
  }
  await settledScreen();
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
  // The viewer can't reach the screen: its WebRTC offer fails and its socket closes at once.
  await page.route("**/api/sessions/*/screen/rtc", (route) => route.fulfill({ status: 503 }));
  await page.routeWebSocket(/\/api\/screen-socket/, (socket) =>
    socket.close({ code: 1011, reason: "fixture" }),
  );
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
  note(`stopped session ${id}`);
};
