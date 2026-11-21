// Second look in the web app's Change view (SLNT-1176, the web PR): the range picker with
// "Since your last review", the agent's answers under the comments it was sent, replying, and
// resolving. Run the Change view's CLI batch first, once per stack, so change-small has several
// checkpoints:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/change-sessions.json
//   pnpm verify drive web --recipe second-look
//
// For real, against the stack: the comments, the range picker's "Up to a checkpoint" and "Compare
// two checkpoints" (real reviews over real checkpoints), where each comment sits on the review
// shown, replies (`changes.reply`), Resolve and Reopen. Fixtures in the browser, over real reads,
// for what a local stack can't make: the session read as Claude Code's (so Send shows), where you
// last reviewed (no agent can take a send here, so nobody has sent comments), and the agent's
// answers. "Since your last review" opens a real review: the fixture only says which checkpoint
// was your last review, and the server opens the range from it. The real agent's answers are the
// server PR's box run (second-look-box). Light and dark, 1280px and 390px.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { patchDetail } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const RETRY = "src/payments/retry.ts";

/** The first of `locator`'s matches a person can see: under 1024px every tab is in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

/** superjson's meta for a list of comments with their threads: every date, and record sequences. */
const commentsMeta = (list) => ({
  values: Object.fromEntries(
    list.flatMap((comment, index) => [
      [`${index}.createdAt`, ["Date"]],
      [`${index}.updatedAt`, ["Date"]],
      ...comment.evidence.map((_, at) => [`${index}.evidence.${at}.sequence`, ["bigint"]]),
      ...(comment.replies ?? []).flatMap((reply, at) => [
        [`${index}.replies.${at}.createdAt`, ["Date"]],
        [`${index}.replies.${at}.updatedAt`, ["Date"]],
      ]),
      ...(comment.answers ?? []).map((_, at) => [`${index}.answers.${at}.at`, ["Date"]]),
    ]),
  ),
  v: 1,
});

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
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  /** A full load renders the session on the server, past the fixtures: read it again here. */
  const freshen = async () => {
    await page.evaluate(async () => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      await queryClient.invalidateQueries({ queryKey: [["sessions", "detail"]] });
    });
    await settled();
  };
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const run = Date.now().toString(36).slice(-4);
  const words = (text) => `${text} (${run})`;
  const comment = (text) =>
    visible(
      page
        .locator("article[data-comment]")
        .filter({ hasText: text })
        .filter({ hasText: `(${run})` }),
    );
  const lineNumber = (file, line) =>
    page
      .locator(
        `section[data-file="${file}"] [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
      )
      .first();
  const reach = async (file, line) => {
    await section(file).scrollIntoViewIfNeeded();
    for (let step = 0; step < 40 && (await lineNumber(file, line).count()) === 0; step += 1) {
      await page.evaluate(() => {
        const scroller =
          document.querySelector("section[data-file]")?.parentElement?.parentElement?.parentElement;
        if (scroller != null) scroller.scrollTop += 250;
      });
      await page.waitForTimeout(150);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = await lineNumber(file, line)
        .scrollIntoViewIfNeeded({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (done) break;
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(400);
  };
  const rangeChip = () => visible(page.getByRole("button", { name: /^Show changes: / }));
  const chipWords = async () => (await rangeChip().getAttribute("aria-label")) ?? "";
  const toolbarNote = () =>
    page.evaluate(() => {
      const land = [...document.querySelectorAll("button")].find((each) =>
        /^Land|^Send /.test(each.textContent ?? ""),
      );
      return land?.parentElement?.previousElementSibling?.textContent?.trim() ?? null;
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
  if (small === undefined) throw new Error("run change-sessions.json first");
  const detail = await client(async (trpc, id) => trpc.sessions.detail.query({ id }), small.id);
  const changeId = detail.change?.id ?? null;
  if (changeId === null) throw new Error("change-small has no change");
  const chain = detail.checkpoints.toSorted((a, b) => a.ordinal - b.ordinal);
  if (chain.length < 4)
    throw new Error(`change-small has ${chain.length} checkpoints; run the batch`);
  note(`change-small's worktree has ${chain.length} checkpoints (0 to ${chain.at(-1).ordinal})`);

  // Start clean: comments an earlier run left open are dismissed (the server keeps every comment).
  const leftOpen = await client(async (trpc, id) => {
    const all = await trpc.changes.comments.query({ id });
    const waiting = [
      ...all.filter((each) => each.state === "open"),
      ...all.flatMap((each) => (each.replies ?? []).filter((reply) => reply.state === "open")),
    ];
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

  // The fixtures. `lastReview` is the checkpoint where "you" last sent comments; `answered` maps a
  // real comment to the agent's answer laid under it.
  const fixture = { detail: null, lastReview: null, answered: new Map(), failOpen: false };
  const lastReviewJson = () =>
    fixture.lastReview === null
      ? null
      : {
          checkpointId: fixture.lastReview.id,
          ordinal: fixture.lastReview.ordinal,
          at: new Date(Date.now() - 20 * 60_000).toISOString(),
        };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const input = route.request().postDataJSON?.() ?? null;
    const own = paths.map((path) => {
      if (path === "sessions.detail" && fixture.detail !== null) return path;
      if (path === "changes.comments" && fixture.answered.size > 0) return path;
      if (path === "changes.openReview" && (fixture.lastReview !== null || fixture.failOpen))
        return path;
      return null;
    });
    if (own.every((each) => each === null)) return route.continue();
    if (own.includes("changes.openReview") && fixture.failOpen) {
      const json = paths.map(() => ({
        error: {
          json: {
            message: "The review didn't open.",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      }));
      return route.fulfill({ status: 500, contentType: "application/json", json });
    }
    // "Since your last review" asks the server for the range from the fixture's checkpoint.
    let postData = route.request().postData();
    if (input !== null && fixture.lastReview !== null) {
      const rewritten = structuredClone(input);
      let changed = false;
      paths.forEach((path, index) => {
        const slot = rewritten[String(index)] ?? rewritten;
        if (path === "changes.openReview" && slot?.json?.request?.range?.from === "last-review") {
          slot.json.request.range = { from: fixture.lastReview.id };
          changed = true;
        }
      });
      if (changed) postData = JSON.stringify(rewritten);
    }
    const response = await route.fetch({ postData });
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    own.forEach((path, index) => {
      const data = answers[index]?.result?.data;
      if (data === undefined) return;
      if (path === "sessions.detail") answers[index] = { result: { data: fixture.detail(data) } };
      if (path === "changes.openReview") {
        const json = structuredClone(data.json);
        json.lastReview = lastReviewJson();
        if (json.checkpointA.id === fixture.lastReview?.id)
          json.range = { kind: "since-last-review" };
        const meta = {
          ...data.meta,
          values: { ...data.meta?.values, "lastReview.at": ["Date"] },
        };
        answers[index] = { result: { data: { json, meta } } };
      }
      if (path === "changes.comments") {
        const list = data.json.map((each) => {
          const answer = fixture.answered.get(each.id);
          return answer === undefined
            ? each
            : {
                ...each,
                sentToSessionId: small.id,
                sentInTurn: 4,
                answers: [answer],
              };
        });
        answers[index] = { result: { data: { json: list, meta: commentsMeta(list) } } };
      }
    });
    const json = Array.isArray(body) || paths.length > 1 ? answers : answers[0];
    return route.fulfill({ response, json });
  });

  const realStatus = detail.session.status;
  fixture.detail = asClaude(realStatus);
  await open(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });
  await freshen();
  note(`the range chip, before any review was sent: "${await chipWords()}"`);

  // The range picker with nobody's last review yet (for real): no "Since your last review".
  await rangeChip().click();
  const menu = visible(page.getByRole("menu"));
  await menu.waitFor();
  const before = await menu.getByRole("menuitem").allInnerTexts();
  note(
    `the picker before a last review: ${JSON.stringify(before.map((each) => each.replace(/\s+/g, " ")))}`,
  );
  await light("range-picker-no-last-review-desktop");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  // Two real comments on the whole change's review: one on line 20, one on the whole change.
  await reach(RETRY, 20);
  await lineNumber(RETRY, 20).click();
  const lineBox = visible(page.getByRole("textbox", { name: `Comment on ${RETRY}, line 20` }));
  await lineBox.waitFor({ timeout: 15_000 });
  await lineBox.fill(words("Should we back off on a 409 too?"));
  await button("Add comment").click();
  await comment("Should we back off on a 409 too?").waitFor({ timeout: 30_000 });
  await button("Comment on the whole change").click();
  const wholeBox = visible(page.getByRole("textbox", { name: "Comment on the whole change" }));
  await wholeBox.fill(words("Keep the signature of chargeWithRetry as it is."));
  await button("Add comment").click();
  await comment("Keep the signature").waitFor({ timeout: 30_000 });
  const saved = await client(async (trpc, id) => trpc.changes.comments.query({ id }), changeId);
  const lineComment = saved.find((each) => each.body.includes(`409 too? (${run})`));
  const changeComment = saved.find(
    (each) => each.body.includes(`signature of chargeWithRetry`) && each.body.includes(`(${run})`),
  );
  if (lineComment === undefined || changeComment === undefined)
    throw new Error("the two comments weren't saved");
  note("two comments saved for real: retry.ts line 20 and the whole change");

  // As if you had sent them at an earlier checkpoint and Claude Code had answered.
  // Your last review at checkpoint 1, before retry.ts was written; the agent "changed" it at 2.
  const edited = chain.find((each) => each.ordinal === 2) ?? chain.at(-1);
  fixture.lastReview = chain.find((each) => each.ordinal === 1) ?? chain.at(-3);
  const answer = (outcome, body) => ({
    followUpId: `fixture-follow-up-${run}`,
    sessionId: small.id,
    harness: "claude",
    turnOrdinal: 4,
    turnStatus: "completed",
    body,
    outcome,
    changedAt:
      outcome === "changed-code" ? { checkpointId: edited.id, ordinal: edited.ordinal } : null,
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  fixture.answered.set(
    lineComment.id,
    answer(
      "changed-code",
      "Yes. A 409 now backs off like a 503 and keeps the same key, so Stripe matches the retry to the first request.",
    ),
  );
  fixture.answered.set(
    changeComment.id,
    answer(
      null,
      "I kept it. `backoff()` is new and only used inside `retry.ts`, so code that calls `chargeWithRetry` sees no change.",
    ),
  );
  note(
    `fixtures: your last review was checkpoint ${fixture.lastReview.ordinal}; Claude Code answered both comments in turn 4`,
  );
  await page.evaluate(() => sessionStorage.clear());
  await open(`/sessions/${small.id}/change`);
  await section(RETRY).waitFor({ timeout: 60_000 });
  await freshen();
  const finished = visible(page.getByText(/finished working on your/));
  await finished.waitFor({ timeout: 30_000 });
  note(
    `the whole change's band: "${(await finished.locator("..").innerText()).replace(/\s+/g, " ")}"`,
  );
  await both("finished-desktop");

  // Since your last review: a real review from the fixture's checkpoint to the change as it is.
  await button("Show changes since your last review").click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((each) =>
      (each.getAttribute("aria-label") ?? "").startsWith("Show changes: Since your last review"),
    ),
  );
  await settled();
  note(`the range chip now: "${await chipWords()}"; the toolbar: "${await toolbarNote()}"`);
  const files = await page
    .locator("section[data-file]")
    .evaluateAll((sections) => sections.map((each) => each.getAttribute("data-file")));
  note(`the files in it: ${files.join(", ")}`);
  const description = await page.getByText(/^Mend wrote this from|No description yet/).count();
  note(`Mend's description shown on this range: ${description > 0}`);
  await comment("Keep the signature").waitFor({ timeout: 30_000 });
  const lineThere = await comment("Should we back off on a 409 too?").count();
  note(
    `the whole-change comment shows over the diffs with its answer; the line comment is in the diff: ${lineThere > 0} (where the server placed it on this review)`,
  );
  await both("since-last-review-desktop");

  // The picker, with your last review in it.
  await rangeChip().click();
  await menu.waitFor();
  const items = await menu.getByRole("menuitem").allInnerTexts();
  note(`the picker: ${JSON.stringify(items.map((each) => each.replace(/\s+/g, " ")))}`);
  await both("range-picker-desktop");
  // Up to an older checkpoint: a real review from the base to it.
  const older = chain.at(-2);
  await visible(menu.getByRole("menuitem", { name: new RegExp(`^${older.ordinal} · `) })).click();
  await page.waitForFunction(
    (ordinal) =>
      [...document.querySelectorAll("button")].some((each) =>
        (each.getAttribute("aria-label") ?? "").includes(`Up to checkpoint ${ordinal}`),
      ),
    older.ordinal,
  );
  note(`Up to a checkpoint: the chip reads "${await chipWords()}"`);
  await light("up-to-checkpoint-desktop");

  // Compare two checkpoints, which here hold the same files: the empty range.
  await rangeChip().click();
  await visible(page.getByRole("menuitem", { name: "Compare two checkpoints…" })).click();
  const compare = visible(page.getByRole("dialog", { name: "Compare two checkpoints" }));
  await compare.waitFor();
  await compare.getByLabel("From").selectOption(chain.at(-2).id);
  await compare.getByLabel("To").selectOption(chain.at(-2).id);
  await light("compare-desktop");
  await compare.getByRole("button", { name: "Show changes" }).click();
  await compare.waitFor({ state: "hidden" });
  const empty = visible(page.getByText("Nothing changed between these checkpoints"));
  await empty.waitFor({ timeout: 30_000 });
  note(
    `compared checkpoint ${chain.at(-2).ordinal} with itself: "Nothing changed between these checkpoints"`,
  );
  await light("empty-range-desktop");
  await button("Show the whole change").click();
  await section(RETRY).waitFor({ timeout: 60_000 });
  note(`"Show the whole change" went back: "${await chipWords()}"`);

  // Back to since your last review, then reply to the whole-change comment.
  await rangeChip().click();
  await visible(page.getByRole("menuitem", { name: /^Since your last review/ })).click();
  await comment("Keep the signature").waitFor({ timeout: 30_000 });
  await comment("Keep the signature").getByRole("button", { name: "Reply", exact: true }).click();
  const replyBox = visible(page.getByRole("textbox", { name: /^Reply to / }));
  await replyBox.waitFor();
  await replyBox.fill(
    words("Thanks. `refunds.ts` calls it the same way, so please run the refund tests too."),
  );
  await light("replying-desktop");
  await button("Add reply").click();
  const replied = visible(page.locator("[data-reply]").filter({ hasText: `(${run})` }));
  await replied.waitFor({ timeout: 30_000 });
  note(
    `the reply saved for real (changes.reply): "${(await replied.innerText()).replace(/\s+/g, " ")}"`,
  );
  const sendLabel = await visible(page.getByRole("button", { name: /^Send / })).innerText();
  note(`Send now reads "${sendLabel}"`);
  await both("reply-added-desktop");

  // Resolve the line comment: it folds to one line with what the agent did.
  const lineArticle = comment("Should we back off on a 409 too?");
  if ((await lineArticle.count()) > 0) {
    await lineArticle.getByRole("button", { name: "Resolve", exact: true }).click();
    await lineArticle.getByRole("button", { name: "Reopen" }).waitFor({ timeout: 30_000 });
    note(
      `resolved for real: "${(await lineArticle.innerText()).replace(/\s+/g, " ")}"; toolbar "${await toolbarNote()}"`,
    );
    await light("replying-and-resolving-desktop");
  } else note("the line comment isn't in this range's diff, so it was resolved from the column");

  // Show the edit: the review moves to the checkpoint the agent changed the code at.
  await lineArticle
    .getByRole("button", { name: "Reopen" })
    .click()
    .catch(() => undefined);
  const showEdit = visible(page.getByRole("button", { name: "Show the edit" }));
  if ((await showEdit.count()) > 0) {
    await showEdit.click();
    await settled();
    note(`Show the edit: the chip reads "${await chipWords()}"`);
  }

  // A phone: since your last review, the "Show changes" sheet, and Send at the foot.
  await page.setViewportSize(PHONE);
  await page.evaluate(() => sessionStorage.clear());
  await open(`/sessions/${small.id}/change`);
  await rangeChip().waitFor({ timeout: 60_000 });
  await freshen();
  await rangeChip().click();
  const sheet = visible(page.getByRole("dialog", { name: "Show changes" }));
  await sheet.waitFor();
  await both("range-sheet-phone");
  await sheet.getByRole("button", { name: /^Since your last review/ }).click();
  await sheet.waitFor({ state: "hidden" });
  await comment("Keep the signature").waitFor({ timeout: 30_000 });
  await both("since-last-review-phone");

  // Failure: opening the review fails; Try again opens it.
  await page.setViewportSize(DESKTOP);
  fixture.failOpen = true;
  await page.evaluate(() => sessionStorage.clear());
  await open(`/sessions/${small.id}/change`);
  await visible(page.getByRole("button", { name: "Try again" })).waitFor({ timeout: 60_000 });
  await light("open-failed-desktop");
  fixture.failOpen = false;
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await section(RETRY).waitFor({ timeout: 60_000 });
  note("opening the review failed (forced 500), and Try again opened it");

  // Put the stack back: this run's comments and replies dismissed, the range forgotten.
  const tidied = await client(async (trpc, id) => {
    const all = await trpc.changes.comments.query({ id });
    const still = [
      ...all.filter((each) => each.state === "open"),
      ...all.flatMap((each) => (each.replies ?? []).filter((reply) => reply.state === "open")),
    ];
    for (const each of still)
      await trpc.changes.setCommentState.mutate({
        id,
        commentId: each.id,
        request: { state: "dismissed" },
      });
    return still.length;
  }, changeId);
  await page.evaluate(() => sessionStorage.clear());
  note(`dismissed this run's ${tidied} open comment(s) and replies`);
  // No read in flight may outlive the page through the fixtures' handler.
  await page.unrouteAll({ behavior: "ignoreErrors" });
};
