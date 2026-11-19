// Comments on a change and sending them to the agent, in the new web app's Change view (route PR
// 24, SLNT-1166). Walks review-change.md's `review-inline-comment`, `review-change-comment`,
// `review-comment-state` and Suggest fixes from `review-machine-pass`, and send-review-back.md's
// `send-open`, `send-select`, `send-edit`, `send-deliver`, `send-pending` and `send-sent-state`.
// Run the Change view's CLI batch first, once per stack:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-change-sessions.json
//   pnpm verify drive new-web --recipe new-web-comments
//
// For real, against the stack: a comment on one line (a click on its number), on a range (a drag
// across numbers), on lines typed from the keyboard, and on the whole change; Resolve, Reopen and
// Dismiss; Read this change and Suggest fixes (the stack's fake agent login fails both passes);
// and a send, which the stack refuses because change-small's sessions are `mend run` commands
// with no agent to take it. Fixtures in the browser, over real reads: the session read as Claude
// Code's, so Send shows; Mend's drafts (no pass can write one here); and the server's answers for
// a delivered, a pending and a failed send. Light and dark, 1280px and 390px.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { patchDetail, superjson } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const RETRY = "src/payments/retry.ts";
const FILES = [RETRY, "src/payments/charge.ts", "src/payments/charge.test.ts"];

/** The first of `locator`'s matches a person can see: under 1024px every tab is in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

/** Mend's drafts: one with a suggested replacement on retry.ts, and one already dismissed. */
const draftComments = (changeId) => {
  const at = new Date(Date.now() - 180_000).toISOString();
  return [
    {
      id: "fixture-draft-1",
      changeId,
      file: RETRY,
      line: 12,
      endLine: 15,
      anchor: null,
      authorKind: "mend",
      authorName: "Mend",
      body: "Take `random` as a parameter everywhere it's used, so a test can make the delay predictable.",
      kind: "suggestion",
      suggestion:
        "export function backoff(attempt: number, random = Math.random): number {\n  const base = BASE_DELAY_MS * 2 ** (attempt - 1);\n  return base + Math.floor(random() * base * 0.2);\n}",
      state: "draft",
      evidence: [
        { sealantRunId: "run-fixture", sequence: "57", excerpt: "No test has run backoff() yet" },
      ],
      sentToSessionId: null,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "fixture-draft-2",
      changeId,
      file: "src/payments/charge.ts",
      line: 4,
      endLine: null,
      anchor: null,
      authorKind: "mend",
      authorName: "Mend",
      body: "`idempotencyKey` is optional here, so a caller can still charge without one.",
      kind: "note",
      suggestion: null,
      state: "dismissed",
      evidence: [],
      sentToSessionId: null,
      createdAt: at,
      updatedAt: at,
    },
  ];
};

/** superjson's meta for a list of comments: their dates, and record sequences as bigints. */
const commentsMeta = (list) => ({
  values: Object.fromEntries(
    list.flatMap((comment, index) => [
      [`${index}.createdAt`, ["Date"]],
      [`${index}.updatedAt`, ["Date"]],
      ...comment.evidence.map((_, at) => [`${index}.evidence.${at}.sequence`, ["bigint"]]),
    ]),
  ),
  v: 1,
});

/** A follow-up as `sessions.deliverFollowUp` and `sessions.pendingFollowUp` answer it. */
const followUpAnswer = ({ sessionId, changeId, commentIds, status, error = null }) =>
  superjson(
    {
      id: "fixture-follow-up",
      sessionId,
      changeId,
      reviewSliceId: null,
      checkpointAId: null,
      checkpointBId: null,
      diffDigest: null,
      commentIds,
      idempotencyKey: "fixture-key",
      instruction: "Address these review comments.",
      status,
      deliveryProcessId: null,
      deliverySealantRunId: null,
      deliveryError: error,
      deliveryStartedAt: null,
      createdAt: new Date().toISOString(),
      deliveredAt: status === "delivered" ? new Date().toISOString() : null,
    },
    status === "delivered" ? ["createdAt", "deliveredAt"] : ["createdAt"],
  );

/** The session read as Claude Code's, its agent gone: Send shows, as for a finished session. */
const asClaude = (status) => (data) =>
  patchDetail(data, { status, harness: "claude", dropAgent: true });

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const capture = async (name) => {
    await page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
    await page.mouse.move(1, 1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(700);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
    }
  };
  const light = (name) => capture(`${name}-light`);
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const readAgain = (keys) =>
    page.evaluate(async (list) => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      for (const key of list) await queryClient.refetchQueries({ queryKey: [key] });
    }, keys);
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const comment = (text) =>
    visible(page.locator("article[data-comment]").filter({ hasText: text }));
  /** A line's number cell on the new side, inside the renderer's shadow root. */
  const lineNumber = (file, line) =>
    page
      .locator(
        `section[data-file="${file}"] [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
      )
      .first();
  const toolbarNote = () =>
    page.evaluate(() => {
      const send = [...document.querySelectorAll("button")].find((each) =>
        /^Land|^Send /.test(each.textContent ?? ""),
      );
      return send?.parentElement?.previousElementSibling?.textContent?.trim() ?? null;
    });

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const [small] = rows
    .filter((row) => row.worktreeName === "change-small")
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
    .map((row) => row.session);
  if (small === undefined) throw new Error("run new-web-change-sessions.json first");
  const changeId = await client(
    async (trpc, id) => (await trpc.sessions.detail.query({ id })).change?.id ?? null,
    small.id,
  );
  if (changeId === null) throw new Error("change-small has no change");

  // Start clean: comments an earlier run left open are dismissed (the server keeps every comment).
  const leftOpen = await client(async (trpc, id) => {
    const all = await trpc.changes.comments.query({ id });
    const waiting = all.filter((each) => each.state === "open" && each.sentToSessionId === null);
    for (const each of waiting)
      await trpc.changes.setCommentState.mutate({
        id,
        commentId: each.id,
        request: { state: "dismissed" },
      });
    return waiting.length;
  }, changeId);
  note(`dismissed ${leftOpen} open comment(s) an earlier run left on change-small`);
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("mend-viewed-files-")) localStorage.removeItem(key);
    sessionStorage.clear();
  });

  // The fixtures: what to lay over each read, and answers for mutations the stack can't give.
  // `detail` patches the session read; `drafts` adds Mend's drafts to the comments; `sent` marks
  // real comments sent; `deliver` answers a send instead of the server; `pending` answers the
  // session's active follow-up.
  const fixture = {
    detail: null,
    drafts: null,
    sent: new Set(),
    deliver: null,
    pending: null,
  };
  /** Mutations of the drafts, as the server would keep them. */
  const draftState = new Map();
  const patchComments = (data) => {
    const real = data.json.map((each) =>
      fixture.sent.has(each.id) ? { ...each, sentToSessionId: small.id } : each,
    );
    const drafts =
      fixture.drafts === null
        ? []
        : fixture.drafts.map((each) => ({ ...each, state: draftState.get(each.id) ?? each.state }));
    const list = [...real, ...drafts];
    return { json: list, meta: commentsMeta(list) };
  };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const input = route.request().postDataJSON?.() ?? null;
    const own = paths.map((path, index) => {
      const arg = input?.[String(index)]?.json ?? input?.json ?? null;
      if (path === "sessions.detail" && fixture.detail !== null) return path;
      if (path === "changes.comments" && (fixture.drafts !== null || fixture.sent.size > 0))
        return path;
      if (path === "changes.setCommentState" && String(arg?.commentId).startsWith("fixture-"))
        return path;
      if (path === "sessions.deliverFollowUp" && fixture.deliver !== null) return path;
      if (path === "sessions.pendingFollowUp" && fixture.pending !== null) return path;
      return null;
    });
    if (own.every((each) => each === null)) return route.continue();
    const mutationsOnly = own.every(
      (path) => path === "changes.setCommentState" || path === "sessions.deliverFollowUp",
    );
    const response = mutationsOnly ? null : await route.fetch();
    const body = response === null ? paths.map(() => null) : await response.json();
    const answers = Array.isArray(body) ? body : [body];
    own.forEach((path, index) => {
      const arg = input?.[String(index)]?.json ?? input?.json ?? null;
      if (path === "sessions.detail")
        answers[index] = { result: { data: fixture.detail(answers[index].result.data) } };
      if (path === "changes.comments")
        answers[index] = { result: { data: patchComments(answers[index].result.data) } };
      if (path === "changes.setCommentState") {
        draftState.set(arg.commentId, arg.request.state);
        const changed = patchComments({ json: [] }).json.find((each) => each.id === arg.commentId);
        answers[index] = { result: { data: { json: changed, meta: commentsMeta([changed]) } } };
      }
      if (path === "sessions.deliverFollowUp")
        answers[index] = { result: { data: fixture.deliver(arg.request.commentIds) } };
      if (path === "sessions.pendingFollowUp")
        answers[index] = { result: { data: fixture.pending } };
    });
    const json = Array.isArray(body) || paths.length > 1 ? answers : answers[0];
    return response === null
      ? route.fulfill({ status: 200, contentType: "application/json", json })
      : route.fulfill({ response, json });
  });

  // change-small's sessions are `mend run` commands; read as Claude Code's, Send shows. The
  // session has finished, so the toolbar says it starts on the comments once they are sent.
  const realStatus = await client(
    async (trpc, id) => (await trpc.sessions.detail.query({ id })).session.status,
    small.id,
  );

  await open(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });

  // For real first: the session as it is, a command with no agent to send comments to.
  note(`before any comment, the toolbar's note reads: "${await toolbarNote()}"`);
  await light("no-comments-desktop");

  fixture.detail = asClaude(realStatus);
  await readAgain([["sessions", "detail"]]);
  await settled();
  await visible(
    page.getByText("Click a line to comment. Claude Code gets your comments when you send them."),
  ).waitFor({ timeout: 30_000 });
  note(
    "read as Claude Code's: 'Click a line to comment. Claude Code gets your comments when you send them.'",
  );

  // review-inline-comment: a click on line 20's number opens the box there.
  await lineNumber(RETRY, 20).click();
  const lineBox = visible(page.getByRole("textbox", { name: `Comment on ${RETRY}, line 20` }));
  await lineBox.waitFor({ timeout: 15_000 });
  await lineBox.fill(
    "Should we back off on a 409 too? Stripe sends it while the first request is still being processed.",
  );
  note("a click on line 20's number opened the box 'Comment on src/payments/retry.ts, line 20'");
  await both("writing-on-a-line-desktop");
  await button("Add comment").click();
  await comment("Should we back off on a 409 too?").waitFor({ timeout: 30_000 });
  note(
    "Add comment saved it for real (changes.postSliceComment): the comment shows under line 20, 'Not sent · line 20'",
  );

  // A range: a drag across line numbers 12 to 15.
  const from = await lineNumber(RETRY, 12).boundingBox();
  const to = await lineNumber(RETRY, 15).boundingBox();
  if (from === null || to === null) throw new Error("line numbers 12 and 15 aren't on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  const rangeBox = visible(page.getByRole("textbox", { name: `Comment on ${RETRY}, lines 12–15` }));
  await rangeBox.waitFor({ timeout: 15_000 });
  await rangeBox.fill("Cap the wait, so a long outage can't stall checkout for minutes.");
  await button("Add comment").click();
  await comment("Cap the wait").waitFor({ timeout: 30_000 });
  note(
    "a drag from line 12 to 15 opened 'lines 12–15'; the comment saved for real and shows under line 15",
  );

  // From the keyboard: a file's "…", Comment on lines…, then the lines.
  await button("Actions for src/payments/charge.test.ts").click();
  await visible(page.getByRole("menuitem", { name: "Comment on lines…" })).click();
  const form = visible(
    page.getByRole("form", { name: "Comment on lines of src/payments/charge.test.ts" }),
  );
  await form.waitFor();
  await form.getByLabel("From line").fill("5");
  await form.getByLabel("To line").fill("6");
  await form.getByRole("button", { name: "Write a comment" }).click();
  const keyBox = visible(
    page.getByRole("textbox", { name: "Comment on src/payments/charge.test.ts, lines 5–6" }),
  );
  await keyBox.waitFor({ timeout: 15_000 });
  await keyBox.fill("Also check that a 409 keeps the same key.");
  await keyBox.press("Control+Enter");
  await comment("Also check that a 409").waitFor({ timeout: 30_000 });
  note(
    "keyboard: the file's '…' > 'Comment on lines…', lines 5 to 6, Ctrl+Enter saved it for real",
  );

  // review-change-comment: the whole change, from the column.
  await button("Comment on the whole change").click();
  const wholeBox = visible(page.getByRole("textbox", { name: "Comment on the whole change" }));
  await wholeBox.fill(
    "Keep the signature of `chargeWithRetry` as it is. The orders service calls it too.",
  );
  await visible(
    page.getByText("A comment here is about the whole change, not one line."),
  ).waitFor();
  await light("on-the-whole-change-desktop");
  await button("Add comment").click();
  await visible(page.getByRole("region", { name: "On the whole change" })).waitFor({
    timeout: 30_000,
  });
  note(
    "the whole-change comment saved for real; it shows over the diffs under 'On the whole change' and in the column",
  );
  const ready = await toolbarNote();
  note(`four comments: the toolbar reads "${ready}" with "Send 4 comments to Claude Code"`);
  await button("Send 4 comments to Claude Code").waitFor();
  await both("comments-ready-desktop");

  // review-comment-state, for real: Resolve and Reopen; Dismiss takes one out of the send.
  const range = comment("Cap the wait");
  await range.getByRole("button", { name: "Resolve" }).click();
  await range.getByText(/^Resolved/).waitFor({ timeout: 15_000 });
  await button("Send 3 comments to Claude Code").waitFor();
  note(
    "Resolve (changes.setCommentState addressed): the comment folds to 'Resolved', Send counts 3",
  );
  await light("resolved-desktop");
  await range.getByRole("button", { name: "Reopen" }).click();
  await button("Send 4 comments to Claude Code").waitFor({ timeout: 15_000 });
  note("Reopen put it back: Send counts 4");
  const keyed = comment("Also check that a 409");
  await keyed.getByRole("button", { name: "Dismiss" }).click();
  await keyed.getByText(/^Dismissed/).waitFor({ timeout: 15_000 });
  await button("Send 3 comments to Claude Code").waitFor();
  note("Dismiss: 'Dismissed', out of the send (3)");

  // Mend's passes, for real: the stack's agent login is fake, so both fail on the stack.
  const readAsked = page.waitForResponse((response) =>
    response.url().includes("changes.queueRead"),
  );
  await button("Read this change").click();
  note(`Read this change, for real: changes.queueRead answered ${(await readAsked).status()}`);
  const suggestAsked = page.waitForResponse((response) =>
    response.url().includes("changes.queueSuggest"),
  );
  await button("Suggest fixes").click();
  note(`Suggest fixes, for real: changes.queueSuggest answered ${(await suggestAsked).status()}`);
  await page.waitForTimeout(8_000);
  await readAgain([["changes", "passes"]]);
  const passLines = await visible(
    page.getByRole("region", { name: "Drafts from Mend" }),
  ).innerText();
  note(`Drafts from Mend after both passes: "${passLines.replace(/\s+/g, " ")}"`);
  await light("passes-real-desktop");

  // Mend's drafts, from a fixture: no pass can write one on the stack.
  fixture.drafts = draftComments(changeId);
  await readAgain([["changes", "comments"]]);
  const draft = comment("Take `random` as a parameter").or(comment("Take random as a parameter"));
  await visible(page.getByText("Draft from Mend")).waitFor({ timeout: 15_000 });
  await section(RETRY).scrollIntoViewIfNeeded();
  await page.locator('[data-comment="fixture-draft-1"]').first().scrollIntoViewIfNeeded();
  note(
    "a draft from Mend shows under lines 12–15 with its suggested replacement, Add to comments and Dismiss; the column says drafts only go to Claude Code if added, and 'You dismissed 1 draft. Show it'",
  );
  await both("mends-draft-desktop");
  await visible(page.locator('[data-comment="fixture-draft-1"]'))
    .getByRole("button", { name: "Add to comments" })
    .click();
  await button("Send 4 comments to Claude Code").waitFor({ timeout: 15_000 });
  await visible(page.getByText(/from Mend's draft/)).waitFor();
  note(
    "Add to comments: the draft reads 'Not sent · lines 12–15 · from Mend's draft' with Resolve and Remove; Send counts 4",
  );
  await light("mends-draft-added-desktop");
  await visible(page.locator('[data-comment="fixture-draft-1"]'))
    .getByRole("button", { name: "Remove" })
    .click();
  await visible(page.getByText("You dismissed 2 drafts.", { exact: false })).waitFor({
    timeout: 15_000,
  });
  await button("Send 3 comments to Claude Code").waitFor();
  note(
    "Remove: back among the dismissed drafts ('You dismissed 2 drafts. Show them'); Send counts 3",
  );
  void draft;

  // Your review: every file viewed, what Send sends, after the last file.
  for (const file of FILES) {
    const box = visible(page.getByRole("checkbox", { name: `Viewed: ${file}` }));
    if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
  }
  const yourReview = visible(page.getByRole("region", { name: "Your review" }));
  await yourReview.scrollIntoViewIfNeeded();
  note(`all files viewed: "${(await yourReview.innerText()).split("\n").slice(0, 2).join(" ")}"`);
  await both("your-review-desktop");

  // send-select and send-edit: Choose and edit, uncheck one, edit the words.
  await yourReview.getByRole("button", { name: "Choose and edit before sending…" }).click();
  const dialog = visible(page.getByRole("dialog", { name: "Send to Claude Code" }));
  await dialog.waitFor();
  const message = dialog.getByRole("textbox", { name: "What Claude Code receives" });
  const before = await message.inputValue();
  await dialog.getByRole("checkbox", { name: /Keep the signature/ }).click();
  const after = await message.inputValue();
  if (after.includes("Keep the signature"))
    throw new Error("unchecking didn't write the message again");
  await message.fill(`${after}\n\nRun the payment tests before you finish.`);
  note(
    `Choose and edit: 'Comments to send · 2 of 3'; unchecking one wrote the message again (${before.length} → ${after.length} characters); the edit is what goes`,
  );
  await light("choose-and-edit-desktop");

  // send-deliver, for real: the stack refuses it, since the session has no agent to take it.
  const sent = page.waitForResponse((response) =>
    response.url().includes("sessions.deliverFollowUp"),
  );
  await dialog.getByRole("button", { name: "Send 2 comments" }).click();
  const answer = await sent;
  const refusal = visible(page.getByText("Mend couldn't send your comments.", { exact: false }));
  await refusal.waitFor({ timeout: 30_000 });
  const band = await visible(
    page.locator('[data-slot="banner"]').filter({ hasText: "couldn't send" }),
  ).innerText();
  note(
    `Send, for real: sessions.deliverFollowUp answered ${answer.status()}; the band reads "${band.replace(/\s+/g, " ")}"`,
  );
  await light("couldnt-send-real-desktop");

  // Couldn't send, as the server words a delivery that failed (fixture): Try again sends the same.
  const ids = await page.evaluate(() => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    const read = queryClient.getQueryCache().findAll({ queryKey: [["changes", "comments"]] })[0];
    return (read?.state.data ?? [])
      .filter((each) => each.state === "open" && each.sentToSessionId === null)
      .map((each) => each.id);
  });
  fixture.pending = followUpAnswer({
    sessionId: small.id,
    changeId,
    commentIds: ids,
    status: "delivery_failed",
    error: "The workspace stopped answering at 11:04.",
  });
  await open(`/sessions/${small.id}`);
  await go(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });
  await readAgain([
    ["sessions", "detail"],
    ["sessions", "pendingFollowUp"],
    ["changes", "comments"],
  ]);
  await visible(
    page.getByText(`Mend couldn't send your comments. Nothing reached Claude Code.`, {
      exact: false,
    }),
  ).waitFor({ timeout: 30_000 });
  await yourReview.scrollIntoViewIfNeeded();
  note(
    "a delivery the server says failed: 'Mend couldn't send your comments. Nothing reached Claude Code. The workspace stopped answering at 11:04. Your 3 comments are still here…' with Try again; each row reads 'Couldn't send'",
  );
  await both("couldnt-send-desktop");

  // send-pending: a terminal agent still running keeps them; the band says so, with no button.
  fixture.detail = asClaude("running");
  fixture.pending = followUpAnswer({
    sessionId: small.id,
    changeId,
    commentIds: ids,
    status: "pending",
  });
  await readAgain([
    ["sessions", "detail"],
    ["sessions", "pendingFollowUp"],
  ]);
  await visible(page.getByText("Your comments are saved, not sent yet.")).waitFor({
    timeout: 30_000,
  });
  note(
    "pending: 'Your comments are saved, not sent yet. Claude Code is still running in its terminal, so Mend kept 3 comments for it. Send them once it stops.'",
  );
  await light("pending-desktop");

  // send-deliver and send-sent-state: the server accepts; the conversation opens.
  fixture.detail = asClaude(realStatus);
  fixture.pending = null;
  fixture.deliver = (commentIds) => {
    for (const id of commentIds) fixture.sent.add(id);
    return followUpAnswer({ sessionId: small.id, changeId, commentIds, status: "delivered" });
  };
  await readAgain([
    ["sessions", "detail"],
    ["sessions", "pendingFollowUp"],
  ]);
  await button(/^Send 3 comments to Claude Code$/, false).waitFor({ timeout: 30_000 });
  await button(/^Send 3 comments to Claude Code$/, false).click();
  await page.waitForURL(new RegExp(`/sessions/${small.id}$`), { timeout: 30_000 });
  note("Send (one click) delivered: the page moved to the session's conversation tab");
  await go(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });
  await readAgain([["changes", "comments"]]);
  await comment("Should we back off on a 409 too?").getByText(/^Sent/).waitFor({ timeout: 30_000 });
  note(`sent: each sent comment reads 'Sent'; the toolbar reads "${await toolbarNote()}"`);

  // A second look: resolve a sent comment, for real.
  await comment("Should we back off on a 409 too?")
    .getByRole("button", { name: "Resolve" })
    .click();
  await visible(page.getByText(/^1 comment resolved, 2 open\.$/)).waitFor({ timeout: 15_000 });
  note("second look: Resolve on a sent comment; the toolbar reads '1 comment resolved, 2 open.'");
  await both("second-look-desktop");

  // The phone.
  await page.setViewportSize(PHONE);
  fixture.sent.clear();
  draftState.clear();
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("mend-viewed-files-")) localStorage.removeItem(key);
  });
  await open(`/sessions/${small.id}`);
  await go(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });
  await readAgain([
    ["sessions", "detail"],
    ["changes", "comments"],
  ]);
  await visible(page.locator('[data-comment="fixture-draft-1"]')).scrollIntoViewIfNeeded();
  const sendHeight = (await button(/^Send \d+ comments?$/, false).boundingBox())?.height ?? 0;
  note(
    `phone: Mend's draft in the diff, Add to comments and Dismiss under it, and 'Send N comments' at the foot (${Math.round(sendHeight)}px tall)`,
  );
  await both("mends-draft-phone");
  await button(/^Comments and Mend's drafts/, false).click();
  await visible(page.getByRole("dialog", { name: "Comments" })).waitFor();
  note(
    "phone: the comments button opens the Comments sheet (comments, the whole-change box, Drafts from Mend)",
  );
  await light("comments-sheet-phone");
  await page.keyboard.press("Escape");
  fixture.pending = followUpAnswer({
    sessionId: small.id,
    changeId,
    commentIds: ids,
    status: "delivery_failed",
    error: "The workspace stopped answering at 11:04.",
  });
  await readAgain([["sessions", "pendingFollowUp"]]);
  await visible(page.getByText("Mend couldn't send your comments.", { exact: false })).waitFor({
    timeout: 30_000,
  });
  await light("couldnt-send-phone");

  // Leave the stack as it was: the recipe's comments dismissed, no fixtures.
  await page.setViewportSize(DESKTOP);
  fixture.detail = null;
  fixture.drafts = null;
  fixture.deliver = null;
  fixture.pending = null;
  const tidied = await client(async (trpc, id) => {
    const all = await trpc.changes.comments.query({ id });
    const kept = all.filter((each) => each.state !== "dismissed");
    for (const each of kept)
      await trpc.changes.setCommentState.mutate({
        id,
        commentId: each.id,
        request: { state: "dismissed" },
      });
    return kept.length;
  }, changeId);
  note(`dismissed the ${tidied} comment(s) this run left, so it can run again`);
};
