// Second look in the new web app, for real (SLNT-1176, the web PR): a real Codex turn writes a
// file, two comments go to it through the Change view's Send, and the view shows what came back:
// "Codex finished working on your 2 comments", "Since your last review", the answers under the
// comments, Show the edit, a reply and Resolve. Run it as the verify skill's section 9 says, under
// your own hold, on a box whose server has the Second look API (mend#1886), and stop the session
// it starts before release:
//
//   pnpm verify drive new-web --box --recipe new-web-second-look-ui-box
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const FILE = "app/retry.js";
const LINES = [
  "// retry helper",
  "export function retry(fn, attempts) {",
  "  let last;",
  "  for (let i = 0; i < attempts; i += 1) {",
  "    try {",
  "      return fn();",
  "    } catch (error) {",
  "      last = error;",
  "    }",
  "  }",
  "  throw last;",
  "}",
];
const PROMPT = `In this repository, create the file \`${FILE}\` with exactly these lines and nothing else:\n\n${LINES.join("\n")}\n\nDon't commit or stage anything. Reply in one sentence.`;

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

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
    await page.mouse.move(1, 1);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const light = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await capture(`${name}-light`);
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
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const call = (route, input) =>
    page.evaluate(
      async ({ route: at, input: value }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of at.split(".")) target = target[part];
        return target.query(value);
      },
      { route, input },
    );
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const chip = () => visible(page.getByRole("button", { name: /^Show changes: / }));
  const chipWords = async () => (await chip().getAttribute("aria-label")) ?? "";
  /** A comment by the start of its words: its label is "<author>: <words>". */
  const article = (text) => visible(page.locator(`article[data-comment][aria-label*=": ${text}"]`));
  const lineNumber = (line) =>
    page
      .locator(
        `section[data-file="${FILE}"] [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
      )
      .first();

  // A real Codex session writes the file.
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
  const session = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${session} from the composer; stop it with the checker CLI before release`);
  await visible(page.getByText(/^Worked for/)).waitFor({ timeout: 900_000 });
  note("the first turn ended");

  // The change, before anyone has sent comments: no "Since your last review".
  await go(`/sessions/${session}/change`);
  await section(FILE).waitFor({ timeout: 120_000 });
  note(`the chip: "${await chipWords()}"`);
  await chip().click();
  const menu = visible(page.getByRole("menu"));
  await menu.waitFor();
  note(
    `the picker before a send: ${JSON.stringify((await menu.getByRole("menuitem").allInnerTexts()).map(oneLine))}`,
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  // Two comments: line 4, and the whole change. Then Send, for real.
  await section(FILE).scrollIntoViewIfNeeded();
  await lineNumber(4).click();
  const lineBox = visible(page.getByRole("textbox", { name: `Comment on ${FILE}, line 4` }));
  await lineBox.waitFor({ timeout: 15_000 });
  await lineBox.fill("Rename `i` to `attempt` on this line.");
  await button("Add comment").click();
  await article("Rename").waitFor({ timeout: 30_000 });
  await button("Comment on the whole change").click();
  await visible(page.getByRole("textbox", { name: "Comment on the whole change" })).fill(
    "Keep the signature `retry(fn, attempts)` as it is.",
  );
  await button("Add comment").click();
  await article("Keep the signature").waitFor({ timeout: 30_000 });
  const send = visible(page.getByRole("button", { name: /^Send 2 comments to / }));
  note(`Send reads "${await send.innerText()}"`);
  await send.click();
  await page.waitForURL((url) => url.pathname === `/sessions/${session}`, { timeout: 120_000 });
  note("Send delivered: the view moved to the conversation");

  // While the turn runs, then once it ends.
  await go(`/sessions/${session}/change`);
  await section(FILE).waitFor({ timeout: 120_000 });
  const working = visible(page.getByText("Working on your comments…"));
  if (await working.isVisible().catch(() => false)) {
    note("while Codex works: 'Working on your comments…' under the comments");
    await light("working-box-desktop");
  } else note("the turn had already ended when the change view opened");
  const detail = await call("sessions.detail", { id: session });
  const change = detail.change.id;
  for (let waited = 0; waited < 900; waited += 5) {
    const rows = await call("changes.comments", { id: change });
    const done = rows.every((row) =>
      (row.answers ?? []).some((answer) => !["queued", "running"].includes(answer.turnStatus)),
    );
    if (rows.length > 0 && done) break;
    await page.waitForTimeout(5_000);
  }
  note("the agent's turn on the comments ended");
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${web}/sessions/${session}/change`);
  await hydrated();
  await section(FILE).waitFor({ timeout: 120_000 });
  const finished = visible(page.getByText(/finished working on your/));
  await finished.waitFor({ timeout: 60_000 });
  note(`the band: "${oneLine(await finished.locator("..").innerText())}"`);
  await both("finished-box-desktop");

  // Since your last review.
  await button("Show changes since your last review").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((each) =>
      (each.getAttribute("aria-label") ?? "").startsWith("Show changes: Since your last review"),
    ),
  );
  await settled();
  note(`the chip: "${await chipWords()}"`);
  const files = await page
    .locator("section[data-file]")
    .evaluateAll((sections) => sections.map((each) => each.getAttribute("data-file")));
  note(`the files in it: ${files.join(", ")}`);
  for (const text of ["Rename", "Keep the signature"]) {
    const found = article(text);
    note(
      (await found.count()) > 0
        ? `the comment "${text}…" with its answer: "${oneLine(await found.innerText())}"`
        : `the comment "${text}…" isn't in this range's diff`,
    );
  }
  await both("since-last-review-box-desktop");

  // Show the edit, then back.
  const showEdit = button("Show the edit");
  if ((await showEdit.count()) > 0) {
    await showEdit.click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((each) =>
        (each.getAttribute("aria-label") ?? "").startsWith("Show changes: Checkpoints"),
      ),
    );
    note(`Show the edit: "${await chipWords()}"`);
    await light("show-the-edit-box-desktop");
    await chip().click();
    await visible(page.getByRole("menuitem", { name: /^Since your last review/ })).click();
    await settled();
  } else note("no answer said the code changed, so there was no Show the edit");

  // A reply, then Resolve.
  const whole = article("Keep the signature");
  await whole.getByRole("button", { name: "Reply", exact: true }).click();
  const replyBox = visible(page.getByRole("textbox", { name: /^Reply to / }));
  await replyBox.fill("Thanks. Please also add a one-line comment above the loop.");
  note(
    `the reply box says: "${oneLine(await visible(page.getByText(/^Your reply goes to /)).innerText())}"`,
  );
  await button("Add reply").click();
  await visible(page.locator("[data-reply]")).waitFor({ timeout: 30_000 });
  note(
    `the reply: "${oneLine(await visible(page.locator("[data-reply]")).innerText())}"; Send reads "${await visible(page.getByRole("button", { name: /^Send / })).innerText()}"`,
  );
  await both("reply-added-box-desktop");
  const line = article("Rename");
  if ((await line.count()) > 0) {
    await line.getByRole("button", { name: "Resolve", exact: true }).click();
    await line.getByRole("button", { name: "Reopen" }).waitFor({ timeout: 30_000 });
    note(`resolved: "${oneLine(await line.innerText())}"`);
    await light("resolved-box-desktop");
  }

  // Up to a checkpoint, and a checkpoint compared with itself.
  await chip().click();
  const upTo = visible(page.getByRole("menuitem", { name: /^\d+ · / }).nth(1));
  await upTo.click();
  await settled();
  note(`Up to a checkpoint: "${await chipWords()}"`);
  await chip().click();
  await visible(page.getByRole("menuitem", { name: "Compare two checkpoints…" })).click();
  const compare = visible(page.getByRole("dialog", { name: "Compare two checkpoints" }));
  await compare.waitFor();
  const to = await compare.getByLabel("To").inputValue();
  await compare.getByLabel("From").selectOption(to);
  await compare.getByRole("button", { name: "Show changes" }).click();
  await visible(page.getByText("Nothing changed between these checkpoints")).waitFor({
    timeout: 60_000,
  });
  note("a checkpoint compared with itself: 'Nothing changed between these checkpoints'");
  await button("Show the whole change").click();
  await section(FILE).waitFor({ timeout: 60_000 });

  // The phone.
  await page.setViewportSize(PHONE);
  await chip().click();
  const sheet = visible(page.getByRole("dialog", { name: "Show changes" }));
  await sheet.waitFor();
  await both("range-sheet-box-phone");
  await sheet.getByRole("button", { name: /^Since your last review/ }).click();
  await sheet.waitFor({ state: "hidden" });
  await article("Keep the signature").waitFor({ timeout: 60_000 });
  await both("since-last-review-box-phone");
  await page.setViewportSize(DESKTOP);
  await page.evaluate(() => sessionStorage.clear());
  note(`done; stop session ${session}`);
};
