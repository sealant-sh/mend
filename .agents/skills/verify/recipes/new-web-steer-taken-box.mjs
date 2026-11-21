// A message sent into a running turn, with a real Codex turn (SLNT-1234): dashed, with "Sent into
// this turn. Codex reads it when its current step finishes.", until Codex takes it at its next
// step; from then on, while the turn still runs, it reads as any sent message (solid, no line
// under it), and it sits where Codex took it: the command Codex was running when it was sent stays
// above it, the work after it below. Run it against a server built from the commit under test:
//
//   pnpm verify drive new-web --box --recipe new-web-steer-taken-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session in
// verify-fixture from the New session composer and prints its id: stop it with the checker CLI.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const WAITING = "Sent into this turn. Codex reads it when its current step finishes.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  const send = async (words) => {
    await field().fill(words);
    await page.keyboard.press("Enter");
  };
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].some((textarea) =>
        Object.keys(textarea).some((key) => key.startsWith("__reactProps")),
      ),
    );
  /** The person's message bubble that holds `words`, as a person sees it. */
  const bubble = (words) =>
    visible(page.locator('[data-slot="user-message"]').filter({ hasText: words }));
  /** Whether the bubble is drawn dashed, and the line under it. */
  const looks = async (words) => {
    const message = bubble(words);
    return {
      pending: (await message.getAttribute("data-pending")) !== null,
      byline: (await message.locator('[data-slot="message-footer"]').innerText()).trim(),
    };
  };
  /** Each thing's place on the page from the top, to read their order. */
  const top = async (locator) => (await locator.boundingBox())?.y ?? Number.NaN;

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
  await visible(page.getByRole("textbox", { name: "Task" })).fill(
    "Reply with the single word ready, and nothing else.",
  );
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} from the composer; stop it with the checker CLI`);
  await visible(page.getByText(/^ready\.?$/i)).waitFor({ timeout: TURN_MS });
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });

  // A turn with two steps: the message goes in during the first, and Codex reads it before the
  // second, which leaves the turn running after it took the message.
  await send(
    "Run the shell command `sleep 30` and wait for it to finish. Then run the shell command `sleep 40` and wait for it to finish. Then reply with the single word slept.",
  );
  await stopTurn().waitFor({ timeout: 120_000 });
  const firstSleep = visible(page.getByText(/sleep 30/).last());
  await firstSleep.waitFor({ timeout: 120_000 });
  note("turn 2 runs `sleep 30`");

  const steer = "When you reply, add the word steered after slept.";
  await send(steer);
  await bubble(steer).waitFor({ timeout: 30_000 });
  await page.getByText(WAITING).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
  const waiting = await looks(steer);
  if (!waiting.pending) throw new Error("the message sent into the turn was never drawn dashed");
  note(
    `sent into turn 2 while it ran sleep 30: dashed, the line under it reads "${waiting.byline}"`,
  );
  await capture("steer-waiting-desktop-light");

  // Codex takes the words when `sleep 30` ends, at its next step: the bubble turns solid.
  const sentAt = Date.now();
  await page.waitForFunction(
    (words) =>
      [...document.querySelectorAll('[data-slot="user-message"]')].some(
        (message) =>
          message.textContent?.includes(words) &&
          message.getClientRects().length > 0 &&
          !message.hasAttribute("data-pending"),
      ),
    steer,
    { timeout: 180_000 },
  );
  const taken = await looks(steer);
  const stillRunning = await stopTurn().isVisible();
  note(
    `${Math.round((Date.now() - sentAt) / 1000)}s later the message is solid; the line under it reads "${taken.byline}"; turn 2 still running: ${stillRunning}`,
  );
  if (taken.byline.includes("Sent into this turn") || taken.byline.includes("read this during"))
    throw new Error(`a taken message still reads "${taken.byline}"`);
  if (!stillRunning) throw new Error("turn 2 ended before the check could see it running");
  await capture("steer-taken-turn-running-desktop-light");
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(500);
  await capture("steer-taken-turn-running-phone-light");
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(500);

  // Where it sits: below the command Codex ran when it was sent, above what Codex did after.
  const secondSleep = visible(page.getByText(/sleep 40/).last());
  await secondSleep.waitFor({ timeout: 120_000 });
  const [before, message, after] = [
    await top(firstSleep),
    await top(bubble(steer)),
    await top(secondSleep),
  ];
  note(
    `from the top: sleep 30 at ${before}px, the message at ${message}px, sleep 40 at ${after}px`,
  );
  if (!(before < message && message < after))
    throw new Error("the message isn't between the step before it was read and the one after");

  await visible(page.getByText(/^slept/i)).waitFor({ timeout: TURN_MS });
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  const reply = await visible(page.getByText(/^slept/i)).innerText();
  const ended = await looks(steer);
  note(`turn 2 ended replying "${reply}"; the message still reads "${ended.byline}"`);
  if (ended.pending) throw new Error("the message turned dashed again after the turn ended");
  await capture("steer-turn-ended-desktop-light");

  await page.reload();
  await hydrated();
  await bubble(steer).waitFor({ timeout: 60_000 });
  const reloaded = await looks(steer);
  if (reloaded.pending || reloaded.byline.includes("Sent into this turn"))
    throw new Error("after a reload the message reads as waiting again");
  note(`after a reload the message is still solid: "${reloaded.byline}"`);
};
