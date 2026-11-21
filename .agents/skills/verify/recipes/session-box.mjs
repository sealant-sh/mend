// The session's conversation on the box with a real agent (route PR 11, SLNT-1119, part two): a page
// the agent publishes with Mend's html_render tool, and its calls through Executor. Run it as the
// verify skill's section 9 says, under your own hold, and stop the session it starts before release:
//
//   pnpm verify drive web --box --recipe session-box
//
// The drive signs in as the box's checker account. The recipe starts one Claude Code session in
// verify-fixture from the New session composer, and prints its id; stop it with the checker CLI.
// A page renders in a child frame, and the driver withholds every image that holds one, so the
// page's own captures keep their ARIA snapshot and the frame's height is noted.
const DESKTOP = { width: 1280, height: 900 };
const PROMPT =
  "Use your mend html_render tool once to publish a page titled `Box check` that shows a small bar chart of three bars with fixed pixel heights. Then use your mend Executor tools to search Executor for a Linear tool and describe it, and reply in one sentence.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((button) =>
      Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const pick = (name) => visible(page.getByRole("button", { name }));
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").fill("verify-fixture");
  await page
    .getByRole("option", { name: /^verify-fixture/ })
    .first()
    .click();
  await pick(/^Agent and model: /).click();
  await page.getByRole("menuitemradio", { name: /^Claude Code/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(PROMPT);
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} from the composer; stop it with the checker CLI before release`);

  // The turn ends: its steps fold, and the page it published stays in view below them.
  await visible(page.getByText("Claude Code · turn 1", { exact: true })).waitFor({
    timeout: 900_000,
  });
  await visible(page.getByText(/^Worked for/)).waitFor({ timeout: 900_000 });
  const frames = page.locator("iframe[title]");
  await frames.first().waitFor({ timeout: 60_000 });
  const title = await frames.first().getAttribute("title");
  const shown = await frames.count();
  const height = await frames
    .first()
    .evaluate((frame) => Math.round(frame.getBoundingClientRect().height));
  const folded = await visible(page.getByRole("button", { name: /^Worked for/ })).getAttribute(
    "aria-expanded",
  );
  note(
    `the turn ended with its steps folded (expanded: ${folded}); the page "${title}" shows ${shown} time(s) below them, in its frame at ${height}px`,
  );
  await capture("box-page-inline-desktop-light");

  // Open: the page large in a dialog that names it; Escape closes it, also from inside the page.
  await visible(page.getByRole("button", { name: `Open ${title}` })).click();
  const dialog = page.getByRole("dialog", { name: title ?? "" });
  await dialog.waitFor();
  await dialog.getByText(/^Published at /).waitFor();
  await dialog.locator("iframe").waitFor();
  await capture("box-page-open-desktop-light");
  await dialog.locator("iframe").click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  note(
    "Open shows the page large in a dialog with Published at its time; Escape from inside the page closes it",
  );

  // Dark recolours the inline page without reloading it.
  const frameUrl = await frames.first().getAttribute("src");
  // The app follows the system's scheme unless the person chose one.
  await page.evaluate(() => localStorage.removeItem("mend-theme"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(800);
  const sameDocument = (await frames.first().getAttribute("src")) === frameUrl;
  note(
    `dark: the inline page kept its document (${sameDocument ? "same frame address" : "reloaded"})`,
  );
  await capture("box-page-inline-desktop-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // Executor calls, at the top of the conversation, when the agent made any.
  const calls = page.getByRole("region", { name: "Executor calls" });
  if ((await calls.count()) === 0) note("Executor calls: none recorded for this session");
  else {
    const rows = await calls.locator('[data-slot="trace-row-title"]').allInnerTexts();
    note(`Executor calls: ${JSON.stringify(rows)}`);
    await capture("box-executor-calls-desktop-light");
  }
};
