// The owner's pass, 20 Nov (SLNT-1210, SLNT-1212): the sheet's rounded corners on a session's, a
// project's and a settings page, light and dark; opening Mend at / while setup isn't finished goes
// to the next step, and never for someone past setup; Stop shows at once, goes back when the
// server refuses, and holds once it took; toasts in the bottom-right corner, never over a
// composer. Run the CLI batch once per stack first: it starts the session the recipe stops.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-sheet-stop-setup-sessions.json
//   pnpm verify drive new-web --recipe new-web-sheet-stop-setup
//
// The stop's answer is held while the recipe looks, then failed on purpose once (no request
// reaches the server), then let through. Setup's unfinished states are fixtures laid over the
// browser's reads (`git.access`, `projects.list`); the session page's picture is the stopped
// session's page with its detail and history answered as an agent's conversation (a command's
// terminal is a canvas the driver won't picture). A run puts the session back first, so it can
// run again.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { empty, patchDetail } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Stop me at once";
const WORKTREE = "pass-stop";

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  // The driver withholds a picture when the page inserts a subtree while it looks: look again.
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(400);
    }
  };
  const failures = [];
  const expect = (ok, what) => {
    note(`${ok ? "yes" : "NO"} · ${what}`);
    if (!ok) failures.push(what);
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
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => {
        const control = document.querySelector("a[href], button");
        return (
          control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"))
        );
      },
      null,
      { timeout: 90_000 },
    );
    await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await settled();
  };
  /** Moves within the app through its router, as a link does: loaders run in the browser. */
  const go = async (path) => {
    await page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ to }), path);
    await settled();
  };
  const path = () => new URL(page.url()).pathname;
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const forget = (queryKey) =>
    page.evaluate((key) => {
      window["__TSR_ROUTER__"].options.context.queryClient.removeQueries({ queryKey: key });
    }, queryKey);
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
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const group = (name) => inbox().getByRole("region", { name, exact: true });
  const unfold = async (name) => {
    const heading = group(name).getByRole("button", { name: new RegExp(`^${name}`) });
    if ((await heading.count()) === 0) return;
    if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
  };
  const toasts = () => page.getByRole("region", { name: /Notifications/ });
  const toastSaying = (words) => toasts().getByText(words, { exact: false });
  /** The front toast's box against the window, and whether it overlaps a composer card. */
  const toastPlace = () =>
    page.evaluate(() => {
      const toast = document.querySelector("[data-slot=toast]");
      if (toast === null) return null;
      const box = toast.getBoundingClientRect();
      const overlaps = [...document.querySelectorAll("[data-slot=composer-card]")].some((card) => {
        const other = card.getBoundingClientRect();
        if (other.height === 0) return false;
        return (
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top
        );
      });
      return {
        right: window.innerWidth - box.right,
        bottom: window.innerHeight - box.bottom,
        left: box.left,
        overlaps,
      };
    });
  const tRPCError = (path, message) => ({
    error: {
      json: {
        message,
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
      },
    },
  });

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The batch's session, running: one an earlier drive stopped resumes as a shell first.
  const find = async () => (await readRows()).find((row) => row.worktreeName === WORKTREE);
  let row = await find();
  if (row === undefined) throw new Error(`no session in ${WORKTREE}: run the CLI batch first`);
  if (["completed", "stopped", "failed"].includes(row.session.status)) {
    await client(async (trpc, id) => {
      await trpc.sessions.resume.mutate({ id, request: { harness: "shell" } });
    }, row.session.id);
    note("resumed the session an earlier drive stopped");
    for (let tries = 0; tries < 30; tries += 1) {
      row = await find();
      if (row?.session.status === "running") break;
      await page.waitForTimeout(1_000);
    }
  }
  const id = row.session.id;
  const projectId = row.session.projectId;
  await client(async (trpc, value) => trpc.sessions.setLabel.mutate(value), { id, label: TITLE });
  const rowIn = (name) => group(name).locator(`[data-session-id="${id}"]`);

  // 1. Opening Mend at / for someone past setup (this account: Git access and a project) stays
  //    on Mend, on a full load (the server decides) and moving there within the app.
  await open("/");
  expect(path() === "/", "a full load of / opens Mend for someone past setup");
  await open("/projects");
  await go("/");
  expect(path() === "/", "moving to / within Mend opens Mend for someone past setup");

  // 2. Someone who closed the tab partway through setup: Git access in place, no project yet.
  let setupFixture = { projects: false, gitFails: false };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const faked = paths.map(
      (each) =>
        (each === "projects.list" && setupFixture.projects) ||
        (each === "git.access" && setupFixture.gitFails),
    );
    if (!faked.some(Boolean)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((each, index) => {
      if (!faked[index]) return;
      answers[index] =
        each === "projects.list"
          ? { result: { data: { json: [] } } }
          : tRPCError(each, "The verify recipe failed this read on purpose.");
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });
  const fromProjects = async (name) => {
    await open("/projects");
    await forget([["projects", "list"]]);
    await forget([["git", "access"]]);
    await go("/");
    await page.waitForTimeout(1_500);
    note(`${name}: / went to ${path()}`);
    return path();
  };
  setupFixture = { projects: true, gitFails: false };
  const resumed = await fromProjects("no project yet");
  expect(
    resumed.startsWith("/welcome/"),
    "/ opens setup's next step for someone without a project",
  );
  await hydrated();
  await capture("setup-resumed-light");

  // Reached setup's last step in this browser (a member who skipped First project): Mend.
  const viewer = await page.evaluate(
    () =>
      window["__TSR_ROUTER__"].options.context.queryClient
        .getQueryCache()
        .findAll({ queryKey: [["organization", "current"]] })[0]?.state.data?.userId,
  );
  await page.context().addCookies([
    {
      name: "mend-setup",
      value: encodeURIComponent(JSON.stringify({ skippedCommandLine: [], ended: [viewer] })),
      url: web,
    },
  ]);
  expect(
    (await fromProjects("setup ended here, no project")) === "/",
    "/ opens Mend for someone who reached setup's last step in this browser",
  );
  await page.context().clearCookies({ name: "mend-setup" });

  // Setup that can't be read falls through to Mend.
  setupFixture = { projects: true, gitFails: true };
  expect((await fromProjects("setup unreadable")) === "/", "/ opens Mend when setup can't be read");
  setupFixture = { projects: false, gitFails: false };
  await page.unroute("**/trpc/**");

  // 3. Stop from the sidebar row's menu, with Mend's answer held: the row is Stopped at once.
  let release = () => undefined;
  let stopAnswer = "fail";
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (!paths.includes("sessions.stop")) return route.continue();
    await new Promise((resolve) => {
      release = resolve;
    });
    if (stopAnswer === "pass") return route.continue();
    await route.fulfill({
      status: 500,
      json: paths.map((each) => tRPCError(each, "Mend couldn't reach the workspace.")),
    });
  });
  await open("/projects");
  for (const name of ["Running", "To review", "Done"]) await unfold(name);
  await rowIn("Running").waitFor();
  const stopFromRow = async () => {
    await rowIn("Running").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Stop session…" }).click();
    const dialog = page.getByRole("dialog", { name: "Stop session?" });
    await dialog.getByRole("button", { name: "Stop session" }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  await stopFromRow();
  const ended = rowIn("Done").or(rowIn("To review"));
  await ended.waitFor({ timeout: 2_000 });
  expect(
    (await rowIn("Running").count()) === 0 && (await ended.count()) === 1,
    "the row left Running for Done or To review the moment Stop was confirmed",
  );
  expect(
    /Stopped/.test(await ended.first().innerText()),
    "the row reads Stopped while Mend's answer is on its way",
  );
  await page.mouse.move(DESKTOP.width / 2, DESKTOP.height - 4);
  await both("stop-at-once");

  // The server refuses: the row goes back to Running, and a toast says so with Try again.
  release();
  await toastSaying("didn't stop").waitFor();
  await rowIn("Running").waitFor();
  expect((await ended.count()) === 0, "a refused stop puts the row back under Running");
  const failedToast = await toastPlace();
  note(`refused toast: ${JSON.stringify(failedToast)}`);
  expect(
    failedToast !== null && Math.abs(failedToast.right - 24) <= 2 && failedToast.bottom <= 30,
    "the toast sits in the bottom-right corner",
  );
  await both("stop-refused");

  // Try again, let through: Stopped at once again, then Mend's own word in a toast.
  stopAnswer = "pass";
  await toasts().getByRole("button", { name: "Try again" }).click();
  await ended.waitFor({ timeout: 2_000 });
  expect((await rowIn("Running").count()) === 0, "Try again shows the stop at once too");
  release();
  await toastSaying(`Stopped "${TITLE}"`).waitFor({ timeout: 30_000 });
  await page.unroute("**/trpc/**");
  await page.waitForTimeout(3_000);
  const after = await find();
  expect(
    after !== undefined && ["stopped", "completed"].includes(after.session.status),
    `Mend says the session ended (${after?.session.status})`,
  );
  expect((await ended.count()) === 1, "the row stays where the stop put it");
  await capture("stopped-toast-light");

  // 4. The sheet's corners: the sheet clips what it holds to its radius, on every page; no focus
  //    ring inside it is cut by it.
  const sheetClip = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-slot=sidebar-inset]");
      if (sheet === null) return null;
      const style = getComputedStyle(sheet);
      return { overflow: style.overflow, radius: style.borderTopLeftRadius };
    });
  const ringsCutBySheet = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-slot=sidebar-inset]");
      if (sheet === null) return [];
      const outer = sheet.getBoundingClientRect();
      const cut = [];
      for (const control of sheet.querySelectorAll("a[href], button, input, [tabindex]")) {
        const box = control.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        // Cut by the sheet itself only when no scroller between them clips it first.
        let up = control.parentElement;
        let scroller = false;
        while (up !== null && up !== sheet) {
          const style = getComputedStyle(up);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") scroller = true;
          up = up.parentElement;
        }
        if (scroller) continue;
        if (
          box.left - 3 < outer.left + 1 ||
          box.right + 3 > outer.right - 1 ||
          box.top - 3 < outer.top + 1 ||
          box.bottom + 3 > outer.bottom - 1
        )
          cut.push((control.getAttribute("aria-label") ?? control.textContent ?? "").trim());
      }
      return cut;
    });
  const corners = async (name, ready) => {
    await ready();
    const clip = await sheetClip();
    expect(
      clip?.overflow === "hidden" && clip.radius !== "0px",
      `${name}: the sheet clips to its ${clip?.radius} corners`,
    );
    const cut = await ringsCutBySheet();
    expect(cut.length === 0, `${name}: no focus ring cut by the sheet (${cut.join(", ")})`);
    await page.mouse.move(DESKTOP.width - 4, DESKTOP.height - 4);
    await both(`corners-${name}`);
  };

  // The session's page, its detail and history answered as an agent's finished conversation.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map(
      (each, index) =>
        inputs[String(index)]?.json?.id === id &&
        (each === "sessions.detail" || each.startsWith("sessions.history")),
    );
    if (!mine.some(Boolean)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    const history = empty();
    paths.forEach((each, index) => {
      if (!mine[index]) return;
      answers[index] =
        each === "sessions.detail"
          ? {
              result: {
                data: patchDetail(answers[index].result.data, {
                  status: "completed",
                  harness: "claude",
                  dropAgent: true,
                }),
              },
            }
          : { result: { data: history[each] } };
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });
  await open("/no-such-page");
  await go(`/sessions/${id}`);
  await corners("session", () =>
    page.locator("[data-slot=workspace-header]").filter({ visible: true }).first().waitFor(),
  );

  // Toasts beside the session's composer: Copy branch name from the workspace's "…".
  const copyToast = async (name) => {
    const more = page
      .locator("[data-slot=workspace-header]")
      .filter({ visible: true })
      .getByRole("button", { name: /More|Workspace actions|…/ })
      .first();
    if ((await more.count()) === 0) {
      note(`${name}: no workspace "…" to raise a toast from`);
      return;
    }
    await more.click();
    // A menu on a wide screen, a sheet of rows on a phone.
    await page
      .getByRole("menuitem", { name: /Copy branch name/ })
      .or(page.getByRole("button", { name: /Copy branch name/ }))
      .filter({ visible: true })
      .first()
      .click();
    await toasts().locator("[data-slot=toast]").first().waitFor();
    await settled();
    const place = await toastPlace();
    note(`${name} toast: ${JSON.stringify(place)}`);
    expect(place !== null && !place.overlaps, `${name}: the toast covers no composer`);
    await capture(`toast-${name}-light`);
  };
  await copyToast("session-desktop");
  await page.setViewportSize(PHONE);
  await settled();
  await copyToast("session-phone");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");

  await open(`/projects/${projectId}`);
  await corners("project", () => page.getByRole("heading").first().waitFor());
  await open("/settings/profile");
  await corners("settings", () => page.getByRole("heading").first().waitFor());

  if (failures.length > 0) throw new Error(`not as expected: ${failures.join("; ")}`);
};
