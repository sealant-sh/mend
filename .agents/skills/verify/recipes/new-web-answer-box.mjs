// Answering the agent on the box, with a real Codex turn (route PR 14, SLNT-1138): Codex asks
// before acting, an approval approved and one refused from the composer card, the session's row
// leaving Waiting on you without a reload, an approval answered first in a second browser, and a
// question Codex asks, answered by a choice. Run it as the verify skill's section 9 says, under
// your own hold, and stop the session it starts before release:
//
//   pnpm verify drive new-web --box --recipe new-web-answer-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session (the box's
// flows use Codex only) in verify-fixture from the New session composer with Ask before acting
// on, and prints its id; stop it with the checker CLI. The states a real agent can't be made to
// reach on demand (an answer that couldn't send, someone else answering) are driven locally with
// fixtures (new-web-answer).
//
// Codex runs in the workspace with full access, so with Ask before acting (approval on request)
// it asks only before a command it counts as dangerous, such as `rm -f`: each approval here is one.
// Codex asks questions with its own tool only in plan mode, which no control of the new web app
// sets yet: the question's turn is sent through the app's own tRPC client with
// `interactionMode: "plan"`, and the card that answers it is the page's.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TURN_MS = 600_000;
const ASK_MS = 300_000;
/** A turn Codex asks about: it makes a file, then deletes it with a command it asks before. */
const DELETE = (file) =>
  `Run the shell command \`printf ok > ${file}\`, then delete the file by running exactly \`rm -f ${file}\`. Reply with the single word deleted if the file is gone, or kept if the deletion didn't run.`;

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

/** The composer card's approval, whichever Codex asks for: a command, or an edit. */
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
  /** Codex asks before a command: the card, or a clear failure saying it ran without asking. */
  const asks = async () => {
    const asked = await Promise.race([
      approvalCard(page)
        .waitFor({ timeout: ASK_MS })
        .then(() => true),
      page
        .waitForTimeout(20_000)
        .then(() => turnOver())
        .then(() => false),
    ]);
    if (!asked) throw new Error("Codex finished the turn without asking before acting");
    return approvalCard(page).innerText();
  };
  const lastReply = async () => {
    const replies = page.getByText(/^(deleted|kept)\.?$/i).filter({ visible: true });
    return (await replies.count()) > 0 ? replies.last().innerText() : "(no one-word reply)";
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
  await visible(page.getByRole("textbox", { name: "Task" })).fill(DELETE("approval-check.txt"));
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id} with Ask before acting; stop it with the checker CLI before release`);

  // Codex asks before deleting: the card in the composer, the marker in the thread, and the row
  // under Waiting on you.
  const asked = await asks();
  await visible(page.getByText(/· Waiting for your approval$/)).waitFor();
  const listed = await waiting(id)
    .first()
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  note(`Codex asked: "${asked}"; the row is ${listed ? "" : "not "}under Waiting on you`);
  await both("box-approval-asked");

  await visible(page.getByRole("button", { name: "Approve", exact: true })).click();
  await approvalCard(page).waitFor({ state: "hidden", timeout: 60_000 });
  const approvedLine = await visible(page.getByText(/^You approved/)).innerText();
  const left = await leftWaiting(id);
  note(
    `Approve: the card went, the thread reads "${approvedLine}", and the row ${left === null ? "stayed under Waiting on you for 30s" : `left Waiting on you ${left}ms later, with no reload`}`,
  );
  await turnOver();
  note(`after the approval Codex replied "${await lastReply()}"`);
  await both("box-approval-approved");

  // A second approval, refused: Codex carries on without running it.
  await send(DELETE("refused-check.txt"));
  await asks();
  await visible(page.getByRole("button", { name: "Deny", exact: true })).click();
  await approvalCard(page).waitFor({ state: "hidden", timeout: 60_000 });
  const deniedLine = await visible(page.getByText(/^You denied/)).innerText();
  note(`Deny: the card went and the thread reads "${deniedLine}"`);
  await turnOver();
  note(`after the denial Codex replied "${await lastReply()}"`);
  await both("box-approval-denied");

  // Answered first on another device: a second browser, signed in as the same person, approves
  // while this one shows the card.
  await send(DELETE("second-check.txt"));
  await asks();
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
  await visible(page.getByText("Already answered on another device.")).waitFor({
    timeout: 60_000,
  });
  note(
    "approved in a second browser first: this one's card went and the band says it was answered on another device, with Dismiss",
  );
  await both("box-approval-answered-elsewhere");
  await visible(page.getByRole("button", { name: "Dismiss" })).click();
  await turnOver();

  // A question: Codex asks with its own tool in plan mode; Keep is picked and sent from the card.
  const question =
    "Use your request_user_input tool to ask me one question: should the file approval-check.txt be kept or deleted, with exactly two options, Keep and Delete. Wait for my answer, then reply with the single word I chose and do nothing else.";
  await page.evaluate(
    async ({ sessionId, words }) => {
      const { trpcClient } = window["__TSR_ROUTER__"].options.context;
      await trpcClient.sessions.sendMessage.mutate({
        id: sessionId,
        input: words,
        clientMessageId: crypto.randomUUID(),
        selection: {
          harness: "codex",
          model: null,
          effort: null,
          interactionMode: "plan",
          permissionMode: "ask",
        },
      });
    },
    { sessionId: id, words: question },
  );
  const asking = visible(page.getByText(/^Asked you a question · Waiting for your answer$/));
  const askedQuestion = await Promise.race([
    asking.waitFor({ timeout: ASK_MS }).then(() => true),
    page
      .waitForTimeout(20_000)
      .then(() => turnOver())
      .then(() => false),
  ]).catch(() => false);
  if (!askedQuestion) {
    note(
      "Codex, in plan mode, didn't ask a question with its tool when told to: the question states are shown from fixtures in new-web-answer",
    );
    return;
  }
  await both("box-question-asked");
  await visible(page.getByRole("radio", { name: /^Keep/ })).click();
  await visible(page.getByRole("button", { name: "Send" })).click();
  await visible(page.getByText(/^You chose Keep/)).waitFor({ timeout: 60_000 });
  note(
    "Codex asked a question with Keep and Delete; Keep was picked and sent with the composer's send button, and the thread reads You chose Keep",
  );
  await turnOver().catch(() => undefined);
  await both("box-question-answered");
};
