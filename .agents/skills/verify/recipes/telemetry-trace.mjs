// What the browser reports to Sentry about a person's use of the web app (SLNT-1408): one name per
// tRPC request with a child span per procedure, clicks named for the component they landed in,
// page names as URL templates, and traces that end with what started them, however long the tab
// stays open. Run it on a stack brought up with this machine's Sentry DSNs and an environment of
// its own (`MEND_VERIFY_SENTRY_BROWSER_DSN`, `MEND_VERIFY_SENTRY_DSN`,
// `MEND_VERIFY_SENTRY_ENVIRONMENT`), after the composer's CLI batch (a fake Codex login and a
// worktree to start in):
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/composer-setup.json
//   MEND_VERIFY_TRACE_HOLD_MS=900000 pnpm verify drive web --recipe telemetry-trace
//
// Then read Sentry back for the run's environment over the window its notes print (flows.md,
// `telemetry.web-trace`). The page itself looks as it did before the change: the captures are of
// the Now page, a session and the not-found page, in light and dark.
const HOLD_MS = Number(process.env["MEND_VERIFY_TRACE_HOLD_MS"] ?? "60000");

export default async ({ page, web, capture, note }) => {
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
  /** React has taken the server's markup over: clicks and the router reach it. */
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], textarea")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const navigate = (to) =>
    page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const task = () => page.getByRole("textbox", { name: "Task" }).filter({ visible: true });
  const start = () =>
    page.getByRole("button", { name: /^(Start session|Starting…)$/ }).filter({ visible: true });
  note(`run window opens ${new Date().toISOString()}`);

  // The Now page: its load, and a click on the composer's task.
  await open("/");
  // The page names its Sentry environment and release (`telemetry-config.ts`), never in the code.
  const telemetry = await page.evaluate(() => {
    const served = window["__MEND_TELEMETRY__"];
    return served === undefined || served === null
      ? null
      : `${served.environment ?? "?"} · ${served.release ?? "no release"}`;
  });
  if (telemetry === null) throw new Error("the page was served with no telemetry: no browser DSN");
  note(`the page reports to Sentry as ${telemetry}`);
  await task().waitFor();
  await both("now-desktop");
  // Codex, the agent the CLI batch signed in (the composer may open on Claude Code, with none).
  const agent = () =>
    page
      .getByRole("button", { name: /^Agent and model: / })
      .filter({ visible: true })
      .first();
  await agent().click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await page
    .getByRole("button", { name: /^Agent and model: Codex/ })
    .filter({ visible: true })
    .first()
    .waitFor();
  await task().click();
  await task().fill("Change nothing. Reply with done.");

  // A start: its trace is its own, and so is the message it sends.
  await start().click();
  await page.waitForURL(/\/sessions\/(?!starting-)[^/]+$/, { timeout: 60_000 });
  const session = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${session}`);
  await settled();

  // A message sent from the session's composer.
  const composer = page.getByRole("textbox").filter({ visible: true }).last();
  await composer.click();
  await composer.fill("And say hello.");
  await composer.press("Enter");
  await page.waitForTimeout(3_000);
  note("sent a message from the session's composer");
  await both("session-desktop");

  // Clicks in the sidebar: the session's row, then Projects.
  const row = page.locator(`[data-session-id="${session}"]`).filter({ visible: true }).first();
  if ((await row.count()) > 0) {
    await row.click();
    note("clicked the session's row in the sidebar");
  } else note("the session's row was not in the sidebar: no row click");
  await settled();
  await page.getByRole("link", { name: "Projects" }).filter({ visible: true }).first().click();
  await page.waitForURL((url) => url.pathname === "/projects");
  await settled();
  note("clicked Projects in the sidebar");

  // Addresses no page owns: a splat under Settings and one at the top.
  await navigate("/settings/no-such-page");
  await page.waitForTimeout(2_000);
  note(`/settings/no-such-page settled on ${new URL(page.url()).pathname}`);
  await navigate("/no-such-page");
  await page.waitForTimeout(2_000);
  await both("not-found-desktop");
  note("/no-such-page drew the not-found screen");

  // A session's page left open: its polls and refetches, then a late click.
  await open(`/sessions/${session}`);
  note(
    `holding /sessions/${session} open for ${Math.round(HOLD_MS / 1000)} s from ${new Date().toISOString()}`,
  );
  await page.waitForTimeout(Math.max(0, HOLD_MS - 30_000));
  await page.getByRole("textbox").filter({ visible: true }).last().click();
  note(`a late click on the composer at ${new Date().toISOString()}`);
  await page.waitForTimeout(Math.min(HOLD_MS, 30_000));
  // Leaving the page reports its web vitals; a moment for the SDK to send them.
  await navigate("/");
  await page.waitForTimeout(5_000);
  note(`run window closes ${new Date().toISOString()}`);
};
