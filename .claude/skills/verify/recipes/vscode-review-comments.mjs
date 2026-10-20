// Story d, steps 3 and 4 of the VS Code redesign (flow 6, branch review-comments), driven as Dana
// meets them: Read this change asks Mend to read it (the world's logins are fake, so Mend's read
// fails, and the extension says why in one toast); the `+` on a line of the pinned slice writes a
// pending comment, held by the extension, that she edits before Send (G1); the Comments panel
// lists it; it is there again after the window reloads; a slice other than base → now offers no
// `+` (G10); comments Mend already holds show as threads with their state; Show record opens the
// session's transcript read-only (G9).
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-review-comments.mjs --out <dir>
//
// Needs a world from `up` (signed in, workspace SSH set up) whose extension has comment threads.
// Mend's drafts need inference on a real provider login, which no verify world has: the drafts,
// their Accept and Dismiss, and Show record from a draft are recorded `verified-unreachable ·
// inference`, never faked.

import {
  changeActions,
  changeRows,
  clickChangeAction,
  clickOverflow,
  commentGlyph,
  commentsPanel,
  commentThreads,
  editorTabs,
  expect,
  reviewWorld,
  ROUNDS,
  said,
  writeComment,
} from "./vscode-review.lib.mjs";

// A world that already ran this recipe names its next session apart: `MEND_REVIEW_SESSION`.
const SESSION = process.env.MEND_REVIEW_SESSION ?? "add-rate-limit";
const COMMENT = "Use the shared limiter from guard.ts";
const EDITED = "Use the shared limiter from guard.ts, not a Map";

export default async (h) => {
  const { step, note, api, sleep, view, treeItem, quickInput, waitUntil, shot, palette, page } = h;
  const { project, connectClaude, startClaude, shellBeside, reload, revealSession } =
    reviewWorld(h);

  await connectClaude();
  const session = await step(
    `${SESSION}: a claude terminal agent in its own worktree, at its prompt`,
    async () => startClaude(SESSION),
    { via: "setup" },
  );
  const marked = await step(
    "the change written in two rounds by a shell beside the agent, a checkpoint after each",
    async () => {
      const shell = await shellBeside(session);
      const first = await shell.write(ROUNDS[0]);
      const second = await shell.write(ROUNDS[1]);
      await shell.close();
      return { first: first.ordinal, second: second.ordinal };
    },
    { via: "setup" },
  );
  await step("the window reloads onto the extension built from this checkout", reload, {
    via: "setup",
  });
  const base = (await api(`/projects/${project.id}`)).project.defaultBranch;

  const section = () => changeRows(h);
  const sectionUntil = (what, check, limit = 60_000) =>
    waitUntil(
      what,
      async () => {
        const seen = await section();
        return check(seen) ? seen : null;
      },
      limit,
    );
  const commentsRow = (seen) => seen.rows.find((row) => row.label === "Comments") ?? null;

  const select = async () => {
    await view("Mend");
    await revealSession(SESSION);
    await treeItem(SESSION, { pane: "Sessions" }).click();
    return sectionUntil("the section's header", (now) =>
      now.rows.some((row) => row.label === `${base} → now ▾`),
    );
  };

  const opened = await step("d1 · she selects the session row: its change shows", async () => {
    const seen = await select();
    return said(seen);
  });
  void opened;

  await step(
    "d3 · Read this change: Mend is asked to read it, and its refusal says why in one toast",
    async () => {
      const actions = await changeActions(h);
      expect(
        actions.some((action) => action.title.startsWith("Read this change")),
        `the section's buttons are ${JSON.stringify(actions)}`,
      );
      const watched = await h.watch();
      await clickChangeAction(h, "Read this change");
      const reading = await waitUntil(
        "the section reading or Mend's answer",
        async () => {
          const seen = await section();
          const row = seen.rows.find((one) => one.label.startsWith("Mend is reading · "));
          if (row !== undefined) return { reading: row.label };
          const toasts = await h.notifications();
          const said = toasts.find((toast) => toast.startsWith("Mend could not read this change"));
          return said === undefined ? null : { toast: said };
        },
        60_000,
      );
      if (reading.reading !== undefined) await shot("d3-mend-is-reading");
      const toast = await waitUntil(
        "Mend's answer to the read",
        async () =>
          (await h.notifications()).find((one) =>
            one.startsWith("Mend could not read this change"),
          ) ?? null,
        300_000,
      );
      await sleep(1_500);
      await shot("d3-read-refused");
      const seen = watched === null ? null : await watched.stop();
      const toasts = (seen?.toasts ?? []).filter((one) => one.startsWith("Mend could not read"));
      expect(
        toasts.length <= 1,
        `the refusal toasted ${toasts.length} times: ${JSON.stringify(toasts)}`,
      );
      return `${reading.reading ?? "no reading row caught"} · toast "${toast}"`;
    },
  );
  note(
    "d3 · drafts arrive `Mend · draft` with evidence, [Accept] [Dismiss], Show record from a draft: verified-unreachable · inference (the world's provider logins are fake, so Mend's read cannot write a draft; covered by threads.test.ts and pending.test.ts)",
  );

  await step(
    "d4 · she opens limit.ts and clicks + on line 12: her words become a pending comment",
    async () => {
      await treeItem(/^limit\.ts/, { pane: "Change" }).click();
      await waitUntil(
        "the diff's tab",
        async () =>
          (await editorTabs(h)).find((tab) => tab.active && tab.label.startsWith("limit.ts (")) ??
          null,
        30_000,
      );
      await sleep(1_000);
      const glyph = await waitUntil("the + on line 12", async () => {
        const found = await commentGlyph(h, 12);
        return found?.found === true ? found : null;
      });
      await glyph.click();
      await writeComment(h, COMMENT, "Add comment");
      const threads = await waitUntil(
        "her comment's thread",
        async () => {
          const seen = await commentThreads(h);
          return seen.some((thread) => thread.comments.some((one) => one.text.includes(COMMENT)))
            ? seen
            : null;
        },
        30_000,
      );
      const after = await sectionUntil("Comments · 1 pending", (now) =>
        (commentsRow(now)?.description ?? "").startsWith("1 pending"),
      );
      await shot("d4-her-own-comment");
      const thread = threads.find((one) =>
        one.comments.some((item) => item.text.includes(COMMENT)),
      );
      expect(
        thread?.title === "src/auth/limit.ts · line 12" && thread.comments[0]?.label === "pending",
        `her thread reads ${JSON.stringify(thread)}`,
      );
      expect(
        after.rows.some((row) => row.description.startsWith("limit.ts:12 · pending")),
        `the Comments row does not list limit.ts:12 · pending: ${said(after)}`,
      );
      return `threads ${JSON.stringify(threads)} · ${said(after)}`;
    },
  );

  await step("G1 · she edits the pending comment before Send", async () => {
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
    await page().keyboard.press("End");
    await page().keyboard.type(", not a Map");
    await page()
      .locator(".editor-group-container.active .review-widget .monaco-text-button", {
        hasText: "Save",
      })
      .first()
      .click();
    const threads = await waitUntil(
      "the edited comment",
      async () => {
        const seen = await commentThreads(h);
        return seen.some((thread) => thread.comments.some((one) => one.text.includes(EDITED)))
          ? seen
          : null;
      },
      30_000,
    );
    await shot("g1-edited-before-send");
    return JSON.stringify(threads.map((thread) => thread.comments));
  });

  await step("d4 · the Comments panel lists her pending comment", async () => {
    await palette("Comments: Focus on Comments View").catch(async () =>
      palette("View: Focus on Comments View"),
    );
    const rows = await waitUntil(
      "the Comments panel's rows",
      async () => {
        const seen = await commentsPanel(h);
        return seen.some((row) => row.includes(EDITED)) ? seen : null;
      },
      30_000,
    );
    await shot("d4-comments-panel");
    return JSON.stringify(rows);
  });

  await step("her pending comment survives a window reload (kept in global storage)", async () => {
    await reload();
    const seen = await select();
    expect(
      (commentsRow(seen)?.description ?? "").startsWith("1 pending"),
      `after the reload the section reads ${said(seen)}`,
    );
    await treeItem(/^limit\.ts/, { pane: "Change" }).click();
    const threads = await waitUntil(
      "her comment's thread after the reload",
      async () => {
        const found = await commentThreads(h);
        return found.some((thread) => thread.comments.some((one) => one.text.includes(EDITED)))
          ? found
          : null;
      },
      30_000,
    );
    await shot("pending-after-reload");
    return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments))}`;
  });

  await step("G10 · on a slice other than base → now, a line offers no +", async () => {
    await treeItem("▾", { pane: "Change" }).click();
    await quickInput.waitFor();
    const titled = (title) =>
      waitUntil(`the pick titled "${title}"`, async () =>
        (await quickInput.title()) === title ? true : null,
      );
    await quickInput.pick("between two checkpoints…");
    await titled("Between two checkpoints · from which?");
    await quickInput.pick(`checkpoint ${marked.first}`, { exact: true });
    await titled(`Between checkpoint ${marked.first} and which checkpoint?`);
    await quickInput.pick(`checkpoint ${marked.second}`, { exact: true });
    await sectionUntil("the view-only slice", (now) =>
      now.rows.some((row) => row.label.startsWith("viewing · ")),
    );
    await treeItem(/^limit\.ts/, { pane: "Change" }).click();
    await waitUntil(
      "the slice's diff",
      async () =>
        (await editorTabs(h)).find(
          (tab) => tab.active && tab.label.startsWith(`limit.ts (checkpoint ${marked.first}`),
        ) ?? null,
      30_000,
    );
    await sleep(1_000);
    const glyph = await commentGlyph(h, 8);
    await shot("g10-no-comment-on-a-view-only-slice");
    expect(glyph !== null, "the diff has no line 8 to hover");
    expect(glyph.found === false, "a line of a view-only slice offers +");
    await treeItem("▾", { pane: "Change" }).click();
    await quickInput.waitFor();
    await quickInput.pick(`${base} → now`, { exact: true });
    await sectionUntil(`${base} → now again`, (now) =>
      now.rows.some((row) => row.label === `${base} → now ▾`),
    );
    return "no + on line 8 of checkpoint → checkpoint";
  });

  const sent = await step(
    "comments Mend already holds: one written on the pinned slice, then marked addressed, over the API",
    async () => {
      const detail = await api(`/sessions/${session.id}`);
      const changeId = detail.change.id;
      const slices = await api(`/changes/${changeId}/reviews/open`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: `verify-review-comments-${session.id}` }),
      });
      const diff = await api(`/changes/${changeId}/reviews/${slices.slice.id}/diff`);
      const file = diff.anchorFiles.find((one) => one.newPath === "src/auth/limit.test.ts");
      const hunk = file.hunks.find((one) => one.newLines > 0);
      const posted = await api(`/changes/${changeId}/reviews/${slices.slice.id}/comments`, {
        method: "POST",
        body: JSON.stringify({
          target: {
            oldPath: null,
            newPath: "src/auth/limit.test.ts",
            side: "new",
            startLine: hunk.newStart,
            endLine: hunk.newStart,
            hunkContextHash: hunk.contextHash,
          },
          body: "Test the sixth request too",
        }),
      });
      await api(`/changes/${changeId}/comments/${posted.id}/state`, {
        method: "POST",
        body: JSON.stringify({ state: "addressed" }),
      });
      return { changeId, comment: posted.id, line: hunk.newStart };
    },
    { via: "api" },
  );

  await step("comments Mend holds show as threads with their state", async () => {
    const seen = await sectionUntil("Comments with the addressed one", (now) =>
      (commentsRow(now)?.description ?? "").includes("1 addressed"),
    );
    await treeItem(/^limit\.test\.ts/, { pane: "Change" }).click();
    const threads = await waitUntil(
      "the addressed thread",
      async () => {
        const found = await commentThreads(h);
        return found.some((thread) =>
          thread.comments.some((one) => one.text.includes("Test the sixth request")),
        )
          ? found
          : null;
      },
      30_000,
    );
    await shot("server-comments-with-state");
    return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments))} · ${JSON.stringify(sent)}`;
  });

  await step("G9 · Show record opens the session's whole transcript, read-only", async () => {
    await clickOverflow(h, "Show record");
    const tab = await waitUntil(
      "the record's tab",
      async () =>
        (await editorTabs(h)).find(
          (one) => one.active && one.title.startsWith(`record · ${SESSION}.md`),
        ) ?? null,
      30_000,
    );
    await sleep(1_000);
    await shot("g9-show-record");
    const text = await page()
      .locator(".editor-group-container.active .monaco-editor .view-lines")
      .first()
      .innerText()
      .then((shown) => shown.replace(/\u00a0/g, " "));
    expect(
      text.includes(`# Record · ${SESSION}`),
      `the record reads ${JSON.stringify(text.slice(0, 200))}`,
    );
    return `tab "${tab.label}" · ${JSON.stringify(text.slice(0, 160))}`;
  });
};
