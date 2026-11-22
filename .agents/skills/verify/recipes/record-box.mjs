// The Record view on the box, with a real Codex turn (route PR 20, SLNT-1157): everything the
// session did, newest first, filtered by kind; a command's row opened to its output, exit and
// duration; a pull request's link `/sessions/<id>#checkpoint-N` landing on the Record with that
// checkpoint in view and marked, and Clear the mark; Mark a checkpoint (review-change.md
// `review-checkpoint-mark`); 390px. Then the states a real record can't show on demand, laid over
// the same session's reads: the record being read, a failed read with Try again, an empty record,
// and earlier history unread. Run it under your own hold:
//
//   pnpm verify drive web --box --recipe record-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session in
// verify-fixture from the New session composer and stops it at the end; if the drive fails before
// then, stop it with the checker CLI before release.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { history } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const VIEW = "view:record";
const PROMPT = [
  "Do these steps in order, without asking. Use apply_patch for every file you create or change,",
  "and run each command on its own, as a separate shell command.",
  "1. Create `notes/plan.md` with the line `retry with one key per order`.",
  "2. Run `ls notes`. 3. Run `sh -c 'echo 3 tests passed; exit 1'`.",
  "4. Add the line `back off on 409` to the end of `notes/plan.md`.",
  "Then reply with the single word done, and nothing else.",
].join(" ");

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

/** A tRPC answer that failed on purpose, as the server words one. */
/** The reads besides the history an empty record also empties (see the fixtures below). */
const EMPTIED = new Set(["sessions.transcript", "screens.log", "sessions.detail"]);

/**
 * One of `EMPTIED`'s answers with nothing in it: no transcript events, no screen log rows, and the
 * session's detail with no checkpoints (its superjson paths under `checkpoints` dropped with them).
 */
const emptied = (path, answer) => {
  if (!("result" in answer)) return answer;
  const data = answer.result.data;
  if (path === "screens.log") return { result: { data: { json: [] } } };
  if (path === "sessions.transcript") {
    data.json.events = [];
    dropMeta(data, "events");
    return answer;
  }
  data.json.checkpoints = [];
  dropMeta(data, "checkpoints");
  return answer;
};

/**
 * Drop superjson's notes under `field`: its type notes (`field.0.createdAt`) and its shared-value
 * notes (`field.0.seq` equal to `field.1.seq`), which name paths that are gone once it is emptied.
 */
const dropMeta = (data, field) => {
  const under = (path) => path === field || path.startsWith(`${field}.`);
  const values = data.meta?.values;
  if (values !== undefined && values !== null && !Array.isArray(values))
    for (const key of Object.keys(values)) if (under(key)) delete values[key];
  const equal = data.meta?.referentialEqualities;
  if (equal !== undefined && equal !== null && !Array.isArray(equal))
    for (const [key, paths] of Object.entries(equal)) {
      const kept = paths.filter((path) => !under(path));
      if (under(key) || kept.length === 0) delete equal[key];
      else equal[key] = kept;
    }
};

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
  await visible(page.getByText("Codex · turn 1", { exact: true })).waitFor({ timeout: TURN_MS });
  await visible(page.getByText(/^done\.?$/i)).waitFor({ timeout: TURN_MS });
  await visible(page.getByRole("button", { name: "Stop turn" })).waitFor({
    state: "hidden",
    timeout: TURN_MS,
  });
  note("Codex finished turn 1 with done");

  // The view's own address.
  await go(`/sessions/${id}/record`);
  const tab = visible(page.locator(`[data-tab="${VIEW}"]`).getByRole("tab"));
  await tab.waitFor();
  note(
    `/sessions/<id>/record: the Record tab is selected (${await tab.getAttribute("aria-selected")})`,
  );
  const body = visible(page.locator(`[data-tab-body="${VIEW}"]`));
  const list = body.getByRole("list", { name: "The session's record, newest first" });
  await list.waitFor({ timeout: 60_000 });
  const rowTexts = async () =>
    Promise.all((await list.getByRole("listitem").all()).map((row) => textOf(row)));
  for (const row of await rowTexts()) note(`row: ${JSON.stringify(row)}`);
  note(`foot: ${JSON.stringify(await textOf(body.locator("p").last()))}`);
  await both("box-record-desktop");

  // Filters.
  const filters = body.getByRole("tablist", { name: "Show" });
  for (const name of ["Commands", "Checkpoints", "All"]) {
    await filters.getByRole("tab", { name, exact: true }).click();
    await settled();
    note(
      name === "All"
        ? "All again"
        : `${name}: ${JSON.stringify((await list.count()) > 0 ? await rowTexts() : await textOf(body))}`,
    );
    if (name === "Commands") await capture("box-record-commands-light");
  }

  // A command's row opens to what the record holds of it.
  const failing = list.getByRole("button", { name: /^\S+ Command .*echo 3 tests passed/ });
  await failing.click();
  if ((await failing.getAttribute("aria-expanded")) !== "true")
    throw new Error("the command's row didn't open");
  note(`the failing command's row, open: ${JSON.stringify(await textOf(failing.locator("..")))}`);
  await capture("box-record-row-open-light");
  await failing.click();

  // A pull request's link to a checkpoint, loaded from scratch.
  const detail = await client(
    async (trpc, session) => trpc.sessions.detail.query({ id: session }),
    id,
  );
  const ordinals = (detail?.checkpoints ?? []).map((checkpoint) => checkpoint.ordinal);
  note(`the session's checkpoints: ${JSON.stringify(ordinals)}`);
  const target = Math.max(...ordinals);
  await page.goto(`${web}/sessions/${id}#checkpoint-${target}`);
  await page.waitForURL(`**/sessions/${id}/record#checkpoint-${target}`, { timeout: 30_000 });
  await hydrated();
  const banner = visible(body.getByText(/^You opened checkpoint/));
  await banner.waitFor({ timeout: 60_000 });
  const markedRow = visible(body.locator('li[aria-current="location"]'));
  await markedRow.waitFor();
  const inView = await markedRow.evaluate((row) => {
    const box = row.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });
  note(
    `#checkpoint-${target} moved to ${new URL(page.url()).pathname}${new URL(page.url()).hash}; banner ${JSON.stringify(await textOf(banner.locator("..")))}; marked row ${JSON.stringify(await textOf(markedRow))}, in view: ${inView}`,
  );
  await both("box-record-at-checkpoint");
  await visible(body.getByRole("button", { name: "Clear the mark" })).click();
  await page.waitForURL((url) => url.hash === "", { timeout: 10_000 });
  note(
    `Clear the mark: the address is ${new URL(page.url()).pathname} and no row is marked (${await body.locator('li[aria-current="location"]').count()})`,
  );

  // Mark a checkpoint by hand.
  const markButton = visible(body.getByRole("button", { name: "Mark a checkpoint" }));
  if ((await markButton.count()) > 0) {
    await markButton.click();
    await visible(list.getByText(/marked by hand/)).waitFor({ timeout: 60_000 });
    note(
      `Mark a checkpoint: ${JSON.stringify((await rowTexts()).find((row) => row.includes("marked by hand")))}`,
    );
  } else note("Mark a checkpoint: not offered (the agent isn't live)");

  // 390px.
  await page.setViewportSize(PHONE);
  await settled();
  await visible(list).waitFor();
  note(
    `at 390px the page is ${await page.evaluate(() => document.documentElement.scrollWidth)}px wide`,
  );
  await capture("box-record-phone-light");
  await page.setViewportSize(DESKTOP);

  // Fixtures over this session's record reads.
  let state = null;
  const { promise: held, resolve: release } = Promise.withResolvers();
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    // An empty record empties every read the page draws rows from: with no turns the page reads
    // the session as a terminal one and falls back to its transcript, and the checkpoints come
    // from the session's detail and the screen's rows from its log.
    const ours = paths.map((path, index) => {
      const input = inputs[String(index)]?.json ?? inputs.json;
      if (state === null || input?.id !== id) return null;
      if (path.startsWith("sessions.history")) return path;
      return state === "empty" && EMPTIED.has(path) ? path : null;
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
      else if (state === "empty" && path in empty)
        answers[index] = { result: { data: empty[path] } };
      else if (state === "empty") answers[index] = emptied(path, answers[index]);
      else if (state === "earlier" && path === "sessions.historyItems")
        answers[index].result.data.json.next = "fixture-cursor";
    });
    await route.fulfill({ response, json: Array.isArray(answer) ? answers : answers[0] });
  });
  const forget = () =>
    page.evaluate(() => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      queryClient.removeQueries({ queryKey: [["sessions", "historyItems"]] });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: [["sessions"]] }),
        queryClient.invalidateQueries({ queryKey: [["screens", "log"]] }),
      ]);
    });

  state = "earlier";
  await forget();
  await visible(body.getByRole("button", { name: "Read earlier history" })).waitFor({
    timeout: 30_000,
  });
  note(
    `fixture, earlier history unread: ${JSON.stringify(await textOf(visible(body.getByText(/^This is the record so far/)).locator("..")))}`,
  );
  await capture("fixture-record-earlier-light");

  state = "hold";
  await forget();
  await visible(body.getByText("Reading the record…")).waitFor({ timeout: 30_000 });
  note('fixture, the record being read: "Reading the record…"');
  await capture("fixture-record-loading-light");
  state = "fail";
  release();
  await forget();
  await visible(body.getByText("This didn't load.")).waitFor({ timeout: 30_000 });
  note(`fixture, a failed read: ${JSON.stringify(await textOf(visible(body.getByRole("alert"))))}`);
  await both("fixture-record-failed");

  state = "empty";
  await visible(body.getByRole("button", { name: "Try again" })).click();
  await page.evaluate(() => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: [["sessions", "detail"]] }),
      queryClient.invalidateQueries({ queryKey: [["screens", "log"]] }),
    ]);
  });
  await visible(body.getByText(/^Nothing in the record yet/))
    .waitFor({ timeout: 30_000 })
    .catch(async () => {
      await capture("fixture-record-empty-light");
      throw new Error(
        `the empty record didn't show; the view reads ${JSON.stringify(await textOf(body))}`,
      );
    });
  note(`fixture, Try again into an empty record: ${JSON.stringify(await textOf(body))}`);
  await capture("fixture-record-empty-light");
  state = null;
  await forget();
  await list.waitFor({ timeout: 30_000 });
  note(`back to the real record with ${await list.getByRole("listitem").count()} rows`);
  await page.unroute("**/trpc/**");

  await client(async (trpc, session) => trpc.sessions.stop.mutate({ id: session }), id);
  note(`stopped session ${id}`);
};
