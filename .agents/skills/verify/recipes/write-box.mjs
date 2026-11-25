// Writing to the agent on the box, with a real Codex turn (route PR 12, SLNT-1128): a message
// sent from the session's composer and answered, a message sent into the running turn, and Stop
// turn, after which the session's tab reads Replied (an idle session's word since #1903). Run it as the verify skill's section 9 says, under
// your own hold, and stop the session it starts before release:
//
//   pnpm verify drive web --box --recipe write-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session (the box's flows use Codex only) in
// verify-fixture from the New session composer, and prints its id; stop it with the checker CLI.
// A send that fails and Try again are driven locally (write), where a refusal can be forced.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  const send = async (words) => {
    await field().fill(words);
    await page.keyboard.press("Enter");
  };
  /** React has taken the page over: the composer's field answers to typing and Enter. */
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].some((textarea) =>
        Object.keys(textarea).some((key) => key.startsWith("__reactProps")),
      ),
    );
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  /**
   * Turn `n` ended with `reply`: its header, the agent's words, and the composer offering Send
   * again rather than Steer. A turn's header shows as soon as it starts, so the reply decides.
   */
  const turnEnded = async (n, reply) => {
    await visible(page.getByText(`Codex · turn ${n}`, { exact: true })).waitFor({
      timeout: TURN_MS,
    });
    await visible(page.getByText(reply)).waitFor({ timeout: TURN_MS });
    await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  };

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
  const ask = await page
    .getByRole("menuitemcheckbox", { name: "Ask before acting" })
    .getAttribute("aria-checked");
  note(`the New session composer's menu offers Ask before acting (checked: ${ask})`);
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(
    "Reply with the single word ready, and nothing else.",
  );
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} from the composer; stop it with the checker CLI before release`);
  await turnEnded(1, /^ready\.?$/i);

  // A message sent from the session's composer shows at once and is answered.
  const asked = "Reply with the single word pong, and nothing else.";
  await send(asked);
  const shownAt = Date.now();
  await visible(page.getByText(asked, { exact: true })).waitFor({ timeout: 5_000 });
  note(`the message showed in the conversation ${Date.now() - shownAt}ms after Enter`);
  if ((await field().inputValue()) !== "") throw new Error("the field kept the sent words");
  await turnEnded(2, /^pong\.?$/i);
  note("Codex answered the message in turn 2");
  await capture("box-message-answered-desktop-light");
  await page.reload();
  await hydrated();
  await visible(page.getByText(asked, { exact: true })).waitFor({ timeout: 60_000 });
  await visible(page.getByText(/^pong\.?$/i)).waitFor({ timeout: 60_000 });
  note("after a reload the message and its answer are still there");

  // While your own turn runs, a message goes into it.
  await send(
    "Run the shell command `sleep 45` and wait for it to finish, then reply with the single word slept.",
  );
  await stopTurn().waitFor({ timeout: 120_000 });
  await visible(page.getByRole("button", { name: "Steer" })).waitFor();
  note("turn 3 runs: the composer shows Steer and Stop turn");
  await capture("box-turn-running-desktop-light");
  const steer = "When you reply, add the word steered after slept.";
  await send(steer);
  const into = visible(
    page.getByText(/^Sent into this turn\. Codex reads it|^Codex read this during its turn$/),
  );
  await into.waitFor({ timeout: 60_000 });
  note(`the message sent while turn 3 runs reads "${await into.innerText()}"`);
  await capture("box-sent-into-the-turn-desktop-light");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await capture("box-sent-into-the-turn-phone-light");
  await page.setViewportSize(DESKTOP);
  await turnEnded(3, /^slept/i);
  const reply = await visible(page.getByText(/^slept/i)).innerText();
  const turns = await page.getByText(/^Codex · turn \d+$/).count();
  note(
    `turn 3 ended replying "${reply}"; ${turns} turns in all, so the message went into turn 3 rather than a turn of its own`,
  );

  // Stop turn stops the running turn, and the session reads Replied: idle, its turn over.
  await send(
    "Run the shell command `sleep 600` and wait for it to finish, then reply with the word done.",
  );
  await stopTurn().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(8_000);
  await stopTurn().click();
  await visible(page.getByText(/^This turn was stopped at/)).waitFor({ timeout: 120_000 });
  const tabWords = (await visible(page.getByRole("tab")).getAttribute("aria-label")) ?? "";
  if (!tabWords.includes("Replied")) throw new Error(`after Stop turn the tab reads "${tabWords}"`);
  note(`Stop turn stopped turn 4; the tab reads "${tabWords}"`);
  await capture("box-turn-stopped-desktop-light");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await capture("box-turn-stopped-phone-light");
  await page.setViewportSize(DESKTOP);

  // After the stop the composer sends again, and the next turn runs with what its menu picked.
  await visible(page.getByRole("button", { name: /^Model for the next turn: / })).click();
  await page.getByRole("menuitemcheckbox", { name: "Ask before acting" }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await send("Reply with the single word again, and nothing else.");
  await turnEnded(5, /^again\.?$/i);
  const permission = await page.evaluate(() => {
    const client = window["__TSR_ROUTER__"].options.context.queryClient;
    // The conversation's pages, as the page holds them: each carries its window's turns.
    const held = client.getQueryCache().findAll({ queryKey: [["sessions", "historyItems"]] });
    const all = held.flatMap((query) =>
      (query.state.data?.pages ?? []).flatMap((window) => window?.turns ?? []),
    );
    const newest = all.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    return newest?.selection?.permissionMode ?? null;
  });
  note(
    `after Stop turn the next message started turn 5, which Codex answered; it ran with permission "${permission}" picked in the menu`,
  );
  await capture("box-after-stop-desktop-light");
};
