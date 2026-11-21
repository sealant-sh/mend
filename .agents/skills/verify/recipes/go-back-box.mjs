// Going back to a checkpoint with a real Codex turn, on the box (SLNT-1259): turns write BACK.md
// "first", then "second"; going back to the second turn's checkpoint is refused while a third turn
// (writing "third", then sleeping) works, and goes through once it ends; the agent's next turn
// reads the note Mend sends ahead of the person's words and finds "second", and the line in the
// conversation undoes it ("third" again). Run it as the verify skill's section 9 says, under your own hold:
//
//   pnpm verify drive web --box --recipe go-back-box
//
// It stops the session it starts. The parts a local stack shows (the dialog from the range picker,
// the files read back between checkpoints) are recipes/go-back.mjs.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const FIRST =
  "Create a file named BACK.md containing the one line: first. Change nothing else. Reply in one sentence.";
const SECOND =
  "Replace the line in BACK.md with: second. Change nothing else. Reply in one sentence.";
const SLOW =
  "Replace the line in BACK.md with: third. Then run sleep 45 in the shell, and reply with the single word done.";
const ASK =
  "Before my message, did Mend tell you anything about this worktree's files? Say what in one sentence, then reply with the exact contents of BACK.md.";
const BUSY =
  "An agent in this worktree is working. Stop its turn or wait for it to end, then try again.";
const TURN_MS = 600_000;

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
  const shot = async (name, themes = ["light", "dark"]) => {
    for (const theme of themes) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  const composerReady = () =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll("textarea")].some((textarea) =>
          Object.keys(textarea).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  /** Waits until `count` turns have ended in the conversation. */
  const turnsEnded = (count) =>
    page.waitForFunction(
      (want) =>
        [...document.querySelectorAll("body *")].filter(
          (each) =>
            each.childElementCount === 0 &&
            (each.textContent ?? "").startsWith("Worked for") &&
            each.getClientRects().length > 0,
        ).length >= want,
      count,
      { timeout: TURN_MS },
    );
  const send = async (words) => {
    await composerReady();
    await field().fill(words);
    await page.keyboard.press("Enter");
  };
  const checkpointLines = () =>
    page.getByRole("button", { name: /^Checkpoint · / }).filter({ visible: true });
  const details = () => visible(page.getByRole("dialog"));
  const detailOf = (id) =>
    page.evaluate(async (sessionId) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      const detail = await trpcClient.sessions.detail.query({ id: sessionId });
      return {
        worktreeId: detail.session.worktreeId,
        restores: detail.restores.map((restore) => ({
          target: restore.target,
          saved: restore.saved,
          result: restore.result,
        })),
      };
    }, id);
  const between = (worktreeId, from, to) =>
    page.evaluate(
      async (input) => {
        const { trpcClient } = window["__TSR_ROUTER__"].options.context;
        return (await trpcClient.worktrees.sliceFiles.query(input)).paths.toSorted();
      },
      { id: worktreeId, from, to },
    );

  // A Codex session on verify-fixture writes BACK.md, then rewrites it.
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
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(FIRST);
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started Codex session ${id} on verify-fixture`);
  try {
    await turnsEnded(1);
    await send(SECOND);
    await turnsEnded(2);
    await checkpointLines().first().waitFor({ timeout: 60_000 });
    const chain = await page.evaluate(async (sessionId) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      const detail = await trpcClient.sessions.detail.query({ id: sessionId });
      return detail.checkpoints.map(
        (each) => `${each.ordinal} ${each.trigger} ${new Date(each.createdAt).toISOString()}`,
      );
    }, id);
    const shownLines = await checkpointLines().count();
    note(
      `two turns ended; the conversation shows ${shownLines} checkpoint line(s); the chain: ${chain.join(", ")}`,
    );
    // The second turn's line: the last one shown now.
    await checkpointLines().last().click();
    const title = await details()
      .getByText(/^Checkpoint \d+/)
      .first()
      .innerText();
    const ordinal = Number(/Checkpoint (\d+)/.exec(title)?.[1]);
    await page.keyboard.press("Escape");
    const turnTwoLine = () =>
      visible(
        page.locator(`#checkpoint-${ordinal}`).getByRole("button", { name: /^Checkpoint · / }),
      );
    note(`the second turn's line is checkpoint ${ordinal}`);

    // While a turn works, going back is refused and nothing changes.
    await send(SLOW);
    await visible(page.getByRole("button", { name: "Stop turn" })).waitFor({ timeout: 120_000 });
    await turnTwoLine().click();
    await details().getByRole("button", { name: "Go back to this checkpoint…" }).click();
    const confirm = () =>
      visible(page.getByRole("dialog").filter({ hasText: "Go back to checkpoint" }));
    await confirm().getByRole("button", { name: "Go back", exact: true }).click();
    await confirm().getByText(BUSY).waitFor({ timeout: 60_000 });
    note(`going back while the third turn works reads: "${BUSY}"`);
    await shot("go-back-busy-box-desktop");
    if ((await detailOf(id)).restores.length !== 0)
      throw new Error("a restore was recorded while the agent worked");
    await confirm().getByRole("button", { name: "Cancel" }).click();
    await turnsEnded(3);

    // Once it ends, going back goes through.
    const target = await turnTwoLine().innerText();
    await turnTwoLine().click();
    await details().getByRole("button", { name: "Go back to this checkpoint…" }).click();
    await confirm().getByText(`Go back to checkpoint ${ordinal}?`).waitFor();
    await shot("go-back-confirm-box-desktop");
    await confirm().getByRole("button", { name: "Go back", exact: true }).click();
    const toast = page.getByText(`Went back to checkpoint ${ordinal}.`, { exact: false });
    await toast.waitFor({ timeout: 180_000 });
    note(
      `going back to the second turn's line ("${target}") says: "${(await toast.innerText()).replace(/\s+/g, " ")}"`,
    );
    const [restore] = (await detailOf(id)).restores;
    if (restore === undefined || restore.target.ordinal !== ordinal)
      throw new Error("the session's details list no restore to that checkpoint");
    const { worktreeId } = await detailOf(id);
    const left = await between(worktreeId, restore.target.id, restore.result.id);
    if (left.length !== 0)
      throw new Error(`after going back, the files differ in ${left.join(", ")}`);
    note(
      `the files at checkpoint ${restore.result.ordinal} match ${restore.target.ordinal}; Mend saved them first as ${restore.saved.ordinal}`,
    );
    const line = () =>
      visible(page.getByRole("button", { name: `Went back to checkpoint ${ordinal}` }));
    await line().waitFor({ timeout: 30_000 });
    await shot("go-back-line-box-desktop");

    // The agent's next turn: Mend told it, and it reads the file as it was.
    await send(ASK);
    await turnsEnded(4);
    const bubble = visible(
      page.locator('[data-slot="user-message"]').filter({ hasText: "did Mend tell you" }),
    );
    const shown = (await bubble.innerText()).replace(/\s+/g, " ");
    if (/Note from Mend/.test(shown))
      throw new Error(`the person's message shows the note: "${shown}"`);
    // Everything the conversation shows after the person's question: Codex's reply to it.
    const reply = await page.evaluate((asked) => {
      const items = [...document.querySelectorAll('[data-slot="conversation-item"]')].filter(
        (each) => each.getClientRects().length > 0,
      );
      const at = items.findIndex((each) => each.textContent?.includes(asked));
      return items
        .slice(at + 1)
        .map((each) => each.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ");
    }, "did Mend tell you");
    note(`the person's message reads as typed; Codex replied: "${reply}"`);
    if (!/second/.test(reply)) throw new Error("Codex's reply doesn't give BACK.md as 'second'");
    await shot("go-back-agent-told-box-desktop");

    // The line undoes it: the saved checkpoint's files come back.
    await line().click();
    await details()
      .getByRole("button", { name: `Go back to checkpoint ${restore.saved.ordinal}…` })
      .click();
    await confirm().getByRole("button", { name: "Go back", exact: true }).click();
    await page
      .getByText(`Went back to checkpoint ${restore.saved.ordinal}.`, { exact: false })
      .waitFor({ timeout: 180_000 });
    const undo = (await detailOf(id)).restores.at(-1);
    const after = await between(worktreeId, restore.saved.id, undo.result.id);
    if (after.length !== 0)
      throw new Error(`after the undo, the files differ in ${after.join(", ")}`);
    note(
      `undone: the files at ${undo.result.ordinal} match the saved ${restore.saved.ordinal}, BACK.md "third" again`,
    );
    await shot("go-back-undone-box-desktop");
    await page.setViewportSize(PHONE);
    await settled();
    await shot("go-back-lines-box-phone");
    await page.setViewportSize(DESKTOP);
  } finally {
    await page.evaluate(async (sessionId) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      await trpcClient.sessions.stop.mutate({ id: sessionId }).catch(() => undefined);
    }, id);
    note(`stopped session ${id}`);
  }
};
