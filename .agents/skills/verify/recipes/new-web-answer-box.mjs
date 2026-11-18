// Answering the agent on the box, with a real Codex turn (route PR 14, SLNT-1138): Codex asks
// before acting, an approval approved and one refused from the composer card, the session's row
// leaving Waiting on you without a reload, a question answered if Codex asks one, and an approval
// answered first in a second browser. Run it as the verify skill's section 9 says, under your own
// hold, and stop the session it starts before release:
//
//   pnpm verify drive new-web --box --recipe new-web-answer-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session (the box's
// flows use Codex only) in verify-fixture from the New session composer with Ask before acting
// on, and prints its id; stop it with the checker CLI. The states a real agent can't be made to
// reach on demand (an answer that couldn't send, someone else answering) are driven locally with
// fixtures (new-web-answer).
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const ASK_MS = 240_000;
/**
 * Codex runs in the workspace with full access, so "Ask before acting" (approval on request) asks
 * only when Codex itself asks for escalated permissions: each prompt tells it to.
 */
const ESCALATE =
  " Run it with escalated permissions (sandbox_permissions require_escalated, with a one-line justification), so I am asked to approve it first.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

/** The composer card's approval, whichever Codex asks for: a command, or an edit. */
const approvalCard = (page) =>
  visible(page.getByText(/^Codex wants to (run a command|edit a file|edit \d+ files|use a tool)$/));

export default async ({ page, web, capture, note }) => {
  const field = (on = page) => visible(on.getByRole("textbox", { name: "Message Codex" }));
  const send = async (words) => {
    await field().fill(words);
    await page.keyboard.press("Enter");
  };
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  const both = async (name) => {
    await capture(`${name}-desktop-light`);
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(500);
    await capture(`${name}-phone-light`);
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(500);
  };
  const waiting = (id) =>
    page
      .getByRole("navigation", { name: "Inbox" })
      .getByRole("region", { name: "Waiting on you", exact: true })
      .locator(`a[href="/sessions/${id}"]`);
  /** The row leaves Waiting on you without a reload: how long it took, or null if it stayed. */
  const leftWaiting = async (id) => {
    const from = Date.now();
    for (let waited = 0; waited < 60; waited += 1) {
      if ((await waiting(id).count()) === 0) return Date.now() - from;
      await page.waitForTimeout(500);
    }
    return null;
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
  const ask = page.getByRole("menuitemcheckbox", { name: "Ask before acting" });
  if ((await ask.getAttribute("aria-checked")) !== "true") await ask.click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(
    `Create a file named approval-check.txt holding the word ok by running the shell command \`printf ok > approval-check.txt\`.${ESCALATE} Then reply with the single word created.`,
  );
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} with Ask before acting; stop it with the checker CLI before release`);

  // Codex asks before running the command: the card in the composer, the marker in the thread,
  // and the row under Waiting on you.
  await approvalCard(page).waitFor({ timeout: TURN_MS });
  const asked = await approvalCard(page).innerText();
  await visible(page.getByText(/· Waiting for your approval$/)).waitFor();
  await waiting(id).first().waitFor({ timeout: 60_000 });
  note(`Codex asked: "${asked}"; the row is under Waiting on you`);
  await both("box-approval-asked");

  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  await approvalCard(page).waitFor({ state: "hidden", timeout: 60_000 });
  const approvedLine = await visible(page.getByText(/^You approved/)).innerText();
  const left = await leftWaiting(id);
  note(
    `Approve: the card went, the thread reads "${approvedLine}", and the row ${left === null ? "stayed under Waiting on you for 30s" : `left Waiting on you ${left}ms later, with no reload`}`,
  );
  await visible(page.getByText(/^created\.?$/i)).waitFor({ timeout: TURN_MS });
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  await both("box-approval-approved");

  // A second approval, refused: Codex carries on without running it.
  await send(
    `Delete approval-check.txt by running the shell command \`rm approval-check.txt\`.${ESCALATE} If you couldn't run it, reply with the single word kept; otherwise reply with the single word deleted.`,
  );
  await approvalCard(page).waitFor({ timeout: TURN_MS });
  await visible(page.getByRole("button", { name: "Deny", exact: true })).click();
  await approvalCard(page).waitFor({ state: "hidden", timeout: 60_000 });
  const deniedLine = await visible(page.getByText(/^You denied/)).innerText();
  note(`Deny: the card went and the thread reads "${deniedLine}"`);
  const after = visible(page.getByText(/^(kept|deleted)\.?$/i));
  await after.waitFor({ timeout: TURN_MS }).catch(() => undefined);
  note(
    `after the denial Codex replied "${(await after.count()) > 0 ? await after.innerText() : "(no one-word reply)"}"`,
  );
  await stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  await both("box-approval-denied");

  // A question, if Codex will ask one with its tool for asking: picked by choice.
  await send(
    "Use your tool for asking the user a question to ask me whether approval-check.txt should be kept or deleted, offering exactly the two choices Keep and Delete. Wait for my answer, then reply with the single word I chose and do nothing else.",
  );
  const question = visible(page.getByText(/^Asked you a question · Waiting for your answer$/));
  const askedQuestion = await Promise.race([
    question.waitFor({ timeout: ASK_MS }).then(() => true),
    stopTurn()
      .waitFor({ state: "hidden", timeout: ASK_MS })
      .then(async () => {
        await page.waitForTimeout(3_000);
        return (await question.count()) > 0;
      }),
  ]).catch(() => false);
  if (askedQuestion) {
    await both("box-question-asked");
    await visible(page.getByRole("radio", { name: /^Keep/ })).click();
    await page.keyboard.press("Enter").catch(() => undefined);
    await visible(page.getByRole("button", { name: "Send" }))
      .click()
      .catch(() => undefined);
    await visible(page.getByText(/^You chose Keep/)).waitFor({ timeout: 60_000 });
    await visible(page.getByText(/^Keep\.?$/i))
      .waitFor({ timeout: TURN_MS })
      .catch(() => undefined);
    note(
      "Codex asked a question with Keep and Delete; Keep was picked and sent, and the thread reads You chose Keep",
    );
    await both("box-question-answered");
  } else
    note(
      "Codex didn't ask a question with its tool when told to (it answered in words, or not at all within 4 minutes): the question states are shown from fixtures in new-web-answer",
    );
  await stopTurn()
    .waitFor({ state: "hidden", timeout: TURN_MS })
    .catch(() => undefined);

  // Answered first on another device: a second browser, signed in as the same person, approves
  // while this one shows the card.
  await send(
    `Create a file named second-check.txt holding the word ok by running the shell command \`printf ok > second-check.txt\`.${ESCALATE} Then reply with the single word created.`,
  );
  await approvalCard(page).waitFor({ timeout: TURN_MS });
  const other = await page
    .context()
    .browser()
    .newContext({ storageState: await page.context().storageState() });
  try {
    const phone = await other.newPage();
    await phone.setViewportSize(PHONE);
    await phone.goto(`${web}/sessions/${id}`);
    await approvalCard(phone).waitFor({ timeout: 120_000 });
    await visible(phone.getByRole("button", { name: "Approve", exact: true })).click();
    await approvalCard(phone).waitFor({ state: "hidden", timeout: 60_000 });
  } finally {
    await other.close();
  }
  await visible(page.getByText("Already answered on another device.")).waitFor({ timeout: 60_000 });
  note(
    "approved in a second browser first: this one's card went and the band says it was answered on another device, with Dismiss",
  );
  await both("box-approval-answered-elsewhere");
  await visible(page.getByText(/^created\.?$/i).nth(1))
    .waitFor({ timeout: TURN_MS })
    .catch(() => undefined);
};
