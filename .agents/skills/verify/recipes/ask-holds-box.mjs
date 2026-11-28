// The session menu's choice holds for every later message (SLNT-1416), with real Codex turns on
// the box. A session launched skipping prompts runs its first `rm -f` without asking; ticked on the
// session's page, `Ask before acting` asks before the next message's `rm -f`, the one after it and
// one sent after a reload, with no tick in between; unticked with Fast on, the next two run without
// asking and on Fast. Run it as the verify skill's section 9 says, under your own hold, and stop the
// session it starts before release:
//
//   pnpm verify drive web --box --recipe ask-holds-box
//
// It fails on a build whose composer sent the choice only when it differed from the newest turn's:
// the second message after the tick runs its `rm -f` with no card while the menu reads ticked.
const DESKTOP = { width: 1280, height: 900 };
const TURN_MS = 600_000;
const DELETE = (file) =>
  `Run the shell command \`printf ok > ${file}\`, then delete the file by running exactly \`rm -f ${file}\`. Reply with the single word deleted if the file is gone, or kept if the deletion didn't run.`;

const visible = (locator) => locator.filter({ visible: true }).first();
const approvalCard = (page) =>
  visible(page.getByText(/^Codex wants to (run a command|edit a file|edit \d+ files|use a tool)$/));

export default async ({ page, web, capture, note }) => {
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  const send = async (words) => {
    await field().fill(words);
    await page.keyboard.press("Enter");
  };
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  const turnOver = () => stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  const replyCount = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("p")].filter((node) =>
          /^(deleted|kept)\.?$/i.test(node.textContent?.trim() ?? ""),
        ).length,
    );
  const replied = async (before) => {
    await page.waitForFunction(
      ([count]) =>
        [...document.querySelectorAll("p")].filter((node) =>
          /^(deleted|kept)\.?$/i.test(node.textContent?.trim() ?? ""),
        ).length > count,
      [before],
      { timeout: TURN_MS, polling: 1_000 },
    );
    await turnOver().catch(() => undefined);
    await page.waitForTimeout(5_000);
    await turnOver().catch(() => undefined);
  };
  const lastReply = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("p")]
          .filter((node) => /^(deleted|kept)\.?$/i.test(node.textContent?.trim() ?? ""))
          .at(-1)
          ?.textContent?.trim() ?? "(no one-word reply)",
    );
  /** Whether Codex asked before the latest message's command, or replied without asking. */
  const askedBefore = (before) =>
    Promise.race([
      approvalCard(page)
        .waitFor({ timeout: TURN_MS })
        .then(() => true),
      replied(before).then(() => false),
      visible(page.getByText(/^The session couldn't start\./))
        .waitFor({ timeout: TURN_MS })
        .then(async () => {
          throw new Error(
            `the session didn't start: ${await visible(page.getByRole("alert")).innerText()}`,
          );
        }),
    ]);
  const menu = () => visible(page.getByRole("button", { name: /^Model for the next turn: / }));
  /** The page's buttons answer clicks: React has hydrated them. */
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((button) =>
        Object.keys(button).some((key) => key.startsWith("__reactProps")),
      ),
    );
  const checkbox = (name) => page.getByRole("menuitemcheckbox", { name, exact: true });
  /** What the session menu reads now: Ask before acting and Fast, each ticked or not. */
  const menuReads = async (shot) => {
    await menu().click();
    await checkbox("Ask before acting").waitFor();
    const ask = (await checkbox("Ask before acting").getAttribute("aria-checked")) === "true";
    const fast =
      (await checkbox("Fast").count()) > 0
        ? (await checkbox("Fast").getAttribute("aria-checked")) === "true"
        : null;
    if (shot !== undefined) await capture(shot);
    await page.keyboard.press("Escape");
    return { ask, fast };
  };
  const setInMenu = async (name, on) => {
    await menu().click();
    const box = checkbox(name);
    await box.waitFor();
    if (((await box.getAttribute("aria-checked")) === "true") !== on) await box.click();
    // A checkbox item keeps the menu open: close it.
    if (await box.isVisible()) await page.keyboard.press("Escape");
  };
  /** The newest turns' recorded choices, from the page's own conversation query. */
  const recordedChoices = (count) =>
    page.evaluate((n) => {
      const { queryClient } = window["__TSR_ROUTER__"].options.context;
      const turns = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
        .find((data) => Array.isArray(data?.turns))?.turns;
      return (turns ?? []).slice(-n).map((turn) => ({
        permission: turn.selection?.permissionMode ?? "(none)",
        speed: turn.selection?.speed ?? "(none)",
      }));
    }, count);
  /** Send `file`'s message and say whether Codex asked; answer it with `answer` when it does. */
  const turn = async (file, answer) => {
    const before = await replyCount();
    await send(DELETE(file));
    const asked = await askedBefore(before);
    if (asked) {
      await capture(`asked-${file.replace(/\..*$/, "")}`);
      await visible(page.getByRole("button", { name: answer, exact: true })).click();
      await approvalCard(page).waitFor({ state: "hidden", timeout: 60_000 });
      await replied(before);
    }
    return { asked, reply: await lastReply() };
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
  const askAtStart = page.getByRole("menuitemcheckbox", { name: "Ask before acting" });
  if ((await askAtStart.getAttribute("aria-checked")) === "true") await askAtStart.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(DELETE("launch-check.txt"));
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} skipping prompts; stop it with the checker CLI before release`);

  // 1. Launched skipping prompts: the opening `rm -f` runs without asking, as the menu reads.
  const launched = await askedBefore(0);
  if (launched) throw new Error("Codex asked before acting in a session launched skipping prompts");
  const opened = await menuReads("menu-launched");
  note(
    `launched skipping prompts: the opening rm -f ran with no card, Codex replied "${await lastReply()}", and the session menu reads Ask before acting ${opened.ask ? "ticked" : "unticked"}`,
  );

  // 2. Ticked once on the session's page: the next message asks.
  await setInMenu("Ask before acting", true);
  const first = await turn("approval-check.txt", "Approve");
  note(
    `ticked Ask before acting; the next message ${first.asked ? "asked; approved" : "ran WITHOUT asking"}, Codex replied "${first.reply}"`,
  );

  // 3. No tick in between: the menu still reads ticked, and the message after it asks too.
  const between = await menuReads("menu-after-approved-turn");
  const second = await turn("refused-check.txt", "Deny");
  note(
    `after that turn the menu reads Ask before acting ${between.ask ? "ticked" : "unticked"}; the second message ${second.asked ? "asked; denied" : "ran WITHOUT asking"}, Codex replied "${second.reply}"`,
  );

  // 4. Opened afresh: the menu reads ticked, and a third message asks.
  await page.reload();
  await field().waitFor({ timeout: 60_000 });
  await hydrated();
  await menu().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const reloaded = await menuReads("menu-after-reload");
  const third = await turn("reload-check.txt", "Approve");
  note(
    `after a reload the menu reads Ask before acting ${reloaded.ask ? "ticked" : "unticked"}; a third message ${third.asked ? "asked; approved" : "ran WITHOUT asking"}, Codex replied "${third.reply}"`,
  );

  // 5. Unticked with Fast on: the next two run without asking, and both on Fast.
  await setInMenu("Ask before acting", false);
  const fastOffered = (await menuReads()).fast !== null;
  if (fastOffered) await setInMenu("Fast", true);
  const fourth = await turn("untick-one.txt", "Approve");
  const fifth = await turn("untick-two.txt", "Approve");
  const after = await menuReads("menu-after-untick");
  note(
    `unticked${fastOffered ? " with Fast on" : " (no Fast offered)"}: the next two messages ${fourth.asked ? "ASKED" : "ran without asking"} and ${fifth.asked ? "ASKED" : "ran without asking"} (Codex replied "${fourth.reply}", "${fifth.reply}"); the menu reads Ask before acting ${after.ask ? "ticked" : "unticked"}, Fast ${after.fast ? "on" : "off"}; Mend recorded the last five turns as ${JSON.stringify(await recordedChoices(5))}`,
  );
  await capture("conversation-end");

  const holds =
    !launched && first.asked && between.ask && second.asked && reloaded.ask && third.asked;
  const releases = !fourth.asked && !fifth.asked && !after.ask;
  if (!holds || !releases)
    throw new Error("the session menu's choice and what Codex did disagreed: see the notes");
};
