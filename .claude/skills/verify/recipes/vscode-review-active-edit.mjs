// A pending comment she is editing in one window, when another window sends it (SLNT-204): in the
// home window she writes a comment on line 12, presses Edit and types, and does not save. In a
// second window of the same VS Code she sends the review. The home window reads the review again
// as Mend's comments change; her editor still holds the words she typed. She saves: the comment
// was already sent, so her words are kept as a new pending comment at the same place, and VS Code
// says so once.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-review-active-edit.mjs --out <dir>
//
// Needs a world from `up` (signed in, workspace SSH set up) whose extension sends reviews. Claude
// runs on the skill's fake setup token and sits at its prompt; nothing presses Enter in it.

import {
  changeRows,
  clickChangeAction,
  clickEditorTitle,
  commentOnLine,
  commentThreads,
  editorTabs,
  expect,
  reviewWorld,
  ROUNDS,
  said,
} from "./vscode-review.lib.mjs";

const SESSION = process.env.MEND_REVIEW_SESSION ?? "add-rate-limit";
const FIRST = "Use the shared limiter from guard.ts";
const TYPED = "Count the burst per key, and test the sixth request";
const KEPT =
  "This comment was already sent in a review, so your edit is kept as a new pending comment at the same place.";

export default async (h) => {
  const { step, sleep, view, treeItem, waitUntil, shot, page, palette, windows, useWindow } = h;
  const { connectClaude, startClaude, shellBeside, reload, revealSession, project } =
    reviewWorld(h);

  await connectClaude();
  const session = await step(
    `${SESSION}: a claude terminal agent in its own worktree, at its prompt`,
    async () => startClaude(SESSION),
    { via: "setup" },
  );
  await step(
    "the change written in two rounds by a shell beside the agent, a checkpoint after each",
    async () => {
      const shell = await shellBeside(session);
      await shell.write(ROUNDS[0]);
      await shell.write(ROUNDS[1]);
      await shell.close();
    },
    { via: "setup" },
  );
  await step("the window reloads onto the extension built from this checkout", reload, {
    via: "setup",
  });
  const base = (await h.api(`/projects/${project.id}`)).project.defaultBranch;

  const comments = (seen) => seen.rows.find((row) => row.label === "Comments")?.description ?? "";
  const select = async (what, holds) => {
    await view("Mend");
    await revealSession(SESSION);
    await treeItem(SESSION, { pane: "Sessions" }).click();
    return waitUntil(
      what,
      async () => {
        const seen = await changeRows(h);
        return seen.rows.some((row) => row.label === `${base} → now ▾`) && holds(comments(seen))
          ? seen
          : null;
      },
      60_000,
    );
  };
  const openLimit = async () => {
    await treeItem(/^limit\.ts/, { pane: "Change" }).click();
    await waitUntil(
      "the diff's tab",
      async () =>
        (await editorTabs(h)).find((tab) => tab.active && tab.label.startsWith("limit.ts (")) ??
        null,
      30_000,
    );
    await sleep(1_000);
  };
  const editorText = () =>
    page().evaluate(() =>
      [
        ...document.querySelectorAll(
          ".editor-group-container.active .review-widget .review-comment .edit-container .view-lines",
        ),
      ].map((lines) => (lines.textContent ?? "").replace(/\u00a0/g, " ").trim()),
    );

  const home = await step("the home window: she writes a pending comment on line 12", async () => {
    await select("the section's header", () => true);
    await openLimit();
    await commentOnLine(h, 12, FIRST);
    const seen = await select("Comments · 1 pending", (text) => text.startsWith("1 pending"));
    return { page: page(), observed: said(seen) };
  });

  const second = await step(
    "a second window of this VS Code (New Window) shows the same session with her one pending comment",
    async () => {
      const known = await windows();
      await palette("New Window");
      const opened = await h.waitForWindow(known);
      await useWindow(opened);
      await sleep(5_000);
      const seen = await select("Comments · 1 pending", (text) => text.startsWith("1 pending"));
      await shot("second-window-one-pending");
      return { window: opened, observed: said(seen) };
    },
  );

  await step(
    "the home window: she presses Edit on her comment and types new words, and does not save",
    async () => {
      await useWindow(await h.homeWindow());
      await openLimit();
      const pencil = page()
        .locator(
          ".editor-group-container.active .review-widget .comment-title .action-label[aria-label^='Edit']",
        )
        .first();
      await pencil.hover();
      await pencil.click();
      const editor = page()
        .locator(".editor-group-container.active .review-widget .review-comment .monaco-editor")
        .first();
      await editor.click();
      await page().keyboard.press("Control+A");
      await page().keyboard.type(TYPED);
      await sleep(500);
      const text = await editorText();
      await shot("home-editing-unsaved");
      expect(text.includes(TYPED), `her editor reads ${JSON.stringify(text)}`);
      return `her editor reads ${JSON.stringify(text)}`;
    },
  );

  await step(
    "the second window: Send review, then Send to session; claude's terminal holds the review",
    async () => {
      await useWindow(second.window);
      await select("Comments · 1 pending", (text) => text.startsWith("1 pending"));
      await clickChangeAction(h, "Send review");
      await waitUntil(
        "the review's editor",
        async () =>
          (await editorTabs(h)).find(
            (one) => one.active && one.title.startsWith(`review · ${SESSION}.md`),
          ) ?? null,
        30_000,
      );
      await sleep(800);
      await clickEditorTitle(h, "Send to session");
      const seen = await select("Comments · follow-up pending", (text) =>
        text.includes("follow-up pending"),
      );
      await shot("second-window-sent");
      return said(seen);
    },
  );

  await step(
    "the home window reads the review again: the comment shows as sent on, and her editor still holds the words she typed",
    async () => {
      await useWindow(await h.homeWindow());
      const seen = await select("Comments · follow-up pending", (text) =>
        text.includes("follow-up pending"),
      ).catch(async () => changeRows(h));
      await sleep(2_000);
      const threads = await commentThreads(h);
      const text = await editorText();
      await shot("home-after-the-send");
      expect(
        text.includes(TYPED),
        `her typed words are gone: editors ${JSON.stringify(text)} · threads ${JSON.stringify(threads)} · ${said(seen)}`,
      );
      return `editors ${JSON.stringify(text)} · threads ${JSON.stringify(threads)} · ${said(seen)}`;
    },
  );

  await step(
    "she presses Save: her words are a new pending comment at line 12, and VS Code says so once",
    async () => {
      const watched = await h.watch();
      await page()
        .locator(".editor-group-container.active .review-widget .monaco-text-button", {
          hasText: "Save",
        })
        .first()
        .click();
      const seen = await select("Comments · 1 pending", (text) => text.startsWith("1 pending"));
      const threads = await waitUntil(
        "her words in a pending thread",
        async () => {
          const now = await commentThreads(h);
          return now.some((thread) =>
            thread.comments.some((one) => one.text.includes(TYPED) && one.label === "pending"),
          )
            ? now
            : null;
        },
        30_000,
      );
      await sleep(1_500);
      const toasts = watched === null ? null : await watched.stop();
      await shot("home-saved-as-new-pending");
      const said1 = (toasts?.toasts ?? []).filter((one) => one.includes(KEPT));
      const mine = threads.filter((thread) =>
        thread.comments.some((one) => one.text.includes(TYPED)),
      );
      expect(said1.length === 1, `the toasts read ${JSON.stringify(toasts)}`);
      expect(
        mine.length === 1 && mine[0].title === "src/auth/limit.ts · line 12",
        `her words show in ${JSON.stringify(mine)}`,
      );
      return `${said(seen)} · threads ${JSON.stringify(threads)} · toasts ${JSON.stringify(toasts)}`;
    },
  );

  await step("the second window shows her new words as one pending comment too", async () => {
    await useWindow(second.window);
    const seen = await select("Comments · 1 pending", (text) => text.startsWith("1 pending"));
    await shot("second-window-new-pending");
    await h.closeWindow(second.window);
    await useWindow(await h.homeWindow());
    return said(seen);
  });
  void home;
};
