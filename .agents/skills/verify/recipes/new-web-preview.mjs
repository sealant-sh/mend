// The Preview view (apps/web, route PR 18, SLNT-1150, ADR 0026): this workspace's services and the
// page one of them serves. The view's own address opens the session with the Preview tab focused;
// the list shows the recipes `.mend/mend.toml` declares (services.md, mend-toml.md
// `toml-recipes-card`); Start runs one (`service-recipe`) and the tab shows its port; its page opens
// (`service-run-web`, a real request to the Service); the address bar takes a path; the log replays
// and follows (`service-logs`); Restart service… and Stop (`service-restart-stop`); Run a command…
// runs a one-off command (`service-run-web`) and, empty, adopts a port (`service-add`); a recipe
// that fails says so (`service-observe`); a Mend-served preview on another site, and the file that
// doesn't parse (`toml-parse-error`), as fixtures; the phone's picker; the view's failure; and the
// workspace stopped by Stop session. Run the CLI batch first, once per run: it starts two `sleep`
// sessions in a new worktree `preview-ws-<time>`, whose `.mend/mend.toml` declares `web` (python3's
// http.server on 8000) and `broken` (exits 3).
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-preview-sessions.json
//   pnpm verify drive new-web --recipe new-web-preview
//
// The driver withholds a picture with an iframe in it. The new app is served at
// http://localhost here, and Mend frames a preview only from an https page on the preview site
// (SLNT-742), so no state here holds a frame; the framed page is covered by preview-page.test.tsx.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Fix flaky checkout retry";
const VIEW = "view:preview";

const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

/** A tRPC answer that failed on purpose, as the server words one. */
const failed = (message) => (_answer, procedure) => ({
  error: {
    json: {
      message,
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
    },
  },
});

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const dismissOverlay = () =>
    page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
  /** How many times the page's DOM gained or lost nodes in one second. */
  const changesInASecond = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let changes = 0;
          const observer = new MutationObserver((records) => {
            changes += records.length;
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(changes);
          }, 1_000);
        }),
    );
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  // The driver may withhold a picture when the page changes while it looks: look again.
  const capture = async (name) => {
    await dismissOverlay();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await still();
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
    // The desktop sidebar's wrapper is 2px taller than the window: clip it for the capture.
    await page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
    await page.mouse.move(1, 1);
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
  const body = page.locator(`[data-tab-body="${VIEW}"]`).filter({ visible: true });
  const list = body.getByRole("navigation", { name: "This workspace's services" });
  const pane = body.getByRole("status").first();
  const waitText = (pattern, timeout = 90_000) =>
    page.waitForFunction(
      ([key, source]) => {
        const view = [...document.querySelectorAll(`[data-tab-body="${key}"]`)].find(
          (each) => each.getClientRects().length > 0,
        );
        return view !== undefined && new RegExp(source).test(view.textContent ?? "");
      },
      [VIEW, pattern.source],
      { timeout },
    );

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The session the CLI batch started, in the newest `preview-ws-<time>`.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const running = rows
    .filter(
      (row) =>
        /^preview-ws-\d+$/.test(row.worktreeName ?? "") &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )
    .toSorted((a, b) => String(b.session.createdAt).localeCompare(String(a.session.createdAt)));
  // The newest worktree's two sessions: A wrote the file, B keeps it company.
  const worktree = running[0]?.worktreeName;
  const pair = running
    .filter((row) => row.worktreeName === worktree)
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)));
  if (running.length === 0)
    throw new Error("no preview-ws-<time> worktree has a running session: run the CLI batch first");
  if (pair.length !== 2) throw new Error(`${worktree} has ${pair.length} running sessions, not 2`);
  const A = pair[0].session.id;
  const B = pair[1].session.id;
  note(`the batch sessions are ${A} and ${B} in ${worktree}; the recipe stops both at the end`);
  await client(
    async (trpc, [id, label]) => trpc.sessions.setLabel.mutate({ id, label }),
    [A, TITLE],
  );
  // The newest batch session's worktree is new, so its list starts from the file. Services a
  // failed drive left running in it are stopped first.
  const left = await client(
    async (trpc, id) =>
      (await trpc.services.list.query({ all: true })).filter(
        (view) => view.service.sessionId === id && view.currentForward?.state === "bound",
      ),
    A,
  );
  for (const view of left)
    await client(async (trpc, id) => trpc.services.stop.mutate({ id }), view.service.id);
  await page.context().clearCookies({ name: "mend-tiles" });

  // The view's own address: the session with the Preview tab showing.
  await open(`/sessions/${A}/preview`);
  await tabOf(VIEW).waitFor();
  if ((await tabOf(VIEW).getAttribute("aria-selected")) !== "true")
    throw new Error("the Preview tab isn't the one showing");
  await list.waitFor();
  // The file's recipes: read from the live workspace.
  await list.getByRole("button", { name: "Start web" }).waitFor({ timeout: 60_000 });
  note(
    `/sessions/<id>/preview: the Preview tab shows; the list reads ${JSON.stringify(await textOf(list))}`,
  );
  note(`pane before a start: ${JSON.stringify(await textOf(pane))}`);
  await waitText(
    /Both sessions in preview-ws-\d+ use these services\. If you restart one, it restarts for both\./,
  );
  note(
    'the list\'s foot: "Both sessions in <worktree> use these services. If you restart one, it restarts for both."',
  );
  await both("preview-recipes");

  // Start web from the file: Starting, then Running, picked, with its port on the tab.
  await list.getByRole("button", { name: "Start web" }).click();
  await list.getByRole("button", { name: "Start web" }).filter({ hasText: "Starting…" }).waitFor();
  note("Start web reads Starting… on the button while Mend waits for :8000");
  await list.getByRole("button", { name: /^web :8000 Running/ }).waitFor({ timeout: 120_000 });
  await waitText(/Open in a new tab/);
  const tab = await textOf(tabOf(VIEW));
  if (!tab.includes(":8000")) throw new Error(`the Preview tab reads "${tab}", not its port`);
  note(
    `web is Running; the tab reads "${tab}"; the pane reads ${JSON.stringify((await textOf(body)).slice(0, 400))}`,
  );
  await both("preview-running");

  // Its page: Open in a new tab goes to the Service's own address. (The stack's Services bind
  // inside its container, which this machine's browser can't reach: the request below, from inside
  // the workspace, is what shows the Service answering.)
  const link = body.getByRole("link", { name: "Open in a new tab" });
  if ((await link.count()) !== 1) throw new Error("more than one Open in a new tab");
  const href = await link.getAttribute("href");
  if (!/^http:\/\/[^/]+:\d+\/$/.test(href ?? "")) throw new Error(`Open goes to ${href}`);
  const opened = page.context().waitForEvent("page", { timeout: 15_000 });
  await link.click();
  const tabPage = await opened;
  // The tab starts at about:blank, and doesn't load: wait for it to name its address.
  await tabPage
    .waitForURL(/^http/, { timeout: 10_000, waitUntil: "commit" })
    .catch(() => undefined);
  const tabUrl = tabPage.url();
  await tabPage.close();
  note(`Open in a new tab: a new tab opened at ${tabUrl} (the link's address is ${href})`);

  // The address bar takes a path: the link goes there.
  const path = body.getByRole("textbox", { name: "Path on web" });
  await path.fill("/.mend/");
  await path.press("Enter");
  const pathed = await link.getAttribute("href");
  if (!pathed?.endsWith("/.mend/")) throw new Error(`the path went nowhere: ${pathed}`);
  note(`typed /.mend/ in the address bar: the page's link is now ${pathed}`);
  await path.fill("/");
  await path.press("Enter");

  // Run a command…: a one-off Service, nothing saved. It asks web for its page first, from inside
  // the workspace, and prints what web answered.
  await list.getByRole("button", { name: "Run a command…" }).click();
  const run = page.getByRole("dialog", { name: "Run a command" });
  await run.waitFor();
  await run
    .getByRole("textbox", { name: "Command" })
    .fill(
      "python3 -c \"import urllib.request as u; print('web answered', u.urlopen('http://127.0.0.1:8000/').status)\" && exec python3 -m http.server 8002",
    );
  await run.getByRole("textbox", { name: "Port" }).fill("8002");
  await run.getByRole("textbox", { name: "Name" }).fill("docs");
  await settled();
  await both("preview-run-command");
  await run.getByRole("button", { name: "Run", exact: true }).click();
  await run.waitFor({ state: "detached", timeout: 90_000 });
  const docs = list.getByRole("button", { name: /^docs :8002/ });
  await docs.waitFor({ timeout: 60_000 });
  if ((await docs.getAttribute("aria-current")) !== "true")
    throw new Error("the command's Service isn't the one showing");
  note(`Run a command: docs started and shows: ${JSON.stringify(await textOf(docs))}`);
  const logs = body.getByRole("button", { name: /^Logs/ });
  const logBarSays = (pattern) =>
    page.waitForFunction(
      ([key, source]) =>
        new RegExp(source).test(
          [...document.querySelectorAll(`[data-tab-body="${key}"] button`)].find(
            (each) =>
              each.getClientRects().length > 0 && (each.textContent ?? "").startsWith("Logs"),
          )?.textContent ?? "",
        ),
      [VIEW, pattern.source],
      { timeout: 60_000 },
    );
  await logBarSays(/web answered 200|Serving HTTP/);
  await logs.click();
  await waitText(/web answered 200/, 30_000);
  note(
    `docs's log: ${JSON.stringify((await textOf(body.getByRole("region", { name: "docs's log" }))).slice(0, 300))}`,
  );
  await logs.click();

  // web's log: the request docs made, newest on the bar, the whole output when opened.
  await list.getByRole("button", { name: /^web :8000/ }).click();
  await logBarSays(/GET \/ HTTP\/1\.1" 200/);
  note(`web's Logs bar reads ${JSON.stringify(await textOf(logs))}`);
  await logs.click();
  const log = body.getByRole("region", { name: "web's log" });
  await log.waitFor();
  await waitText(/Serving HTTP on/);
  note(`web's log, opened: ${JSON.stringify((await textOf(log)).slice(0, 400))}`);
  await both("preview-log");
  await logs.click();

  // Restart service…: a dialog that says who else uses it, then Running again.
  await body.getByRole("button", { name: "Restart service…" }).click();
  const restart = page.getByRole("dialog", { name: "Restart web?" });
  await restart.waitFor();
  note(`Restart dialog: ${JSON.stringify(await textOf(restart))}`);
  if (
    !/Every session in this workspace uses it, so it restarts for them too/.test(
      await textOf(restart),
    )
  )
    throw new Error("the Restart dialog doesn't say the other session uses it");
  await settled();
  await both("preview-restart-dialog");
  await restart.getByRole("button", { name: "Restart", exact: true }).click();
  await restart.waitFor({ state: "detached", timeout: 90_000 });
  await list.getByRole("button", { name: /^web :8000 Running/ }).waitFor({ timeout: 90_000 });
  note("Restart: the dialog closed, web reads Running on :8000 again");

  // An empty command adopts a port something already listens on: docs's own, under another name.
  await list.getByRole("button", { name: "Run a command…" }).click();
  await run.waitFor();
  await run.getByRole("textbox", { name: "Port" }).fill("8002");
  await run.getByRole("textbox", { name: "Name" }).fill("adopted");
  const adopt = run.getByRole("button", { name: "Adopt port" });
  await adopt.click();
  await run.waitFor({ state: "detached", timeout: 60_000 }).catch(async () => {
    note(`adopting :8002 answered: ${JSON.stringify(await textOf(run))}`);
    await run.getByRole("button", { name: "Cancel" }).click();
  });
  if (await list.getByRole("button", { name: /^adopted :8002/ }).isVisible())
    note(
      `an empty command adopted :8002 as "adopted": ${JSON.stringify(await textOf(list.getByRole("button", { name: /^adopted :8002/ })))}`,
    );

  // A recipe that exits: it says so, with its log and Run again.
  await list.getByRole("button", { name: "Start broken" }).click();
  await list.getByRole("alert").waitFor({ timeout: 120_000 });
  note(`Start broken: ${JSON.stringify(await textOf(list.getByRole("alert")))}`);
  await waitText(/broken (exited|stopped)/);
  note(`the pane: ${JSON.stringify(await textOf(pane))}`);
  await both("preview-failed-start");

  // Stop web: it reads Stopped, with Run again.
  await list.getByRole("button", { name: /^web :8000/ }).click();
  await body.getByRole("button", { name: "Stop", exact: true }).click();
  await list.getByRole("button", { name: /^web :8000 Stopped/ }).waitFor({ timeout: 60_000 });
  await waitText(/web stopped/);
  note(`Stop: web reads Stopped; the pane: ${JSON.stringify(await textOf(pane))}`);
  await both("preview-stopped-service");
  await pane.getByRole("button", { name: "Run again" }).click();
  await list.getByRole("button", { name: /^web :8000 Running/ }).waitFor({ timeout: 120_000 });
  note("Run again: web is Running on :8000 again");

  // The phone: one picker over the page.
  await page.setViewportSize(PHONE);
  await settled();
  const picker = body.getByRole("button", { name: / services?$/ }).first();
  await picker.waitFor();
  note(`phone: the picker reads ${JSON.stringify(await textOf(picker))}`);
  await both("preview-phone");
  await picker.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  note(`phone: the picker's menu reads ${JSON.stringify(await textOf(menu))}`);
  await settled();
  await both("preview-phone-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.setViewportSize(DESKTOP);
  await settled();

  // Fixtures: the view's reads answered otherwise, then the page read again.
  const fixture = async (answer) => {
    await page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      if (!paths.some((each) => each in answer)) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      // `sessions.recipes` goes alone, not in a batch: its answer is the one object.
      if (!Array.isArray(answers)) {
        await route.fulfill({ response, json: answer[paths[0]](answers, paths[0]) });
        return;
      }
      paths.forEach((each, index) => {
        if (each in answer) answers[index] = answer[each](answers[index], each);
      });
      await route.fulfill({ response, json: answers });
    });
    await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.resetQueries());
    await settled();
  };

  // A preview Mend serves, on a site other than this page's: the reason and the way forward.
  const webId = (await client(async (trpc) => trpc.services.list.query({ all: true }), null)).find(
    (view) =>
      view.service.sessionId === A &&
      view.service.name === "web" &&
      view.currentForward?.state === "bound",
  )?.service.id;
  await fixture({
    "worktrees.previews": (answer) => {
      const data = answer.result.data;
      data.json.previews = [
        {
          preview: {
            id: "pv-web",
            projectId: pair[0].session.projectId,
            worktreeId: pair[0].session.worktreeId,
            serviceName: "web",
            label: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
            state: "kept",
            scope: "worktree",
          },
          binding: { _tag: "Unbound", reason: "no-live-attempt" },
          status: ["preview · web · answered HTTP 200 · observed 2 s ago"],
          facts: [],
          open: "/preview-auth?preview=pv-web&path=%2F",
          boundTo: { serviceId: webId, sessionId: A },
        },
      ];
      data.json.frameSite = null;
      return answer;
    },
  });
  await list.getByRole("button", { name: /^web :8000/ }).click();
  await waitText(/Previews are on a different site/);
  const preview = await body
    .getByRole("link", { name: "Open in a new tab" })
    .last()
    .getAttribute("href");
  note(
    `fixture, a Mend preview on another site: ${JSON.stringify((await textOf(body)).slice(0, 400))}; Open in a new tab goes to ${preview}`,
  );
  await both("preview-another-site");
  await page.unroute("**/trpc/**");

  // The file doesn't parse: the list says so, with Read it again.
  await fixture({
    "sessions.recipes": failed(".mend/mend.toml is not valid TOML: expected ']' at line 1"),
  });
  await list
    .getByRole("alert")
    .filter({ hasText: "couldn't be read" })
    .waitFor({ timeout: 60_000 });
  note(
    `fixture, the file doesn't parse: ${JSON.stringify(await textOf(list.getByRole("alert").filter({ hasText: "couldn't be read" })))}`,
  );
  await both("preview-file-error");
  await page.unroute("**/trpc/**");

  // The view's own read fails: Try again.
  await fixture({ "services.list": failed("The verify recipe failed this read on purpose.") });
  await body.getByRole("button", { name: "Try again" }).waitFor({ timeout: 30_000 });
  note(`fixture, the services read fails: ${JSON.stringify(await textOf(body))}`);
  await both("preview-failed");
  await page.unroute("**/trpc/**");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.resetQueries());

  // A watcher: the workspace's sessions answered as another member's, with control shared. They
  // restart and stop Services; only the owner starts one (shared-control.md
  // `terminal-owner-only`).
  const OWNER = "fixture-owner";
  const asWatcher = (answer, procedure) => {
    const data = answer?.result?.data;
    if (data === undefined) return answer;
    data.meta = data.meta ?? { values: {}, v: 1 };
    data.meta.values = data.meta.values ?? {};
    const now = new Date().toISOString();
    const patch = (session, prefix) => {
      session.ownerUserId = OWNER;
      session.sharedControlEnabledAt = now;
      data.meta.values[`${prefix}session.sharedControlEnabledAt`] = ["Date"];
    };
    if (procedure === "sessions.inbox")
      data.json.forEach((row, at) => {
        if (row.session.worktreeId === pair[0].session.worktreeId) patch(row.session, `${at}.`);
      });
    if (
      procedure === "sessions.detail" &&
      data.json.session.worktreeId === pair[0].session.worktreeId
    )
      patch(data.json.session, "");
    if (procedure === "organization.members" && data.json.length > 0) {
      const at = data.json.length;
      data.json.push({
        ...data.json[0],
        userId: OWNER,
        name: "Grace Hopper",
        email: "grace@example.com",
      });
      for (const [key, kind] of Object.entries(data.meta.values))
        if (key.startsWith("0.")) data.meta.values[`${at}${key.slice(1)}`] = kind;
    }
    return answer;
  };
  await fixture({
    "sessions.inbox": asWatcher,
    "sessions.detail": asWatcher,
    "organization.members": asWatcher,
  });
  await waitText(/Only Grace Hopper starts services in this workspace/, 30_000);
  await list.getByRole("button", { name: /^web :8000/ }).click();
  await body.getByRole("button", { name: "Restart service…" }).waitFor();
  const starts = await list.getByRole("button", { name: /^(Start |Run a command)/ }).count();
  if (starts !== 0) throw new Error(`a watcher is offered ${starts} ways to start a Service`);
  note(
    `fixture, a watcher with shared control: ${JSON.stringify(await textOf(list))}; Restart service… and Stop are there, no Start or Run a command…`,
  );
  await both("preview-watcher");
  await page.unroute("**/trpc/**");
  await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.resetQueries());

  // Stop session on both, A last: the workspace and its services stop with the last one.
  await list.waitFor({ timeout: 30_000 });
  // B first: while it runs, the workspace keeps running for it.
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), B);
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), A);
  await waitText(/This workspace isn't running/, 120_000);
  note(
    `after Stop session: ${JSON.stringify(await textOf(pane))}; the list reads ${JSON.stringify(await textOf(list))}`,
  );
  await both("preview-workspace-stopped");
};
