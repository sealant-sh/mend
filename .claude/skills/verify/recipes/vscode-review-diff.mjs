// Story d, steps 1, 2 and 5 of the VS Code redesign (flow 6, branch review-diff), driven as Dana
// meets them: she selects a session row and the Change section shows its change (`main → now ·
// 3 files · …`, a row per file with its letter, Comments and Checkpoints); a file opens VS Code's
// own diff editor, base on the left and the pinned checkpoint on the right; Open all changes opens
// every file in one multi-diff editor; the header picks another slice, which she can read but not
// comment on (G10); files written after the pin are said above the pinned slice, and Review the
// newer change pins them; Open in Mend (web) sits only in the section's overflow menu; review works on a
// stopped session; and in the session's own workspace window the section shows its change unasked.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-review-diff.mjs --out <dir>
//
// Needs a world from `up` (signed in, workspace SSH set up) whose extension has the Change section.
// Claude runs on the skill's fake setup token and sits at its prompt; the change is written by a
// shell beside it in two rounds, each followed by a checkpoint marked over the API.

import {
  changeActions,
  changeRows,
  clickChangeAction,
  diffSides,
  editorTabs,
  expect,
  overflowItems,
  reviewWorld,
  ROUNDS,
  said,
} from "./vscode-review.lib.mjs";

// A world that already ran this recipe names its next session apart: `MEND_REVIEW_SESSION`.
const SESSION = process.env.MEND_REVIEW_SESSION ?? "add-rate-limit";
const OPEN = /^Mend: Open$/;
/** Two more files, written after the slice was pinned. */
const NEWER = {
  files: {
    "src/auth/guard.ts": "export const guard = () => true;\n",
    "docs/limits.md": "# Limits\n\nSee rate-limit.md.\n",
  },
  remove: [],
};
const DRIFT = "worktree changed since this review · 2 new files";

export default async (h) => {
  const { step, note, api, sleep, view, treeItem, quickInput, waitUntil, shot, userSettings } = h;
  const { project, connectClaude, startClaude, shellBeside, sessionRead, reload, revealSession } =
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
  const lettered = (now) =>
    now.rows.filter((row) => row.level === 2).every((row) => row.letter !== "");
  const rowOf = (seen, label) => seen.rows.find((row) => row.label === label) ?? null;

  const d1 = await step(
    "d1 · she selects the session row: the Change section shows main → now, its files, Comments and Checkpoints",
    async () => {
      await view("Mend");
      const before = await section();
      expect(before.found, "the Mend view has no Change section");
      await treeItem(SESSION, { pane: "Sessions" }).click();
      const seen = await sectionUntil(
        "the section's header and files",
        (now) =>
          now.rows.some((row) => row.label.endsWith("→ now ▾")) &&
          now.rows.filter((row) => row.level === 2).length === 4 &&
          now.rows.filter((row) => row.level === 2).every((row) => row.letter !== ""),
      );
      await shot("d1-select-row");
      const header = seen.rows.find((row) => row.label.endsWith("→ now ▾"));
      expect(
        header.label === `${base} → now ▾` &&
          /^4 files · \+\d+ −\d+ · observed · \d+ s ago$/.test(header.description),
        `the header reads "${header.label} ${header.description}"`,
      );
      const files = seen.rows
        .filter((row) => row.level === 2)
        .map((row) => `${row.label} ${row.description} ${row.letter}`);
      for (const want of [
        "limit.ts src/auth A",
        "limit.test.ts src/auth A",
        "rate-limit.md docs A",
        "README D",
      ])
        expect(
          files.some((file) => file.replace(/\s+/g, " ") === want.replace(/\s+/g, " ")),
          `no file row "${want}" among ${JSON.stringify(files)}`,
        );
      expect(rowOf(seen, "Comments") !== null, "no Comments row");
      expect(/^\d+$/.test(rowOf(seen, "Checkpoints")?.description ?? ""), "no Checkpoints · N row");
      return `before "${before.message}" · ${seen.title} · ${said(seen)}`;
    },
  );
  void d1;

  let pinnedHead = -1;
  const pinned = await step(
    "the slice the section pinned, as Mend holds it: base to a review-open checkpoint",
    async () => {
      const detail = await sessionRead(session.id);
      const head = detail.checkpoints.at(-1);
      expect(
        head.trigger === "review-open",
        `the newest checkpoint is ${head.trigger}, not the one review opened`,
      );
      pinnedHead = head.ordinal;
      return {
        checkpoints: detail.checkpoints.length,
        newest: `${head.ordinal} · ${head.trigger}`,
        change: detail.change?.id ?? null,
      };
    },
    { via: "api" },
  );

  await step(
    "d2 · she clicks limit.ts: VS Code's diff editor opens, base on the left, the pinned checkpoint on the right",
    async () => {
      await treeItem(/^limit\.tssrc\/auth|^limit\.ts/, { pane: "Change" }).click();
      const sides = await waitUntil(
        "the diff editor's two sides",
        async () => {
          const seen = await diffSides(h);
          return seen.found && seen.right.some((line) => line.includes("WINDOW_MS")) ? seen : null;
        },
        30_000,
      );
      await sleep(500);
      await shot("d2-read-the-diff");
      const tab = (await editorTabs(h)).find((one) => one.active);
      expect(
        tab?.label === `limit.ts (${base} ↔ checkpoint ${pinnedHead})`,
        `the diff tab reads "${tab?.label}"`,
      );
      expect(
        sides.left.join("").trim() === "",
        `the base side of an added file is not empty: ${JSON.stringify(sides.left)}`,
      );
      return `tab "${tab.label}" · left ${sides.left.length} lines · right ${JSON.stringify(sides.right.slice(0, 4))}`;
    },
  );

  await step(
    "d2 · Open all changes in the section's title: every file in one multi-diff editor",
    async () => {
      const actions = await changeActions(h);
      expect(
        actions.some((action) => action.title.startsWith("Open all changes")),
        `the section's buttons are ${JSON.stringify(actions)}`,
      );
      await clickChangeAction(h, "Open all changes");
      // VS Code appends the file count to the tab once it has read the files, after the tab shows.
      let label = "";
      await waitUntil(
        "the multi-diff editor's tab with its file count",
        async () => {
          const tab = (await editorTabs(h)).find(
            (one) => one.active && one.label.startsWith("Changes · "),
          );
          label = tab?.label ?? "";
          return label === `Changes · ${SESSION} (4 files)`;
        },
        30_000,
      ).catch(() => undefined);
      await sleep(1_500);
      await shot("d2-open-all-changes");
      expect(label === `Changes · ${SESSION} (4 files)`, `the tab reads "${label}"`);
      return `buttons ${JSON.stringify(actions.map((action) => action.title))} · tab "${label}"`;
    },
  );

  await step(
    "d5 · she clicks the header: Review which slice? offers main → now and between two checkpoints (last turn once a turn ended)",
    async () => {
      await treeItem("→ now ▾", { pane: "Change" }).click();
      await quickInput.waitFor();
      const rows = await waitUntil(
        "the picker's file counts",
        async () => {
          const now = await quickInput.rows();
          return now.some((row) => / · \d+ files?/.test(row.description)) ? now : null;
        },
        30_000,
      );
      await shot("d5-choose-what-to-review");
      const title = await quickInput.title();
      expect(title === `Review which slice? · ${SESSION}`, `the picker is titled "${title}"`);
      expect(rows[0]?.label === `${base} → now`, `the first choice is "${rows[0]?.label}"`);
      expect(
        rows.some((row) => row.label === "between two checkpoints…"),
        `no between two checkpoints… among ${JSON.stringify(rows.map((row) => row.label))}`,
      );
      return `"${title}" · ${JSON.stringify(rows.map((row) => `${row.label} · ${row.description}`))}`;
    },
  );

  await step(
    "d5 · between two checkpoints…: the two marked checkpoints; the files switch and the section says it is view-only (G10)",
    async () => {
      const titled = (title) =>
        waitUntil(`the pick titled "${title}"`, async () =>
          (await quickInput.title()) === title ? true : null,
        );
      await quickInput.pick("between two checkpoints…");
      await titled("Between two checkpoints · from which?");
      await quickInput.pick(`checkpoint ${marked.first}`, { exact: true });
      await titled(`Between checkpoint ${marked.first} and which checkpoint?`);
      await quickInput.pick(`checkpoint ${marked.second}`, { exact: true });
      const seen = await sectionUntil(
        "the section on the chosen slice",
        (now) =>
          now.rows.some(
            (row) => row.label === `checkpoint ${marked.first} → checkpoint ${marked.second} ▾`,
          ) && lettered(now),
      );
      await h.palette("View: Close All Editors");
      await shot("d5-between-two-checkpoints");
      const files = seen.rows
        .filter((row) => row.level === 2)
        .map((row) => `${row.label} ${row.letter}`);
      expect(
        files.includes("limit.ts M"),
        `limit.ts is not modified between the rounds: ${JSON.stringify(files)}`,
      );
      expect(
        files.includes("throttle.ts D"),
        `throttle.ts is not deleted between the rounds: ${JSON.stringify(files)}`,
      );
      expect(
        seen.rows.some((row) => row.label === `viewing · comments go on ${base} → now`),
        `no view-only note: ${said(seen)}`,
      );
      return said(seen);
    },
  );

  await step("d5 · a file of that slice opens between the two checkpoints", async () => {
    await treeItem(/^limit\.ts/, { pane: "Change" }).click();
    const tab = await waitUntil(
      "the slice's diff tab",
      async () =>
        (await editorTabs(h)).find(
          (one) =>
            one.active &&
            one.label === `limit.ts (checkpoint ${marked.first} ↔ checkpoint ${marked.second})`,
        ) ?? null,
      30_000,
    );
    await sleep(500);
    await shot("d5-slice-diff");
    const sides = await diffSides(h);
    expect(
      sides.left.some((line) => line.includes("TODO")),
      "the left side is not the first round's limit.ts",
    );
    return `tab "${tab.label}" · left ${JSON.stringify(sides.left.slice(0, 4))}`;
  });

  await step("d5 · back to main → now from the picker", async () => {
    await treeItem("▾", { pane: "Change" }).click();
    await quickInput.waitFor();
    await quickInput.pick(`${base} → now`, { exact: true });
    const seen = await sectionUntil(
      `${base} → now again`,
      (now) => now.rows.some((row) => row.label === `${base} → now ▾`) && lettered(now),
    );
    expect(
      !seen.rows.some((row) => row.label.startsWith("viewing ·")),
      "main → now still reads view-only",
    );
    return said(seen);
  });

  await step(
    "edge · the worktree moved on: the slice stays pinned, the header counts the new files, and Review the newer change pins them",
    async () => {
      const shell = await shellBeside(session);
      await shell.write(NEWER);
      await shell.close();
      await h.palette("Mend: Read the change again");
      const drifted = await sectionUntil("the worktree-changed line", (now) =>
        now.rows.some((row) => row.label === DRIFT),
      );
      await shot("edge-worktree-moved-on");
      const pinnedHeader = drifted.rows.find((row) => row.label === `${base} → now ▾`);
      expect(
        pinnedHeader?.description.startsWith("4 files · ") === true,
        `the pinned slice moved: "${pinnedHeader?.description}"`,
      );
      expect(
        drifted.rows.some((row) => row.label === "Review the newer change"),
        `no Review the newer change: ${said(drifted)}`,
      );
      await treeItem("Review the newer change", { pane: "Change" }).click();
      const repinned = await sectionUntil(
        "the newer change, pinned",
        (now) =>
          now.rows.some(
            (row) => row.label === `${base} → now ▾` && row.description.startsWith("6 files · "),
          ) && !now.rows.some((row) => row.label === DRIFT),
      );
      await shot("edge-review-the-newer-change");
      const head = (await sessionRead(session.id)).checkpoints.at(-1);
      expect(head.trigger === "review-open", `the newest checkpoint is ${head.trigger}`);
      return `${said(drifted)} → ${said(repinned)}`;
    },
  );

  await step(
    "rule 11 · Open in Mend (web) is in the section's overflow menu, not among its buttons",
    async () => {
      const items = await overflowItems(h);
      const buttons = await changeActions(h);
      await shot("overflow-open-in-web");
      expect(items.includes("Open in Mend (web)"), `the overflow offers ${JSON.stringify(items)}`);
      expect(
        !buttons.some((button) => button.title.includes("web")),
        `a title button opens the web app: ${JSON.stringify(buttons)}`,
      );
      return `overflow ${JSON.stringify(items)} · buttons ${JSON.stringify(buttons.map((button) => button.title))}`;
    },
  );

  await step(
    "the session stopped (Stop over the API)",
    async () => {
      await api(`/sessions/${session.id}/stop`, { method: "POST", body: "{}" });
      return waitUntil(
        "the session settled",
        async () => {
          const now = await sessionRead(session.id);
          return ["stopped", "completed", "failed"].includes(now.session.status)
            ? now.session.status
            : null;
        },
        180_000,
      );
    },
    { via: "api" },
  );

  await step(
    "a stopped session: selecting it shows the same change, and a file still opens",
    async () => {
      await revealSession(SESSION);
      await treeItem(SESSION, { pane: "Sessions" }).click();
      await h.palette("Mend: Read the change again");
      const seen = await sectionUntil(
        "the stopped session's change",
        (now) =>
          now.rows.some((row) => row.label === `${base} → now ▾`) &&
          now.rows.some((row) => row.label === "limit.test.ts"),
      );
      await treeItem(/^limit\.test\.ts/, { pane: "Change" }).click();
      const tab = await waitUntil(
        "the stopped session's diff",
        async () =>
          (await editorTabs(h)).find(
            (one) => one.active && one.label.startsWith(`limit.test.ts (${base} ↔`),
          ) ?? null,
        30_000,
      );
      await shot("stopped-session-review");
      return `${said(seen)} · tab "${tab.label}"`;
    },
  );

  await step(
    "its workspace window: Open resumes it there, and the section shows its change with nothing selected",
    async () => {
      await userSettings({ "window.openFoldersInNewWindow": "on" });
      const known = await h.windows();
      await revealSession(SESSION);
      await treeItem(SESSION, { pane: "Sessions" }).inline(OPEN);
      const opened = await waitUntil(
        "the session's workspace window",
        async () => (await h.newWindows(known, { settle: 2_000, limit: 10_000 }))[0] ?? null,
        600_000,
      );
      await h.useWindow(opened);
      await h.statusBar(/SSH:/).waitFor(600_000);
      await view("Mend");
      const seen = await sectionUntil(
        "the workspace window's Change section",
        (now) => now.rows.some((row) => row.label === `${base} → now ▾`) && lettered(now),
        180_000,
      );
      await shot("workspace-window-change");
      return `${seen.title} · ${said(seen)}`;
    },
  );

  note(`pinned ${JSON.stringify(pinned)}`);
};
