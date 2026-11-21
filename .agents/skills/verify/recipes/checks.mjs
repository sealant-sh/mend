// The Checks view (apps/web, route PR 21, SLNT-1157, ADR 0026, Doop T10 "Terminal and checks in
// one tile"): the tests, typechecks, lints and builds the agent ran, the latest run of each, newest
// first, with how each ended, how long it took and the checkpoint it ran after; and whether edits
// came after the last of them. The view's own address opens the session with the Checks tab
// focused; the tab and the tile's "+" carry the fact ("1 failed"); the view reads the record, says
// so while it does, says when it holds no check, offers the record's earlier windows, and says when
// it couldn't read with Try again. Run the CLI batch first, once per stack: it starts a `sleep`
// session in `checks-ws`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/checks-sessions.json
//   pnpm verify drive web --recipe checks
//
// A `sleep` session runs no agent, so its record holds no command: the record's windows and the
// session's checkpoints are fixture answers laid over the real session's reads (Codex's
// `commandExecution` items with their exit codes and durations, and Claude's `tool_use`, which
// carries none).
import { existsSync } from "node:fs";
import { join } from "node:path";

import { history, item } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Fix flaky checkout retry";
const VIEW = "view:checks";

const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

const at = (minute) => `2026-11-18T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** The record a Codex turn and a Claude turn leave: checks, edits after them, and other steps. */
const record = () => {
  const codex = (command, minute, exitCode, durationMs, status = "completed") =>
    item("fixture-turn-1", "command-execution", status, at(minute), at(minute), {
      title: command,
      data: {
        type: "commandExecution",
        command,
        ...(exitCode === null ? {} : { exitCode }),
        ...(durationMs === null ? {} : { durationMs }),
      },
    });
  const claude = (command, minute) =>
    item("fixture-turn-1", "command-execution", "completed", at(minute), at(minute), {
      title: "Bash",
      data: { type: "tool_use", name: "Bash", input: { command } },
    });
  const edit = (path, minute) =>
    item("fixture-turn-1", "file-change", "completed", at(minute), at(minute), {
      title: path,
      data: { path },
    });
  return [
    edit("src/payments/retry.ts", 1),
    codex("pnpm vitest run src/payments", 5, 1, 38_000),
    edit("src/payments/retry.ts", 6),
    codex("pnpm vitest run src/payments", 8, 0, 41_200),
    codex("pnpm exec tsc --noEmit", 9, 0, 6_100),
    codex("pnpm exec oxlint src", 10, 1, 2_300),
    claude("pnpm run build", 11),
    codex("ls -la src/payments", 12, 0, 40),
    edit("src/payments/backoff.ts", 13),
    edit("src/payments/retry.ts", 14),
  ];
};

const turns = (me) => [
  {
    id: "fixture-turn-1",
    sessionId: "fixture",
    ordinal: 0,
    origin: "request",
    author: me,
    billedUserId: me,
    billedAccountName: null,
    steerSender: null,
    fromSteer: null,
    clientMessageId: null,
    steers: [],
    input: "Fix the flaky checkout retry and run the checks.",
    status: "completed",
    error: null,
    createdAt: at(0),
    startedAt: at(0),
    endedAt: at(15),
    unreachable: null,
  },
];

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
      [...document.querySelectorAll("a[href], button")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
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
  /** Moves to `path` through the router: fixtures don't reach the server's own render. */
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), path);
  /** Forgets the record and the detail, so the next look reads them again through the fixtures. */
  const forget = () =>
    page.evaluate(() => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      queryClient.removeQueries({ queryKey: [["sessions", "historyItems"]] });
      return queryClient.invalidateQueries({ queryKey: [["sessions"]] });
    });
  const tab = () => page.locator(`[data-tab="${VIEW}"]`).filter({ visible: true }).getByRole("tab");
  const body = page.locator(`[data-tab-body="${VIEW}"]`).filter({ visible: true });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  const session = rows?.find(
    (row) =>
      row.worktreeName === "checks-ws" &&
      !["completed", "stopped", "failed"].includes(row.session.status),
  )?.session;
  if (session === undefined)
    throw new Error("checks-ws has no running session: run the CLI batch first");
  const me = session.ownerUserId;
  await client(
    async (trpc, [id, label]) => trpc.sessions.setLabel.mutate({ id, label }),
    [session.id, TITLE],
  );
  note(`the batch session is ${session.id} in checks-ws`);

  // What the fixtures answer now: the record, an empty one, one with earlier windows, a read held
  // open, or a failure.
  let state = "record";
  const { promise: held, resolve: release } = Promise.withResolvers();
  const checkpointsOf = (data) => {
    // The worktree's start checkpoint, and five more taken through the turn.
    const json = structuredClone(data.json);
    const values = { ...data.meta?.values };
    const start = json.checkpoints[0];
    if (start === undefined) return data;
    json.checkpoints = [0, 1, 2, 3, 4, 5].map((ordinal) => ({
      ...start,
      id: ordinal === 0 ? start.id : `${start.id}-fixture-${ordinal}`,
      ordinal,
      createdAt: ordinal === 0 ? start.createdAt : at([0, 1, 4, 7, 8, 9][ordinal]),
    }));
    for (const key of Object.keys(values)) if (key.startsWith("checkpoints.")) delete values[key];
    json.checkpoints.forEach((_, index) => {
      values[`checkpoints.${index}.createdAt`] = ["Date"];
    });
    return { json, meta: { ...data.meta, values } };
  };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const ours = paths.map((path, index) => {
      const input = inputs[String(index)]?.json ?? inputs.json;
      return input?.id === session.id ? path : null;
    });
    if (ours.every((path) => path === null)) return route.continue();
    if (state === "hold" && ours.some((path) => path?.startsWith("sessions.history"))) await held;
    const response = await route.fetch();
    const answer = await response.json();
    const answers = Array.isArray(answer) ? answer : [answer];
    const items =
      state === "empty" ? [] : record().filter((_, index) => state !== "earlier" || index >= 7);
    const windows = history({ turns: turns(me), items });
    if (state === "earlier") windows["sessions.historyItems"].json.next = "fixture-cursor";
    ours.forEach((path, index) => {
      if (path === null) return;
      if (path === "sessions.detail" && answers[index]?.result?.data !== undefined)
        answers[index] = { result: { data: checkpointsOf(answers[index].result.data) } };
      else if (path in windows)
        answers[index] = state === "fail" ? failure(path) : { result: { data: windows[path] } };
    });
    await route.fulfill({ response, json: Array.isArray(answer) ? answers : answers[0] });
  });

  // The view's own address: the session with the Checks tab showing.
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.goto(`${web}/sessions/${session.id}/checks`);
  await hydrated();
  await tab().waitFor();
  if ((await tab().getAttribute("aria-selected")) !== "true")
    throw new Error("the Checks tab isn't the one showing");
  await forget();
  const list = body.getByRole("list", { name: "Checks" });
  await list.waitFor();
  await body.getByText("Lint failed after checkpoint 5").waitFor();
  note(
    `/sessions/<id>/checks: the Checks tab shows; its tab reads ${JSON.stringify(await textOf(tab()))}`,
  );
  for (const row of await list.getByRole("listitem").all())
    note(`check: ${JSON.stringify(await textOf(row))}`);
  note(`after the list: ${JSON.stringify(await textOf(body.getByText(/^No check ran after/)))}`);
  await both("checks-desktop");

  // The tile's "+" lists Checks with the same fact.
  await page.getByRole("button", { name: "Open a view" }).filter({ visible: true }).first().click();
  const menu = page.getByRole("menu").filter({ visible: true }).last();
  await menu.waitFor();
  note(`the "+" menu: ${JSON.stringify(await textOf(menu))}`);
  await capture("checks-open-menu-light");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  // Earlier windows of the record not read yet: the view offers them.
  state = "earlier";
  await forget();
  const readEarlier = body.getByRole("button", { name: "Read earlier history" });
  await readEarlier.waitFor();
  note(`with earlier history unread: ${JSON.stringify(await textOf(body))}`);
  await capture("checks-earlier-light");

  // Nothing checked yet.
  state = "empty";
  await forget();
  await body.getByText(/^No test, typecheck, lint or build/).waitFor();
  note(`empty: ${JSON.stringify(await textOf(body))}`);
  await capture("checks-empty-light");

  // The record still being read.
  state = "hold";
  await forget();
  await body.getByText("Reading the record…").waitFor();
  note(`loading: ${JSON.stringify(await textOf(body))}`);
  await capture("checks-loading-light");
  release();

  // The record couldn't be read: Try again reads it.
  state = "fail";
  await forget();
  await body.getByText("This didn't load.").waitFor({ timeout: 30_000 });
  note(`failed: ${JSON.stringify(await textOf(body))}`);
  await both("checks-failed");
  state = "record";
  await body.getByRole("button", { name: "Try again" }).click();
  await list.waitFor({ timeout: 30_000 });
  note("Try again: the list is back");

  // The phone: the view in the tab strip.
  await page.setViewportSize(PHONE);
  await settled();
  await list.waitFor();
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`checks-phone-${theme}`);
  }
  await setTheme("light");
  await page.setViewportSize(DESKTOP);

  await page.unroute("**/trpc/**");
  await go("/");
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), session.id).catch((cause) =>
    note(`stopping the batch session: ${String(cause)}`),
  );
  note("stopped the batch session");
};
