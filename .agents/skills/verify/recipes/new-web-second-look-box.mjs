// Second look on the server, for real (SLNT-1176, server PR): a real Codex turn writes a file, two
// comments go back to it, and the agent's answer, "since your last review", replies and where a
// comment now sits are read through the new app's own tRPC router, as the signed-in checker. No UI
// of this yet (the web PR builds it): every observation is the server's answer, written to
// steps.log. Run it as the verify skill's section 9 says, under your own hold, on a box running a
// preview of this branch, and stop the session it starts before release:
//
//   pnpm verify drive new-web --box --recipe new-web-second-look-box
const DESKTOP = { width: 1280, height: 900 };
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
const LINE_COMMENT = "Rename `i` to `attempt` on this line.";
const CHANGE_COMMENT = "Keep the signature `retry(fn, attempts)` as it is.";
const REPLY = "Thanks. Also add a one-line comment above the loop saying what it does.";

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();
/** A call's answer, or a thrown refusal with what the server said. */
const must = async (what, answer) => {
  const value = await answer;
  if (value !== null && typeof value === "object" && "refused" in value)
    throw new Error(`${what} was refused: ${JSON.stringify(value.refused)}`);
  return value;
};
const short = (value) => JSON.stringify(value);
/** Whether the newest answer under a comment is from a turn that has ended. */
const ended = (row) =>
  row?.answers?.length > 0 &&
  !["queued", "running"].includes(row.answers[row.answers.length - 1].turnStatus);

export default async ({ page, web, note }) => {
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
  /** A tRPC call from the page, as the signed-in person; a refusal comes back as `{ refused }`. */
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: at, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of at.split(".")) target = target[part];
        try {
          return await target[verb](value);
        } catch (error) {
          return { refused: { message: error.message, data: error.data ?? null } };
        }
      },
      { route, input, kind },
    );
  const waitFor = async (what, check, seconds) => {
    for (let waited = 0; waited < seconds; waited += 5) {
      const answer = await check();
      if (answer !== null && answer !== undefined && answer !== false) return answer;
      await page.waitForTimeout(5_000);
    }
    throw new Error(`${what} did not happen within ${seconds} s`);
  };
  const stamp = Date.now();

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
  await hydrated();

  const detail = await must("sessions.detail", call("sessions.detail", { id: session }));
  const change = detail.change?.id;
  if (change === undefined) throw new Error("the session has no change");
  const openComments = async () =>
    (await must("sessions.inboxRow", call("sessions.inboxRow", { id: session }))).annotation
      ?.openComments ?? "absent";

  // 1. The whole change, as every client opens it today: no range.
  const whole = await must(
    "openReview",
    call(
      "changes.openReview",
      { id: change, request: { idempotencyKey: `second-look-whole-${stamp}` } },
      "mutate",
    ),
  );
  note(
    `open with no range: checkpoints ${whole.checkpointA.ordinal} → ${whole.checkpointB.ordinal}, range ${short(whole.range)}, lastReview ${short(whole.lastReview)}`,
  );
  const diff = await must(
    "reviewDiff",
    call("changes.reviewDiff", { id: change, sliceId: whole.slice.id }),
  );
  const file = diff.anchorFiles.find((candidate) => candidate.newPath === FILE);
  if (file === undefined) throw new Error(`${FILE} is not in the change`);
  const loopLine = LINES.findIndex((line) => line.startsWith("  for ")) + 1;
  const hunk = file.hunks.find(
    (candidate) =>
      candidate.newStart <= loopLine && loopLine < candidate.newStart + candidate.newLines,
  );
  const lineComment = await must(
    "postSliceComment (line)",
    call(
      "changes.postSliceComment",
      {
        id: change,
        sliceId: whole.slice.id,
        comment: {
          target: {
            oldPath: null,
            newPath: FILE,
            side: "new",
            startLine: loopLine,
            endLine: loopLine,
            hunkContextHash: hunk?.contextHash ?? null,
          },
          body: LINE_COMMENT,
        },
      },
      "mutate",
    ),
  );
  const changeComment = await must(
    "postSliceComment (whole change)",
    call(
      "changes.postSliceComment",
      {
        id: change,
        sliceId: whole.slice.id,
        comment: {
          target: {
            oldPath: null,
            newPath: null,
            side: null,
            startLine: null,
            endLine: null,
            hunkContextHash: null,
          },
          body: CHANGE_COMMENT,
        },
      },
      "mutate",
    ),
  );
  note(`commented on ${FILE} line ${loopLine} and on the whole change`);
  const before = await must("comments", call("changes.comments", { id: change }));
  note(
    `before sending: ${before.length} comments, answers ${short(before.map((row) => row.answers?.length ?? "absent"))}, sentInTurn ${short(before.map((row) => row.sentInTurn ?? null))}`,
  );

  // 2. Send both to Codex, as Send does.
  const instruction = [
    "Please address these review comments on the change:",
    "",
    `1. ${FILE} line ${loopLine}: ${LINE_COMMENT}`,
    `2. On the whole change: ${CHANGE_COMMENT}`,
  ].join("\n");
  const sent = await must(
    "deliverFollowUp",
    call(
      "sessions.deliverFollowUp",
      {
        id: session,
        request: {
          reviewSliceId: whole.slice.id,
          checkpointAId: whole.checkpointA.id,
          checkpointBId: whole.checkpointB.id,
          diffDigest: whole.slice.diffDigest,
          commentIds: [lineComment.id, changeComment.id],
          instruction,
          idempotencyKey: `second-look-send-${stamp}`,
        },
      },
      "mutate",
    ),
  );
  note(`sent 2 comments: follow-up ${sent.id} ${sent.status}`);
  await waitFor(
    "the agent's turn on the comments",
    async () => {
      const rows = await must("comments", call("changes.comments", { id: change }));
      return ended(rows.find((row) => row.id === lineComment.id));
    },
    900,
  );
  note("the agent's turn on the comments ended");

  // 3. Since your last review: from the checkpoint the send named, to the change as it is now.
  const since = await must(
    "openReview since",
    call(
      "changes.openReview",
      {
        id: change,
        request: { idempotencyKey: `second-look-since-${stamp}`, range: { from: "last-review" } },
      },
      "mutate",
    ),
  );
  note(
    `open since your last review: checkpoints ${since.checkpointA.ordinal} → ${since.checkpointB.ordinal}, range ${short(since.range)}, lastReview ${short(since.lastReview)} (the send named checkpoint ${whole.checkpointB.ordinal})`,
  );
  const sinceDiff = await must(
    "reviewDiff since",
    call("changes.reviewDiff", { id: change, sliceId: since.slice.id }),
  );
  note(
    `its diff: files ${short(sinceDiff.files.map((row) => `${row.newPath ?? row.oldPath} +${row.additions} -${row.deletions}`))}, unchangedInRange ${short(sinceDiff.unchangedInRange ?? "absent")}`,
  );
  note(`its patch:\n${sinceDiff.patch.slice(0, 1500)}`);

  // 4. The agent's answer under each comment, and where each comment sits on the new review.
  const answered = await must(
    "comments on since",
    call("changes.comments", { id: change, sliceId: since.slice.id }),
  );
  for (const row of answered) {
    const answer = row.answers?.at(-1);
    note(
      `comment "${row.body}": sentInTurn ${row.sentInTurn}, answer ${short({
        harness: answer?.harness,
        turnOrdinal: answer?.turnOrdinal,
        turnStatus: answer?.turnStatus,
        outcome: answer?.outcome,
        changedAt: answer?.changedAt,
      })}, body "${answer?.body ?? ""}", placement ${short(row.placement ?? "absent")}`,
    );
  }
  note(`open comments on the session's row (what older clients count): ${await openComments()}`);

  // 5. A reply, and the replies Mend won't keep.
  const reply = await must(
    "reply",
    call(
      "changes.reply",
      { id: change, commentId: lineComment.id, reply: { body: REPLY } },
      "mutate",
    ),
  );
  note(
    `reply to the line comment: ${short({ id: reply.id, parentId: reply.parentId, state: reply.state })}`,
  );
  const twoDeep = await call(
    "changes.reply",
    { id: change, commentId: reply.id, reply: { body: "Two deep." } },
    "mutate",
  );
  note(`reply to that reply: ${short(twoDeep.refused ?? twoDeep)}`);
  const empty = await call(
    "changes.reply",
    { id: change, commentId: changeComment.id, reply: { body: "   " } },
    "mutate",
  );
  note(`empty reply: ${short(empty.refused ?? empty)}`);
  const threads = await must("comments", call("changes.comments", { id: change }));
  note(
    `the list now: ${threads.length} comments, the reply listed as a comment: ${threads.some((row) => row.id === reply.id)}, replies under the line comment ${short(threads.find((row) => row.id === lineComment.id)?.replies?.map((entry) => entry.body))}`,
  );
  note(`open comments on the session's row after the reply: ${await openComments()}`);

  // 6. Ranges Mend won't open.
  const reversed = await call(
    "changes.openReview",
    {
      id: change,
      request: {
        idempotencyKey: `second-look-reversed-${stamp}`,
        range: { from: since.checkpointB.id, to: since.checkpointA.id },
      },
    },
    "mutate",
  );
  note(
    `a range from checkpoint ${since.checkpointB.ordinal} to ${since.checkpointA.ordinal}: ${short(reversed.refused ?? reversed)}`,
  );
  const elsewhere = await call(
    "changes.openReview",
    {
      id: change,
      request: {
        idempotencyKey: `second-look-elsewhere-${stamp}`,
        range: { from: "checkpoint-not-in-this-change" },
      },
    },
    "mutate",
  );
  note(`a range from a checkpoint not in this change: ${short(elsewhere.refused ?? elsewhere)}`);

  // 7. The reply goes to the agent like any comment, and it answers in a new turn.
  const latest = await must(
    "openReview for the reply",
    call(
      "changes.openReview",
      { id: change, request: { idempotencyKey: `second-look-reply-${stamp}` } },
      "mutate",
    ),
  );
  const replySent = await must(
    "deliverFollowUp (reply)",
    call(
      "sessions.deliverFollowUp",
      {
        id: session,
        request: {
          reviewSliceId: latest.slice.id,
          checkpointAId: latest.checkpointA.id,
          checkpointBId: latest.checkpointB.id,
          diffDigest: latest.slice.diffDigest,
          commentIds: [reply.id],
          instruction: `A reply on ${FILE} line ${loopLine}: ${REPLY}`,
          idempotencyKey: `second-look-reply-send-${stamp}`,
        },
      },
      "mutate",
    ),
  );
  note(`sent the reply: follow-up ${replySent.id} ${replySent.status}`);
  const two = await waitFor(
    "the agent's turn on the reply",
    async () => {
      const rows = await must("comments", call("changes.comments", { id: change }));
      const row = rows.find((candidate) => candidate.id === lineComment.id);
      return row?.answers?.length === 2 && ended(row) ? row : null;
    },
    900,
  );
  note(
    `the line comment now has ${two.answers.length} answers, turns ${short(two.answers.map((answer) => answer.turnOrdinal))}; the reply reads sent to ${short(two.replies?.map((entry) => entry.sentToSessionId))}`,
  );
  note(`done; stop session ${session}`);
};
