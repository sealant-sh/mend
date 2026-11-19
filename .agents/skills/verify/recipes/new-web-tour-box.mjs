// Mend's description and tour written for real, on the box (route PR 25, SLNT-1151): a real Codex
// turn changes verify-fixture, Mend's own pass writes the description and tour from it, and the
// Change view shows them. Run it as the verify skill's section 9 says, under your own hold, and
// stop the session it starts before release:
//
//   pnpm verify drive new-web --box --recipe new-web-tour-box
//
// The turn adds a new file the agent leaves unadded (`app/retry.js`), which sorts before the file
// it edits (`styles.css`): the tour's digest then differs in order from the review's, and the page
// must still read the tour as written from this change. The states a real pass can't be made to
// show (out of date, each failure) are new-web-tour's, from fixtures.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const PROMPT =
  "In this repository, add a new file `app/retry.js` that exports a function `retry(fn, attempts)` which calls `fn` up to `attempts` times and returns the first result that doesn't throw, rethrowing the last error. Then add the line `/* retry styles */` at the end of `styles.css`. Don't commit or stage anything. Reply in one sentence.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(600);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
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
  const hydrated = () =>
    page.waitForFunction(
      () =>
        window["__TSR_ROUTER__"] !== undefined &&
        [...document.querySelectorAll("button")].some((button) =>
          Object.keys(button).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const tourNote = () => visible(page.locator("[data-tour-note]"));

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
  note(`started session ${id} from the composer; stop it with the checker CLI before release`);
  await visible(page.getByText(/^Worked for/)).waitFor({ timeout: 900_000 });
  note("the turn ended");

  // Mend's pass writes the description when the session settles; ask for it if none has run.
  await page.goto(`${web}/sessions/${id}/change`);
  await hydrated();
  await visible(page.locator("section[data-file]")).waitFor({ timeout: 120_000 });
  const written = visible(page.getByText(/^Mend wrote this from /));
  const none = visible(page.getByText("No description yet.", { exact: true }));
  const writing = visible(page.getByText("Mend is writing the description and tour."));
  const failed = visible(page.getByText("Mend couldn't write the description."));
  await written.or(none).or(writing).or(failed).waitFor({ timeout: 120_000 });
  if (await none.isVisible()) {
    note("no pass had run yet: 'No description yet.'; asking with Write description and tour");
    await button("Write description and tour").click();
  }
  if (await writing.isVisible().catch(() => false)) {
    note("'Mend is writing the description and tour.'");
    await capture("writing-box-desktop-light");
  }
  await written.or(failed).waitFor({ timeout: 600_000 });
  if (await failed.isVisible()) {
    const reason = await visible(page.locator('[data-slot="inline-alert"]')).innerText();
    note(`the pass failed on the box: "${reason.replace(/\s+/g, " ")}"`);
    await both("failed-box-desktop");
    throw new Error("Mend's pass failed on the box: no real description to show");
  }
  const said = await written.innerText();
  note(`Mend wrote the description for real; the block says "${said}"`);
  if (said.includes("earlier checkpoint"))
    throw new Error("a tour written from this change reads as from an earlier checkpoint");
  const files = await page
    .locator("section[data-file]")
    .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-file")));
  note(`the change's files: ${files.join(", ")}`);
  const tourLine = await visible(page.getByText(/^Tour/))
    .locator("..")
    .innerText()
    .catch(() => "no tour line");
  note(`tour line: "${tourLine.replace(/\s+/g, " ")}"`);
  const approach = await visible(page.getByText("How the session got there"))
    .isVisible()
    .catch(() => false);
  note(`'How the session got there' shown: ${approach}`);
  await both("written-box-desktop");

  // The whole tour, forwards.
  await button("Start tour").click();
  await tourNote().waitFor();
  await settled();
  const total = Number(
    (await tourNote().getAttribute("aria-label"))?.match(/of (\d+):/)?.[1] ?? "0",
  );
  let linked = null;
  for (let stop = 1; stop <= total; stop += 1) {
    const place = await tourNote().getAttribute("data-place");
    const kind = await tourNote().getAttribute("data-kind");
    const label = await tourNote().getAttribute("aria-label");
    const links = await tourNote().getByRole("link").allInnerTexts();
    note(
      `stop ${stop} of ${total}: "${label}", place ${place}, ${kind === "session" ? `backed by the session (${links.length} link(s): ${links.join(" | ")})` : "Mend's reading"}`,
    );
    if (linked === null && links.length > 0) linked = links[0];
    await both(`stop-${stop}-box-desktop`);
    if (stop < total) {
      await button("Next").click();
      await settled();
    }
  }
  await button("Finish tour").click();
  await settled();
  note(`Finish tour: the note is gone (${await page.locator("[data-tour-note]").count()} left)`);

  // A link into the session opens its conversation.
  if (linked !== null) {
    await button("Start tour").click();
    for (let stop = 1; stop <= total; stop += 1) {
      const link = tourNote().getByRole("link").first();
      if ((await link.count()) > 0) {
        await link.click();
        break;
      }
      await button("Next").click();
      await settled();
    }
    await page.waitForURL((url) => url.pathname === `/sessions/${id}`, { timeout: 30_000 });
    await settled();
    const selected = await visible(page.locator(`[data-tab="session:${id}"]`))
      .getByRole("tab")
      .getAttribute("aria-selected");
    note(
      `the link "${linked}" opened ${new URL(page.url()).pathname}; its tab is focused: ${selected}`,
    );
  } else note("no stop the session backs: no link to open");

  // The phone.
  await page.setViewportSize(PHONE);
  await page.goto(`${web}/sessions/${id}/change`);
  await hydrated();
  await visible(page.locator("section[data-file]")).waitFor({ timeout: 120_000 });
  await written.waitFor({ timeout: 60_000 });
  await both("written-box-phone");
  await button("Start tour").click();
  await tourNote().waitFor();
  await settled();
  await both("stop-1-box-phone");
  await button("End tour").click();
  await page.setViewportSize(DESKTOP);
  note(`done; stop session ${id}`);
};
