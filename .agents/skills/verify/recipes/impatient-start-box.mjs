// An impatient person and a real Codex turn (SLNT-1237). Mend keeps a start's first message, and
// what is sent while it starts, on the server: so a message sent at once and its tab closed is
// still there in a new tab and gets delivered after the first, and a reload during a start shows
// the title and the first message. Run it against a server built from the commit under test:
//
//   pnpm verify drive web --box --recipe impatient-start-box
//
// The drive signs in as the box's checker account. The recipe starts two Codex sessions in
// verify-fixture from the New session composer and prints their ids: stop them with the checker
// CLI. On a build before SLNT-1237 it fails: the second message lived in the closed tab's
// sessionStorage and the new tab never shows it ("the message sent while it started isn't
// there"), and the reload shows `New session` with no first message.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const FIRST = "Reply with the single word ready, and nothing else.";
const SECOND = "Then reply with the single word again, and nothing else.";
const RELOADED = "Reply with the single word second, and nothing else.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

const hydrated = (page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll("button, textarea")].some((element) =>
      Object.keys(element).some((key) => key.startsWith("__reactProps")),
    ),
  );

/** The person's message bubble that holds `words`. */
const bubble = (page, words) =>
  visible(page.locator('[data-slot="user-message"]').filter({ hasText: words }));

/** The line under a bubble. */
const byline = async (page, words) =>
  (await bubble(page, words).locator('[data-slot="message-footer"]').innerText()).trim();

/** The title the session's page gives its conversation. */
const conversationTitle = async (page) => {
  const label = await visible(page.locator('[aria-label^="Conversation: "]')).getAttribute(
    "aria-label",
  );
  return (label ?? "").replace(/^Conversation: /, "");
};

/** Start a Codex session in verify-fixture with `task`, from the New session composer on `/`. */
const startFromHome = async (page, web, task) => {
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await hydrated(page);
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
  await visible(page.getByRole("textbox", { name: "Task" })).fill(task);
  await visible(page.getByRole("button", { name: "Start session" })).click();
};

export default async ({ page, web, capture, note }) => {
  await page.setViewportSize(DESKTOP);

  // 1. Start, and send a second message at once, while it reads Starting.
  await startFromHome(page, web, FIRST);
  const field = visible(page.getByRole("textbox", { name: "Message Codex" }));
  await field.waitFor({ timeout: 30_000 });
  await field.fill(SECOND);
  await page.keyboard.press("Enter");
  await bubble(page, SECOND).waitFor({ timeout: 10_000 });
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(
    `started session ${id}, and sent "${SECOND}" while it started; stop it with the checker CLI`,
  );
  // The words have left this tab: Mend answered for them, so the line under them no longer reads
  // Sending… (it reads Waits for Codex to start. while Codex starts, nothing once it took them).
  const answeredBy = Date.now() + 60_000;
  while ((await byline(page, SECOND)).includes("Sending")) {
    if (Date.now() > answeredBy)
      throw new Error("the message sent while it started still reads Sending… after a minute");
    await page.waitForTimeout(250);
  }
  note(
    `before the tab closes, the line under the second message reads "${await byline(page, SECOND)}"`,
  );
  await capture("impatient-sent-while-starting-desktop-light");

  // 2. Close the tab: nothing of the page runs, and a new tab shares no sessionStorage with it.
  await page.goto("about:blank");
  const other = await page.context().newPage();
  await other.setViewportSize(DESKTOP);
  await other.goto(`${web}/sessions/${id}`);
  await hydrated(other);
  await bubble(other, FIRST).waitFor({ timeout: 60_000 });
  const there = await bubble(other, SECOND)
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!there)
    throw new Error(
      "the message sent while it started isn't there in a new tab: it lived in the closed tab",
    );
  note("in a new tab: the first message and the one sent while it started are both there");
  await visible(other.getByText(/^ready\.?$/i)).waitFor({ timeout: TURN_MS });
  await visible(other.getByText(/^again\.?$/i)).waitFor({ timeout: TURN_MS });
  const [readyAt, againAt] = [
    (await visible(other.getByText(/^ready\.?$/i)).boundingBox())?.y ?? Number.NaN,
    (await visible(other.getByText(/^again\.?$/i)).boundingBox())?.y ?? Number.NaN,
  ];
  if (!(readyAt < againAt)) throw new Error("Codex answered the second message before the first");
  const left = await byline(other, SECOND);
  if (left.includes("Waits for") || left.includes("Not sent"))
    throw new Error(`the delivered message still reads "${left}"`);
  note(`Codex replied ready, then again, in that order; the second message now reads "${left}"`);
  await other.close();
  await page.goto(`${web}/sessions/${id}`);
  await hydrated(page);
  await visible(page.getByText(/^again\.?$/i)).waitFor({ timeout: 60_000 });
  await capture("impatient-both-delivered-desktop-light");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await capture("impatient-both-delivered-phone-light");
  await page.setViewportSize(DESKTOP);

  // 3. Reload during a start: the title and the first message are the server's.
  await startFromHome(page, web, RELOADED);
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const second = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${second}; reloading while it starts; stop it with the checker CLI`);
  await page.reload();
  await hydrated(page);
  // Read at once, while it still starts: a build that kept the first message in the tab shows it
  // only once Codex has taken it, long after this.
  const shown = await bubble(page, RELOADED)
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const stillStarting = await visible(page.getByText(/^Getting the session ready/))
    .isVisible()
    .catch(() => false);
  const title = await conversationTitle(page);
  note(
    `after the reload (${stillStarting ? "still starting" : "the start had got further"}): the first message ${shown ? "shows" : "is missing"}, the title reads "${title}"`,
  );
  await capture("reload-during-start-desktop-light");
  if (!stillStarting && !shown)
    throw new Error("the start got past Starting before the reload was read: run it again");
  if (!shown) throw new Error("after a reload during the start, the first message is missing");
  if (title === "New session" || title === "")
    throw new Error("after a reload during the start, the session reads New session");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await capture("reload-during-start-phone-light");
  await page.setViewportSize(DESKTOP);
  await visible(page.getByText(/^second\.?$/i)).waitFor({ timeout: TURN_MS });
  note("the reloaded start's turn ran: Codex replied second");

  // 4. A message to the session now it runs goes as before: answered, nothing under it.
  const third = "Now reply with the single word third, and nothing else.";
  await visible(page.getByRole("textbox", { name: "Message Codex" })).fill(third);
  await page.keyboard.press("Enter");
  await visible(page.getByText(/^third\.?$/i)).waitFor({ timeout: TURN_MS });
  const after = await byline(page, third);
  if (after.includes("Waits for") || after.includes("Not sent"))
    throw new Error(`a message to the running session reads "${after}"`);
  note(`a message to the running session was answered third; it reads "${after}"`);
};
