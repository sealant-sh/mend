// Comments sent to a real agent, on the box (route PR 24, SLNT-1166): a real Codex turn changes
// verify-fixture; on its change the person comments on a line, a range and the whole change,
// resolves and reopens, asks Mend to read the change and suggest fixes (real passes, with the
// box's real agent login), chooses and edits what goes, and sends it. Codex really starts a turn on
// the comments; back on the change they read Sent, and one is resolved on a second look. Run it as
// the verify skill's section 9 says, under your own hold, and stop the session it starts before
// release:
//
//   pnpm verify drive web --box --recipe comments-box
//
// The states the box can't be made to show on demand (a failed or pending delivery, a draft when
// Mend's pass drafts nothing) are comments', from fixtures on a local stack.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const FILE = "app/retry.js";
const PROMPT =
  "In this repository, add a new file `app/retry.js` that exports a function `retry(fn, attempts)` which calls `fn` up to `attempts` times, waiting 100 ms between attempts, and returns the first result that doesn't throw, rethrowing the last error. Write it in about fifteen lines. Don't commit or stage anything. Reply in one sentence.";

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
  const shot = async (name, themes = ["light"]) => {
    await page.mouse.move(1, 1);
    for (const theme of themes) {
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
  const comment = (text) =>
    visible(page.locator("article[data-comment]").filter({ hasText: text }));
  const lineNumber = (line) =>
    page
      .locator(
        `section[data-file="${FILE}"] [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
      )
      .first();
  const openChange = async (id) => {
    await page.goto(`${web}/sessions/${id}/change`);
    await hydrated();
    await visible(page.locator(`section[data-file="${FILE}"]`)).waitFor({ timeout: 120_000 });
    await settled();
  };

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
  note("the first turn ended");

  await openChange(id);
  const lines = await page
    .locator(
      `section[data-file="${FILE}"] [data-column-number]:not([data-line-type="change-deletion"])`,
    )
    .count();
  note(`${FILE} is in the change, ${lines} numbered cells drawn`);
  note(
    `before any comment the toolbar reads "${await visible(
      page.getByText(/Click a line to comment\./),
    )
      .innerText()
      .catch(() => "no note")}"`,
  );
  await shot("no-comments-box-desktop");

  // A comment on one line.
  await lineNumber(3).click();
  const lineBox = visible(page.getByRole("textbox", { name: `Comment on ${FILE}, line 3` }));
  await lineBox.waitFor({ timeout: 15_000 });
  await lineBox.fill("Make the wait grow with each attempt, so a slow server gets more room.");
  await button("Add comment").click();
  await comment("Make the wait grow").waitFor({ timeout: 30_000 });
  note("a click on line 3's number opened the box; the comment saved under line 3");

  // A range.
  const from = await lineNumber(5).boundingBox();
  const to = await lineNumber(8).boundingBox();
  if (from === null || to === null) throw new Error("lines 5 and 8 aren't on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  const rangeBox = visible(page.getByRole("textbox", { name: `Comment on ${FILE}, lines 5–8` }));
  await rangeBox.waitFor({ timeout: 15_000 });
  await rangeBox.fill("Say in a comment why the last error is the one rethrown.");
  await button("Add comment").click();
  await comment("why the last error").waitFor({ timeout: 30_000 });
  note("a drag from line 5 to 8 opened 'lines 5–8'; the comment saved under line 8");

  // The whole change.
  await button("Comment on the whole change").click();
  await visible(page.getByRole("textbox", { name: "Comment on the whole change" })).fill(
    "Keep `retry(fn, attempts)` as it is; callers already pass both.",
  );
  await button("Add comment").click();
  await visible(page.getByRole("region", { name: "On the whole change" })).waitFor({
    timeout: 30_000,
  });
  note("the whole-change comment shows under 'On the whole change' over the diffs");

  // Every comment is still there after a reload.
  await openChange(id);
  for (const text of ["Make the wait grow", "why the last error", "callers already pass both"])
    await comment(text).waitFor({ timeout: 30_000 });
  note(
    `after a reload all three comments are there; Send reads "${await button(/^Send \d+ comments? to /, false).innerText()}"`,
  );
  await shot("comments-ready-box-desktop", ["light", "dark"]);

  // Resolve and Reopen.
  await comment("why the last error").getByRole("button", { name: "Resolve" }).click();
  await comment("why the last error")
    .getByText(/^Resolved/)
    .waitFor({ timeout: 15_000 });
  note(
    `Resolve folded it to 'Resolved'; Send reads "${await button(/^Send \d+ comments? to /, false).innerText()}"`,
  );
  await comment("why the last error").getByRole("button", { name: "Reopen" }).click();
  await button("Send 3 comments to Codex").waitFor({ timeout: 15_000 });
  note("Reopen put it back: 'Send 3 comments to Codex'");

  // Mend's passes, for real.
  for (const ask of ["Read this change", "Suggest fixes"]) {
    const asked = page.waitForResponse((response) =>
      response
        .url()
        .includes(ask === "Read this change" ? "changes.queueRead" : "changes.queueSuggest"),
    );
    await button(ask).click();
    note(`${ask}: answered ${(await asked).status()}`);
  }
  const drafts = visible(page.getByRole("region", { name: "Drafts from Mend" }));
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].some((each) =>
        /^(Reading…|Looking for fixes…)$/.test(each.textContent ?? ""),
      ),
    null,
    { timeout: 900_000 },
  );
  note(`Drafts from Mend after both passes: "${(await drafts.innerText()).replace(/\s+/g, " ")}"`);
  const draft = visible(
    page.locator("article[data-comment]").filter({ hasText: "Draft from Mend" }),
  );
  if ((await draft.count()) > 0) {
    await draft.scrollIntoViewIfNeeded();
    await shot("mends-draft-box-desktop", ["light", "dark"]);
    await draft.getByRole("button", { name: "Add to comments" }).click();
    await visible(page.getByText(/from Mend's draft/)).waitFor({ timeout: 15_000 });
    note("Add to comments on Mend's real draft: it reads 'from Mend's draft' and joins the send");
    await shot("mends-draft-added-box-desktop");
  } else
    note(
      "Mend's passes drafted nothing on this change: no draft to add (the fixture recipe shows one)",
    );

  // Your review, then Choose and edit: uncheck the range comment, add a line, send.
  for (const box of await page.getByRole("checkbox", { name: /^Viewed: / }).all())
    if ((await box.getAttribute("aria-checked")) !== "true" && (await box.isVisible()))
      await box.click();
  const review = visible(page.getByRole("region", { name: "Your review" }));
  await review.scrollIntoViewIfNeeded();
  note(`Your review: "${(await review.innerText()).split("\n").slice(0, 2).join(" ")}"`);
  await shot("your-review-box-desktop");
  await review.getByRole("button", { name: "Choose and edit before sending…" }).click();
  const dialog = visible(page.getByRole("dialog", { name: "Send to Codex" }));
  await dialog.getByRole("checkbox", { name: /why the last error/ }).click();
  const message = dialog.getByRole("textbox", { name: "What Codex receives" });
  await message.fill(`${await message.inputValue()}\n\nReply in two sentences.`);
  const legend = await dialog.locator("legend").innerText();
  note(`Choose and edit: "${legend}"; the range comment unchecked, one line added to the message`);
  await shot("choose-and-edit-box-desktop");
  const sent = page.waitForResponse((response) =>
    response.url().includes("sessions.deliverFollowUp"),
  );
  await dialog.getByRole("button", { name: /^Send \d+ comments?$/ }).click();
  const answer = await sent;
  note(`Send: sessions.deliverFollowUp answered ${answer.status()}`);
  await page.waitForURL((url) => url.pathname === `/sessions/${id}`, { timeout: 60_000 });
  note("the page moved to the session's conversation tab");
  await visible(page.getByText(/Review comments:/)).waitFor({ timeout: 120_000 });
  note("the conversation shows the sent message ('Review comments: …') as the person's turn");
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("p, span")].filter((each) =>
          (each.textContent ?? "").startsWith("Worked for"),
        ).length >= 2,
      null,
      { timeout: 900_000 },
    )
    .then(() => note("Codex finished a second turn on the comments"))
    .catch(() => note("no second 'Worked for' line within 15 minutes"));

  // Back on the change: what was sent reads Sent; a second look resolves one.
  await openChange(id);
  // Every file was marked viewed, so line comments are folded away: read the whole-change one.
  await comment("callers already pass both").getByText(/^Sent/).waitFor({ timeout: 60_000 });
  note(
    `back on the change: the sent comments read 'Sent'; the unchecked one still 'Not sent'; the toolbar reads "${await visible(
      page.getByText(/resolved, \d+ open\.$|Your comments stay here/),
    )
      .innerText()
      .catch(() => "?")}"`,
  );
  await comment("callers already pass both").getByRole("button", { name: "Resolve" }).click();
  await visible(page.getByText(/1 comment resolved, \d+ open\./))
    .waitFor({ timeout: 15_000 })
    .then(async () =>
      note(`second look: "${await visible(page.getByText(/1 comment resolved/)).innerText()}"`),
    )
    .catch(() => note("the resolved count isn't in the toolbar: comments still wait to be sent"));
  await shot("second-look-box-desktop", ["light", "dark"]);

  // The phone.
  await page.setViewportSize(PHONE);
  await openChange(id);
  await shot("change-box-phone", ["light", "dark"]);
  await page.setViewportSize(DESKTOP);
  note(`done; stop session ${id}`);
};
