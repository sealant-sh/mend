// A session's workspace that reaches its memory limit (SLNT-1233), with real Codex turns on a
// Docker copy: the kernel stops the command that ate the memory inside that workspace, the turn
// says "The workspace hit its memory limit" and what was stopped, and the server and a second
// session carry on. Run it against a server built from the commit under test, on a copy without
// Boat (sessions there run on Docker):
//
//   pnpm verify drive web --box --recipe memory-limit-box
//
// The drive signs in as the box's checker account. The recipe starts two Codex sessions in
// verify-fixture from the New session composer and prints their ids: stop both with the checker
// CLI. A copy has 8 GB, so `auto` gives each workspace a little under 4 GiB; the command holds
// 4.5 GiB, so it is stopped at the limit on a build that has one, and fits in the copy on one
// that has none, where the recipe fails because no line says the limit was reached.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const HEADING = "The workspace hit its memory limit";
const WORDS =
  /The workspace reached its memory limit of [\d.]+ [GM]iB, and the kernel stopped a process in it, most likely a command Codex ran\. Codex is still running\./;

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  const pick = (name) => visible(page.getByRole("button", { name }));
  const hydratedOnce = () =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some((button) =>
          Object.keys(button).some((key) => key.startsWith("__reactProps")),
        ),
      undefined,
      { timeout: 90_000 },
    );
  // The dev server can stall one load while it bundles a module for the first time: reload once.
  const hydrated = () =>
    hydratedOnce().catch(async () => {
      note("the page did not hydrate in 90 s; reloading once");
      await page.reload();
      await hydratedOnce();
    });

  /** Start a Codex session in verify-fixture with `task`; answers its id. */
  const start = async (task) => {
    await page.goto(`${web}/`);
    await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
    await hydrated();
    await pick(/^Project: /).click();
    await page.getByPlaceholder("Find a project").fill("verify-fixture");
    await page
      .getByRole("option", { name: /^verify-fixture/ })
      .first()
      .click();
    await pick(/^Agent and model: /).click();
    await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
    await page.keyboard.press("Escape").catch(() => undefined);
    await visible(page.getByRole("textbox", { name: "Task" })).fill(task);
    await visible(page.getByRole("button", { name: "Start session" })).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
    return new URL(page.url()).pathname.split("/").at(-1);
  };

  await page.setViewportSize(DESKTOP);

  // A second session beside the one that runs out: it must carry on.
  const bystander = await start("Reply with the single word ready, and nothing else.");
  note(`started the bystander session ${bystander}; stop it with the checker CLI`);
  await visible(page.getByText(/^ready\.?$/i)).waitFor({ timeout: TURN_MS });
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });

  const eater = await start(
    "Run exactly this shell command once, and nothing else: `head -c 4608M /dev/zero | tail | wc -c`. Do not retry it or change it. Then reply with the single word finished.",
  );
  note(`started the session that eats memory ${eater}; stop it with the checker CLI`);
  await visible(page.getByText(/head -c 4608M/).last()).waitFor({ timeout: TURN_MS });
  note("Codex runs the command that holds 4.5 GiB");
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  note("the turn ended");

  const heading = visible(page.getByText(HEADING, { exact: true }));
  const seen = await heading
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!seen) {
    await capture("memory-limit-no-line-desktop-light");
    // SLNT-1233: no limit, or no line: the command ran in the host's memory and nothing said so.
    throw new Error(
      "the turn ended and nothing says the workspace hit its memory limit: no limit stopped the command, or Mend did not say so",
    );
  }
  const said = (await visible(page.getByText(WORDS)).innerText()).trim();
  note(`under the turn: "${HEADING}" · "${said}"`);
  await heading.scrollIntoViewIfNeeded();
  await capture("memory-limit-turn-desktop-light");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await heading.scrollIntoViewIfNeeded();
  await capture("memory-limit-turn-phone-light");
  await page.setViewportSize(DESKTOP);

  // Said once: a reload reads the same line from the server, and only one.
  await page.reload();
  await heading.waitFor({ timeout: 60_000 });
  const lines = await page.getByText(HEADING, { exact: true }).filter({ visible: true }).count();
  note(`after a reload the line is still there, ${lines} time(s)`);
  if (lines !== 1) throw new Error(`the line shows ${lines} times after a reload, not once`);

  // The server and the other session carry on.
  const health = await page.request.get(`${web}/api/health`);
  note(`/api/health answers ${health.status()}`);
  if (!health.ok()) throw new Error(`/api/health answered ${health.status()}`);
  await page.goto(`${web}/sessions/${bystander}`);
  const field = visible(page.getByRole("textbox", { name: "Message Codex" }));
  await field.waitFor({ timeout: 60_000 });
  // The field takes typing once React holds it: before that, a fill is dropped.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("textarea")].some((textarea) =>
      Object.keys(textarea).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const ping = "Reply with the single word pong, and nothing else.";
  await field.fill(ping);
  await field.press("Enter");
  await visible(page.locator('[data-slot="user-message"]').filter({ hasText: ping })).waitFor({
    timeout: 30_000,
  });
  await visible(page.getByText(/^pong\.?$/i)).waitFor({ timeout: TURN_MS });
  note("the bystander session answered pong after the other workspace hit its limit");
  if ((await page.getByText(HEADING, { exact: true }).filter({ visible: true }).count()) !== 0)
    throw new Error("the bystander session says it hit a memory limit it never reached");
  await capture("memory-limit-bystander-desktop-light");
};
