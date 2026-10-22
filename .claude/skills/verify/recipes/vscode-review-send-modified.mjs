import {
  changeActions,
  changeRows,
  clickChangeAction,
  clickEditorTitle,
  commentOnLine,
  commentThreads,
  diffSides,
  editorLines,
  editorPlaceholder,
  editorTabs,
  expect,
  reviewWorld,
  said,
} from "./vscode-review.lib.mjs";

const SESSION = process.env.MEND_REVIEW_SESSION ?? "greet-modified";
const RENAMED = `${SESSION.replace(/-modified$/, "")}-moved`;
const SAVED = `${SESSION.replace(/-modified$/, "")}-saved`;
const ADDED_WORDS = "Link the greeting from the docs index";
const MODIFIED_WORDS = "Say who it greets in the first line";
const RENAMED_WORDS = "Keep the old README name for links";
const SAVED_WORDS = "Name the reader in the greeting";
const SAVED_LINE = "Also keep the greeting to one line.";
const PASTED = "follow-up pending · pasted into claude's terminal";
const LATE_REFUSAL_GRACE_MS = 2_000;
const commentsOf = (seen) => seen.rows.find((row) => row.label === "Comments")?.description ?? "";

const MODIFIED_ROUND = {
  files: {
    README: "Hello World!\nIt greets whoever reads it.\nIt answers in English.\n",
    "docs/greet.md": "# Greet\n\nThe README greets whoever reads it.\n",
  },
  remove: [],
};
/** README renamed to GREETING.md with one line added: git reads it as a rename (similarity 76%). */
const RENAMED_ROUND = {
  files: { "GREETING.md": "Hello World!\nHi.\n" },
  remove: ["README"],
};
const SAVED_ROUND = {
  files: { "docs/saved.md": "# Saved\n\nShe saves her review before a reload.\n" },
  remove: [],
};

export default async (h) => {
  const { step, note, api, sleep, view, treeItem, quickInput, waitUntil, shot, page } = h;
  const lane = reviewWorld(h);
  const { connectClaude, startClaude, shellBeside, reload } = lane;
  const failed = [];
  const stepContinuingOnFailure = (name, fn, options) =>
    step(name, fn, options).catch(() => {
      failed.push(name);
      return null;
    });

  await connectClaude();
  const modified = await step(
    `${SESSION}: a claude terminal agent whose change modifies README and adds docs/greet.md`,
    async () => {
      const session = await startClaude(SESSION);
      const shell = await shellBeside(session);
      await shell.write(MODIFIED_ROUND);
      await shell.close();
      return session;
    },
    { via: "setup" },
  );
  const renamed = await step(
    `${RENAMED}: a claude terminal agent whose change renames README to GREETING.md`,
    async () => {
      const session = await startClaude(RENAMED);
      const shell = await shellBeside(session);
      await shell.write(RENAMED_ROUND);
      await shell.close();
      return session;
    },
    { via: "setup" },
  );
  const saved = await step(
    `${SAVED}: a claude terminal agent whose change adds docs/saved.md`,
    async () => {
      const session = await startClaude(SAVED);
      const shell = await shellBeside(session);
      await shell.write(SAVED_ROUND);
      await shell.close();
      return session;
    },
    { via: "setup" },
  );
  await step("the window reloads onto the extension built from this checkout", reload, {
    via: "setup",
  });
  await step(
    "the Sessions view shows her sessions (Skip for now when it offers Set up)",
    async () => {
      const offered = await h.welcome();
      if (offered?.links.some((link) => link.includes("Skip for now"))) {
        await h.welcomeAction("Skip for now").click();
        await waitUntil("the Sessions tree", async () =>
          (await h.viewRows("Sessions")).rows.length > 0 ? true : null,
        );
        return `skipped Set up: ${JSON.stringify(offered.lines)}`;
      }
      return "no Set up offered";
    },
  );

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
  const select = async (label, { closeEditors = true } = {}) => {
    if (closeEditors) await h.palette("View: Close All Editors");
    await view("Mend");
    const rows = (await h.viewRows("Sessions")).rows;
    if (rows.some((row) => row.label === label))
      await treeItem(label, { pane: "Sessions" }).click();
    else {
      await h.palette("Mend: Review change");
      await quickInput.waitFor();
      await quickInput.pick(label, { exact: true });
    }
    let last = "";
    return sectionUntil(`${label}'s change, held still`, (now) => {
      const drawn = JSON.stringify(now);
      const still = drawn === last;
      last = drawn;
      return still && now.title.endsWith(label) && now.rows.some((row) => row.label.endsWith("▾"));
    });
  };
  const openFile = async (name) => {
    await treeItem(new RegExp(`^${name.replaceAll(".", "\\.")}`), { pane: "Change" }).click();
    await waitUntil(
      `${name}'s diff`,
      async () =>
        (await editorTabs(h)).find((one) => one.active && one.label.startsWith(`${name} (`)) ??
        null,
      30_000,
    );
    await sleep(800);
  };
  const threadWords = async () =>
    (await commentThreads(h)).flatMap((thread) =>
      thread.comments.map((one) => `${one.text} · ${one.label}`),
    );
  const changeOf = async (session) => (await api(`/sessions/${session.id}`)).change.id;
  const heldOnMend = async (session) =>
    (await api(`/changes/${await changeOf(session)}/comments`)).map((one) => ({
      body: one.body,
      file: one.file,
      line: one.line,
      oldPath: one.anchor?.oldPath ?? null,
      newPath: one.anchor?.newPath ?? null,
      side: one.anchor?.side ?? null,
      state: one.state,
    }));

  const sendReview = async (session, headings, label) => {
    const actions = await changeActions(h);
    expect(
      actions.some((action) => action.title === "Send review" && !action.disabled),
      `the section's buttons are ${JSON.stringify(actions)}`,
    );
    await clickChangeAction(h, "Send review");
    await waitUntil(
      "the review's editor",
      async () =>
        (await editorTabs(h)).find(
          (one) => one.active && one.title.startsWith(`review · ${session.name}.md`),
        ) ?? null,
      30_000,
    );
    await sleep(800);
    const lines = await editorLines(h);
    await shot(`${label}-send-review`);
    for (const heading of headings)
      expect(
        lines.some((line) => line.endsWith(heading)),
        `the review has no "${heading}": ${JSON.stringify(lines)}`,
      );
    const before = commentsOf(await section());
    const watch = await h.watch();
    await clickEditorTitle(h, "Send to session");
    let last = { reads: "", since: 0 };
    const seen = await sectionUntil(
      "Send to session done with every comment",
      (now) => {
        const reads = commentsOf(now);
        if (reads !== last.reads) last = { reads, since: Date.now() };
        return (
          reads !== before && !/sending|delivering/.test(reads) && Date.now() - last.since >= 5_000
        );
      },
      90_000,
    ).catch(async (cause) => {
      note(cause.message.split("\n")[0]);
      return section();
    });
    const shown = await watch.stop();
    await shot(`${label}-sent`);
    return {
      lines,
      section: said(seen),
      comments: commentsOf(seen),
      shown,
      toasts: await h.notifications(),
    };
  };

  await step(`the change of ${SESSION} lists README modified and docs/greet.md added`, async () => {
    const seen = await select(SESSION);
    const readme = seen.rows.find((row) => row.label === "README");
    const added = seen.rows.find((row) => row.label === "greet.md");
    await shot("modified-change");
    expect(readme?.letter === "M", `README reads ${JSON.stringify(readme)}: ${said(seen)}`);
    expect(added?.letter === "A", `greet.md reads ${JSON.stringify(added)}: ${said(seen)}`);
    return said(seen);
  });

  await step(
    "d4 · a pending comment on docs/greet.md line 3 (added) and one on README line 2 (modified)",
    async () => {
      await openFile("greet.md");
      await commentOnLine(h, 3, ADDED_WORDS);
      await openFile("README");
      await commentOnLine(h, 2, MODIFIED_WORDS);
      const seen = await sectionUntil("Comments · 2 pending", (now) =>
        commentsOf(now).startsWith("2 pending"),
      );
      await shot("modified-two-pending");
      return `${said(seen)} · README's thread ${JSON.stringify(await threadWords())}`;
    },
  );

  await stepContinuingOnFailure(
    "d4 · her comment's row under Comments opens docs/greet.md's diff (added: no base side), with no error",
    async () => {
      await h.palette("Notifications: Clear All Notifications");
      await h.palette("View: Close All Editors");
      const watch = await h.watch();
      await treeItem(ADDED_WORDS, { pane: "Change" }).click();
      const opened = async () => {
        const tab = (await editorTabs(h)).find(
          (one) => one.active && one.label.startsWith("greet.md ("),
        );
        const sides = await diffSides(h);
        return tab !== undefined && sides.right.some((line) => line.includes("greets whoever"))
          ? true
          : null;
      };
      const failure = async () =>
        (await h.notifications()).length > 0 || (await editorPlaceholder(h)) !== "" ? true : null;
      await waitUntil(
        "greet.md's diff, or an error",
        async () => (await opened()) ?? (await failure()),
        20_000,
      ).catch((cause) => note(String(cause.message).split("\n")[0]));
      await sleep(LATE_REFUSAL_GRACE_MS);
      const shown = await watch.stop();
      const tabs = await editorTabs(h);
      const sides = await diffSides(h);
      const placeholder = await editorPlaceholder(h);
      const toasts = await h.notifications();
      await shot("added-comment-row");
      const observed = `tabs ${JSON.stringify(tabs.map((one) => `${one.label}${one.active ? " (active)" : ""}`))} · diff ${sides.found ? `left ${JSON.stringify(sides.left)} right ${JSON.stringify(sides.right)}` : "none"} · editor placeholder ${JSON.stringify(placeholder)} · toasts ${JSON.stringify(toasts)} · shown ${JSON.stringify(shown)}`;
      if (toasts.length > 0) await h.palette("Notifications: Clear All Notifications");
      expect(
        tabs.some((one) => one.active && one.label.startsWith("greet.md (")) &&
          sides.found &&
          sides.left.join("") === "" &&
          sides.right.some((line) => line.includes("greets whoever")) &&
          placeholder === "" &&
          toasts.length === 0,
        observed,
      );
      return observed;
    },
  );

  const modifiedSend = await step(
    "d6 · Send review, then Send to session, with the comments on the modified and the added file",
    async () => {
      const sent = await sendReview(modified, [" · README:2", " · docs/greet.md:3"], "modified");
      return {
        observed: `section ${sent.section} · toasts ${JSON.stringify(sent.toasts)} · shown ${JSON.stringify(sent.shown)}`,
        ...sent,
      };
    },
  );

  const threadOn = async (file, words, label) => {
    await openFile(file);
    const read = await waitUntil(
      `${file}'s thread`,
      async () => {
        const now = await threadWords();
        return now.some((one) => one.startsWith(words)) ? now : null;
      },
      15_000,
    );
    await shot(`${label}-thread`);
    return read;
  };

  const modifiedThread = await step("d6 · README's thread reads where its comment is", async () =>
    JSON.stringify(await threadOn("README", MODIFIED_WORDS, "modified-readme")),
  );

  await step(`the change of ${RENAMED} lists GREETING.md renamed from README`, async () => {
    const seen = await select(RENAMED);
    const moved = seen.rows.find((row) => row.label === "GREETING.md");
    await shot("renamed-change");
    expect(moved?.letter === "R", `GREETING.md reads ${JSON.stringify(moved)}: ${said(seen)}`);
    return said(seen);
  });

  await step("d4 · a pending comment on GREETING.md line 2 (renamed)", async () => {
    await openFile("GREETING.md");
    await commentOnLine(h, 2, RENAMED_WORDS);
    const seen = await sectionUntil("Comments · 1 pending", (now) =>
      commentsOf(now).startsWith("1 pending"),
    );
    return said(seen);
  });

  const renamedSend = await step(
    "d6 · Send review, then Send to session, with the comment on the renamed file",
    async () => {
      const sent = await sendReview(renamed, [" · GREETING.md:2"], "renamed");
      return {
        observed: `section ${sent.section} · toasts ${JSON.stringify(sent.toasts)} · shown ${JSON.stringify(sent.shown)}`,
        ...sent,
      };
    },
  );

  const renamedThread = await step(
    "d6 · GREETING.md's thread reads where its comment is",
    async () => JSON.stringify(await threadOn("GREETING.md", RENAMED_WORDS, "renamed-greeting")),
  );

  await stepContinuingOnFailure(
    "d6 · Mend holds every comment she sent, with her words, both paths of its file and its line, and her threads read pasted",
    async () => {
      const wanted = [
        { session: modified, words: MODIFIED_WORDS, oldPath: "README", newPath: "README", line: 2 },
        { session: modified, words: ADDED_WORDS, oldPath: null, newPath: "docs/greet.md", line: 3 },
        {
          session: renamed,
          words: RENAMED_WORDS,
          oldPath: "README",
          newPath: "GREETING.md",
          line: 2,
        },
      ];
      const held = {
        [SESSION]: await heldOnMend(modified),
        [RENAMED]: await heldOnMend(renamed),
      };
      const missing = wanted
        .filter((one) => {
          const found = held[one.session.name].find((comment) => comment.body.includes(one.words));
          return (
            found === undefined ||
            found.oldPath !== one.oldPath ||
            found.newPath !== one.newPath ||
            found.line !== one.line ||
            found.side !== "new"
          );
        })
        .map((one) => `${one.newPath}:${one.line} "${one.words}"`);
      const unpasted = [
        [SESSION, modifiedSend.comments, 2],
        [RENAMED, renamedSend.comments, 1],
      ]
        .filter(([, reads, count]) => reads !== `${count} ${PASTED}`)
        .map(([name, reads]) => `${name} reads "${reads}"`);
      if (missing.length > 0 || unpasted.length > 0)
        throw new Error(
          `Mend holds no comment for ${JSON.stringify(missing)} · sections ${JSON.stringify(unpasted)} · on Mend ${JSON.stringify(held)} · threads ${modifiedThread} ${renamedThread} · shown ${JSON.stringify([modifiedSend.shown, renamedSend.shown])}`,
        );
      return JSON.stringify(held);
    },
    { via: "api" },
  );

  await step(`the change of ${SAVED} lists docs/saved.md added`, async () => {
    const seen = await select(SAVED);
    const added = seen.rows.find((row) => row.label === "saved.md");
    expect(added?.letter === "A", `saved.md reads ${JSON.stringify(added)}: ${said(seen)}`);
    return said(seen);
  });

  await step("d4 · a pending comment on docs/saved.md line 3", async () => {
    await openFile("saved.md");
    await commentOnLine(h, 3, SAVED_WORDS);
    const seen = await sectionUntil("Comments · 1 pending", (now) =>
      commentsOf(now).startsWith("1 pending"),
    );
    return said(seen);
  });

  const REVIEW_TAB = `review · ${SAVED}.md`;
  const reviewTab = async () =>
    (await editorTabs(h)).find((one) => one.title.startsWith(REVIEW_TAB)) ?? null;
  const showReviewTab = async () => {
    await page()
      .locator(".part.editor .tabs-container .tab", { hasText: REVIEW_TAB })
      .first()
      .click();
    await sleep(1_000);
  };
  const openReview = async () => {
    await clickChangeAction(h, "Send review");
    await waitUntil(
      "the review's editor",
      async () => {
        const tab = await reviewTab();
        return tab?.active ? tab : null;
      },
      30_000,
    );
    await sleep(800);
  };

  await step(
    "d6 · Send review opens her review; she adds a line and saves it (Ctrl+S)",
    async () => {
      await openReview();
      await page().keyboard.press("Control+End");
      await page().keyboard.press("Enter");
      await page().keyboard.type(SAVED_LINE);
      await page().keyboard.press("Control+S");
      const tab = await waitUntil(
        "her review saved (its tab not dirty)",
        async () => {
          const now = await reviewTab();
          return now !== null && !now.dirty ? now : null;
        },
        15_000,
      );
      const lines = await editorLines(h);
      await shot("saved-review");
      expect(lines.includes(SAVED_LINE), `her line is not in the editor: ${JSON.stringify(lines)}`);
      return `tab "${tab.title}" · dirty ${tab.dirty} · ${JSON.stringify(lines)}`;
    },
  );

  await stepContinuingOnFailure(
    "d6 · after Developer: Reload Window her saved review reads her line (the restored editor, else Send review again)",
    async () => {
      await reload();
      const restoredTab = await waitUntil(
        "her review's tab after the reload",
        reviewTab,
        30_000,
      ).catch(() => null);
      let restored = { tab: null, lines: [], placeholder: "" };
      if (restoredTab !== null) {
        await showReviewTab();
        restored = {
          tab: restoredTab.title,
          lines: await editorLines(h),
          placeholder: await editorPlaceholder(h),
        };
      }
      await shot("saved-after-reload");
      const seen = `restored tab ${JSON.stringify(restored.tab)} · lines ${JSON.stringify(restored.lines)} · editor placeholder ${JSON.stringify(restored.placeholder)} · toasts ${JSON.stringify(await h.notifications())}`;
      if (restored.lines.includes(SAVED_LINE)) return seen;
      await select(SAVED, { closeEditors: false });
      await openReview();
      const reopened = await editorLines(h);
      await shot("saved-reopened");
      const observed = `${seen} · Send review again reads ${JSON.stringify(reopened)}`;
      expect(reopened.includes(SAVED_LINE), observed);
      return observed;
    },
  );

  await stepContinuingOnFailure(
    "d6 · Send to session from her saved review, with nothing saying it was not sent",
    async () => {
      if (!(await section()).title.endsWith(SAVED)) await select(SAVED, { closeEditors: false });
      expect((await reviewTab()) !== null, "no review editor to send from");
      await showReviewTab();
      const lines = await editorLines(h);
      const watch = await h.watch();
      await clickEditorTitle(h, "Send to session");
      await sleep(5_000);
      const shown = await watch.stop();
      const toasts = await h.notifications();
      await shot("saved-sent");
      const observed = `sent from ${JSON.stringify(lines)} · the Change section ${said(await changeRows(h))} · toasts ${JSON.stringify(toasts)} · shown ${JSON.stringify(shown)}`;
      expect(
        ![...toasts, ...(shown?.toasts ?? [])].some((one) =>
          /nothing was sent|not sent/i.test(one),
        ),
        observed,
      );
      return observed;
    },
  );

  await stepContinuingOnFailure(
    "d6 · Mend's follow-up for the session holds the line she saved before the reload",
    async () => {
      const read = () =>
        api(`/sessions/${saved.id}/follow-up`).catch((error) => ({
          error: String(error.message).slice(0, 200),
        }));
      const followUp = await waitUntil(
        "the follow-up with her line",
        async () => {
          const now = await read();
          return now?.instruction?.includes(SAVED_LINE) ? now : null;
        },
        30_000,
      ).catch(read);
      const observed = `follow-up ${JSON.stringify(followUp)}`;
      expect(followUp?.instruction?.includes(SAVED_LINE) === true, observed);
      return `status ${followUp.status} · instruction ${JSON.stringify(followUp.instruction)}`;
    },
    { via: "api" },
  );

  note(
    `sessions ${modified.id} (${SESSION}), ${renamed.id} (${RENAMED}) and ${saved.id} (${SAVED})`,
  );
  await step("every step under test held", async () => {
    expect(failed.length === 0, `${failed.length} failed: ${JSON.stringify(failed)}`);
    return "all held";
  });
};
