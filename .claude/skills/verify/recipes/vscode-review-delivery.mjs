// Story d, step 6: three ways a review she composed in VS Code could go out wrong, driven as Dana
// meets them, each on a claude terminal agent of its own.
// - She clears the whole review and presses Send to session: nothing is sent, the editor stays, her
//   comment stays pending, and Mend holds no follow-up and no comment for it.
// - She composes a review, leaves its editor open, the agent's next round moves the worktree on, she
//   presses Review the newer change, then Send to session from the old editor: the follow-up goes out
//   on the slice she composed on, the one its instruction names.
// - A review VS Code pasted into claude's terminal, then the session stops before she enters it, then
//   one more comment: Send review is offered, not Retry delivery, and the new review carries the
//   comment she sent before.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-review-delivery.mjs --out <dir>
//
// Needs a world from `up` (signed in, workspace SSH set up). Each run starts three sessions under
// new names (`MEND_REVIEW_SESSION` names the run's prefix). The recipe never presses Enter in claude:
// the skill's fake login would only answer 401.

import { FAKES } from "../scripts/fakes.mjs";
import {
  ADDRESSED,
  changeActions,
  changeRows,
  clickChangeAction,
  clickEditorTitle,
  cliEnv,
  commentOnLine,
  editorLines,
  editorTabs,
  expect,
  reviewWorld,
  ROUNDS,
  said,
  world,
} from "./vscode-review.lib.mjs";

const PREFIX = process.env.MEND_REVIEW_SESSION ?? `dlv${Date.now().toString(36).slice(-4)}`;
const EMPTY = `${PREFIX}-empty`;
const REPIN = `${PREFIX}-repin`;
const EXITED = `${PREFIX}-exited`;
const EMPTY_WORDS = "Return the limit's answer, not true";
const REPIN_WORDS = "Use the shared limiter from guard.ts";
const EARLIER_WORDS = "Drop the TODO once the limiter answers";
const LATER_WORDS = "Name the limit in the function";
const PASTED = "follow-up pending · pasted into claude's terminal";
const NOT_DELIVERED = "Your last review was not delivered";
const SETTLE_MS = 5_000;

const commentsOf = (seen) => seen.rows.find((row) => row.label === "Comments")?.description ?? "";
const brief = (rows) =>
  rows.map((row) => ({
    ...row,
    key: row.key?.replace(/:[0-9a-f-]{36}:/, ":<change>:"),
    slice: row.slice?.slice(0, 8),
    instruction: row.instruction?.slice(0, 400),
  }));

export default async (h) => {
  const { step, note, api, sleep, view, treeItem, quickInput, waitUntil, shot, page } = h;
  const lane = reviewWorld(h);
  const { connectClaude, startClaude, shellBeside, reload, followUps, reviewSlices } = lane;
  const failed = [];
  const stepContinuingOnFailure = (name, fn, options) =>
    step(name, fn, options).catch(() => {
      failed.push(name);
      return null;
    });

  await connectClaude();
  const startWithChange = (label, rounds, { keepShell = false } = {}) =>
    step(
      `${label}: a claude terminal agent whose change ${rounds.length === 1 ? "adds limit.ts, throttle.ts and docs" : "is written in two rounds"}, a checkpoint after each`,
      async () => {
        const session = await startClaude(label);
        const shell = await shellBeside(session);
        for (const round of rounds) await shell.write(round);
        if (!keepShell) await shell.close();
        return { session, shell: keepShell ? shell : null };
      },
      { via: "setup" },
    );
  const empty = (await startWithChange(EMPTY, [ROUNDS[0]])).session;
  const repinned = await startWithChange(REPIN, ROUNDS, { keepShell: true });
  const repin = repinned.session;
  const exited = (await startWithChange(EXITED, [ROUNDS[0]])).session;

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
  /** Her session's change, by Mend: Review change, which picks the session by its whole name. */
  const select = async (label, { closeEditors = true } = {}) => {
    if (closeEditors) await h.palette("View: Close All Editors");
    await view("Mend");
    await h.palette("Mend: Review change");
    await quickInput.waitFor();
    await quickInput.pick(label, { exact: true });
    let last = "";
    return sectionUntil(`${label}'s change, held still`, (now) => {
      const drawn = JSON.stringify(now);
      const still = drawn === last;
      last = drawn;
      return still && now.title.endsWith(label) && now.rows.some((row) => row.label.endsWith("▾"));
    });
  };
  const openLimit = async () => {
    await treeItem(/^limit\.ts/, { pane: "Change" }).click();
    await waitUntil(
      "limit.ts's diff",
      async () =>
        (await editorTabs(h)).find((one) => one.active && one.label.startsWith("limit.ts (")) ??
        null,
      30_000,
    );
    await sleep(800);
  };
  const reviewTab = async (label) =>
    (await editorTabs(h)).find((one) => one.title.startsWith(`review · ${label}.md`)) ?? null;
  const composeReview = async (label) => {
    await clickChangeAction(h, "Send review");
    await waitUntil(
      "the review's editor",
      async () => {
        const tab = await reviewTab(label);
        return tab?.active ? tab : null;
      },
      30_000,
    );
    await sleep(800);
    return editorLines(h);
  };
  const showReviewTab = async (label) => {
    await page()
      .locator(".part.editor .tabs-container .tab", { hasText: `review · ${label}.md` })
      .first()
      .click();
    await sleep(1_000);
  };
  /** The section's Comments row once it holds still, and not sending or delivering, for 5 s. */
  const commentsSettled = async (limit = 90_000) => {
    let last = { reads: null, since: 0 };
    return sectionUntil(
      "the Comments row held still",
      (now) => {
        const reads = commentsOf(now);
        if (reads !== last.reads) last = { reads, since: Date.now() };
        return !/sending|delivering/.test(reads) && Date.now() - last.since >= SETTLE_MS;
      },
      limit,
    ).catch(async (cause) => {
      note(cause.message.split("\n")[0]);
      return section();
    });
  };
  const changeOf = async (session) => (await api(`/sessions/${session.id}`)).change.id;
  const heldOnMend = async (session) =>
    (await api(`/changes/${await changeOf(session)}/comments`)).map(
      (one) => `${one.body} · ${one.state}`,
    );

  // ── 5 · an empty review ──
  await step(`d4 · ${EMPTY}: a pending comment on limit.ts line 4`, async () => {
    await select(EMPTY);
    await openLimit();
    await commentOnLine(h, 4, EMPTY_WORDS);
    return said(
      await sectionUntil("Comments · 1 pending", (now) => commentsOf(now).startsWith("1 pending")),
    );
  });

  await stepContinuingOnFailure(
    "d6 · Send review, the whole review cleared, Send to session: nothing is sent, the editor stays, her comment stays pending, Mend holds nothing for it",
    async () => {
      const composed = await composeReview(EMPTY);
      await page()
        .locator(".editor-group-container.active .editor-container .monaco-editor .view-lines")
        .first()
        .click();
      await page().keyboard.press("Control+A");
      await page().keyboard.press("Delete");
      await sleep(500);
      const cleared = await editorLines(h);
      await shot("empty-cleared");
      const watch = await h.watch();
      await clickEditorTitle(h, "Send to session");
      await waitUntil(
        "a toast, or the Comments row moving",
        async () =>
          (await h.notifications()).length > 0 ||
          !commentsOf(await section()).startsWith("1 pending")
            ? true
            : null,
        30_000,
      ).catch((cause) => note(cause.message.split("\n")[0]));
      const seen = await commentsSettled();
      await sleep(SETTLE_MS);
      const shown = await watch.stop();
      const toasts = await h.notifications();
      const tab = await reviewTab(EMPTY);
      const rows = await followUps(empty.id);
      const onMend = await heldOnMend(empty);
      await shot("empty-after-send");
      const observed = `composed ${composed.length} lines, cleared to ${JSON.stringify(cleared)} · toasts ${JSON.stringify(toasts)} · shown ${JSON.stringify(shown)} · review tab ${JSON.stringify(tab)} · section ${said(await section())} · follow-ups ${JSON.stringify(brief(rows))} · on Mend ${JSON.stringify(onMend)}`;
      expect(
        [...toasts, ...(shown?.toasts ?? [])].some((one) => /nothing was sent/i.test(one)),
        `no toast said nothing was sent: ${observed}`,
      );
      expect(tab !== null, `the review's editor closed: ${observed}`);
      expect(commentsOf(seen).startsWith("1 pending"), `her comment is not pending: ${observed}`);
      expect(rows.length === 0, `Mend holds a follow-up: ${observed}`);
      expect(
        !onMend.some((one) => one.startsWith(EMPTY_WORDS)),
        `Mend holds her comment: ${observed}`,
      );
      return observed;
    },
  );
  await h.palette("Notifications: Clear All Notifications");

  // ── 6 · a review composed before she repinned ──
  await step(`d4 · ${REPIN}: a pending comment on limit.ts line 12`, async () => {
    await select(REPIN);
    await openLimit();
    await commentOnLine(h, 12, REPIN_WORDS);
    return said(
      await sectionUntil("Comments · 1 pending", (now) => commentsOf(now).startsWith("1 pending")),
    );
  });

  const composedOn = await step(
    "d6 · Send review composes her review on the pinned slice; she leaves its editor open",
    async () => {
      const lines = await composeReview(REPIN);
      await shot("repin-composed");
      const sliceLine = lines.find((line) => line.startsWith("Slice: ")) ?? "";
      const named = Number(/→ checkpoint (\d+)/.exec(sliceLine)?.[1] ?? Number.NaN);
      const slices = await reviewSlices(await changeOf(repin));
      const pinned = slices.at(-1);
      expect(pinned !== undefined, "Mend holds no slice for the change");
      expect(
        pinned.to === named,
        `the editor names checkpoint ${named}, the slice Mend pinned last ends at ${pinned.to}: ${JSON.stringify(slices)}`,
      );
      return {
        observed: `${JSON.stringify(sliceLine)} · Mend's newest slice ${pinned.id.slice(0, 8)} (${pinned.from} → ${pinned.to}) of ${slices.length}`,
        slice: pinned,
        named,
      };
    },
    { via: "api" },
  );

  await step(
    "the agent's next round (the shell beside it) moves the worktree on, a checkpoint after it",
    async () => {
      await repinned.shell.write(ADDRESSED);
      await repinned.shell.close();
      return "limit.ts takes the shared limiter from guard.ts";
    },
    { via: "setup" },
  );

  await step("d5 · Review the newer change pins the newer slice", async () => {
    const moved = (now) =>
      now.rows.some((row) => row.label.startsWith("worktree changed since this review"));
    const seen = await sectionUntil("the worktree-changed line", moved, 90_000).catch(async () => {
      await h.palette("Mend: Read the change again");
      return sectionUntil("the worktree-changed line", moved, 60_000);
    });
    await shot("repin-worktree-moved");
    await treeItem(/^Review the newer change/, { pane: "Change" }).click();
    const after = await sectionUntil(
      "the newer slice pinned",
      (now) => !moved(now) && now.title.endsWith(REPIN),
      60_000,
    );
    const slices = await reviewSlices(await changeOf(repin));
    expect(
      slices.at(-1)?.id !== composedOn.slice.id,
      `Mend pinned no newer slice: ${JSON.stringify(slices)}`,
    );
    await shot("repin-newer-pinned");
    return `before ${said(seen)} · after ${said(after)} · slices ${JSON.stringify(slices.map((one) => `${one.id.slice(0, 8)} ${one.from}→${one.to}`))}`;
  });

  await stepContinuingOnFailure(
    "d6 · Send to session from the editor composed before the repin: the follow-up goes out on the slice she composed on, the checkpoint its instruction names",
    async () => {
      expect((await reviewTab(REPIN)) !== null, "her review's editor is gone");
      await showReviewTab(REPIN);
      const watch = await h.watch();
      await clickEditorTitle(h, "Send to session");
      const rows = await waitUntil(
        "a follow-up for the review",
        async () => {
          const now = await followUps(repin.id);
          return now.some((row) => row.instruction.includes(REPIN_WORDS)) ? now : null;
        },
        60_000,
      ).catch(async (cause) => {
        note(cause.message.split("\n")[0]);
        return followUps(repin.id);
      });
      const seen = await commentsSettled();
      const shown = await watch.stop();
      await shot("repin-sent");
      const slices = await reviewSlices(await changeOf(repin));
      const sent = rows.findLast((row) => row.instruction.includes(REPIN_WORDS));
      const named = Number(/Slice: .*→ checkpoint (\d+)/.exec(sent?.instruction ?? "")?.[1]);
      const observed = `follow-up ${JSON.stringify(sent === undefined ? null : brief([sent])[0])} · its instruction names checkpoint ${named} · composed on ${composedOn.slice.id.slice(0, 8)} (${composedOn.slice.from} → ${composedOn.slice.to}) · slices ${JSON.stringify(slices.map((one) => `${one.id.slice(0, 8)} ${one.from}→${one.to}`))} · section ${said(seen)} · toasts ${JSON.stringify(await h.notifications())} · shown ${JSON.stringify(shown)}`;
      expect(sent !== undefined, `Mend holds no follow-up with her review: ${observed}`);
      expect(
        sent.slice === composedOn.slice.id && sent.to === composedOn.slice.to && sent.to === named,
        `the follow-up went out on another slice than the one she composed on: ${observed}`,
      );
      return observed;
    },
    { via: "api" },
  );
  await h.palette("Notifications: Clear All Notifications");

  // ── 3 · a pasted review, then claude exits ──
  await step(
    `d6 · ${EXITED}: one comment, Send review, Send to session pastes it into claude's terminal`,
    async () => {
      await select(EXITED);
      await openLimit();
      await commentOnLine(h, 4, EARLIER_WORDS);
      await sectionUntil("Comments · 1 pending", (now) => commentsOf(now).startsWith("1 pending"));
      await composeReview(EXITED);
      await clickEditorTitle(h, "Send to session");
      const text = await waitUntil(
        "the review in claude's input",
        async () => {
          const rows = (await h.terminal().read()).join("\n");
          return /Pasted text|Review for/.test(rows) ? rows : null;
        },
        60_000,
      );
      const seen = await sectionUntil(`Comments · 1 ${PASTED}`, (now) =>
        commentsOf(now).startsWith(`1 ${PASTED}`),
      );
      await shot("exited-pasted");
      return `${said(seen)} · claude reads ${JSON.stringify(text.slice(-300))} · follow-ups ${JSON.stringify(brief(await followUps(exited.id)))}`;
    },
  );

  await step(
    `${EXITED} stops before she presses Enter in claude: its claude exits`,
    async () => {
      const before = await lane.sessionRead(exited.id);
      const agent = before.processes.find(
        (row) => row.kind === "agent-pty" && row.exitedAt === null,
      );
      const settled = async () =>
        ["stopped", "completed", "failed"].includes(
          (await lane.sessionRead(exited.id)).session.status,
        )
          ? true
          : null;
      await api(`/sessions/${exited.id}/stop`, { method: "POST", body: "{}" });
      const once = await waitUntil(`${EXITED} settled`, settled, 120_000).then(
        () => true,
        () => false,
      );
      if (!once) {
        await api(`/sessions/${exited.id}/stop`, { method: "POST", body: "{}" });
        await waitUntil(`${EXITED} settled`, settled, 180_000);
      }
      const after = await lane.sessionRead(exited.id);
      const ended = after.processes.find((row) => row.id === agent?.id);
      expect(ended?.exitedAt !== null, `claude ${agent?.id} has not exited`);
      return `${once ? 1 : 2} Stop(s) · session ${after.session.status} · claude ${agent?.id.slice(0, 8)} exited ${ended?.exitedAt}`;
    },
    { via: "setup" },
  );

  await step(`d4 · ${EXITED}: one more comment, on limit.ts line 3`, async () => {
    await select(EXITED);
    const before = said(await section());
    await openLimit();
    await commentOnLine(h, 3, LATER_WORDS);
    const seen = await sectionUntil("one pending comment", (now) =>
      commentsOf(now).includes("1 pending"),
    );
    await shot("exited-later-comment");
    return `before ${before} · after ${said(seen)}`;
  });

  const offered = await stepContinuingOnFailure(
    "d6 · with claude gone, Send review is offered, not Retry delivery, and nothing says her last review was not delivered",
    async () => {
      const seen = await commentsSettled(30_000);
      const actions = await changeActions(h);
      const rows = await h
        .paletteRows("Mend: Send review")
        .catch((error) => [String(error.message)]);
      const toasts = await h.notifications();
      await shot("exited-offer");
      const observed = `section buttons ${JSON.stringify(actions)} · palette ${JSON.stringify(rows)} · section ${said(seen)} · toasts ${JSON.stringify(toasts)} · follow-ups ${JSON.stringify(brief(await followUps(exited.id)))}`;
      expect(
        actions.some((action) => action.title === "Send review" && !action.disabled),
        `no enabled Send review: ${observed}`,
      );
      expect(
        !actions.some((action) => action.title.startsWith("Retry delivery")),
        `Retry delivery is offered: ${observed}`,
      );
      expect(
        ![JSON.stringify(actions), said(seen), ...toasts].some((one) =>
          one.includes(NOT_DELIVERED),
        ),
        `it says "${NOT_DELIVERED}": ${observed}`,
      );
      return observed;
    },
  );

  await stepContinuingOnFailure(
    "d6 · Send review, then Send to session: the new review carries the comment she sent before and the new one, and Mend takes it",
    async () => {
      expect(offered !== null, "Send review was not offered: nothing to send from");
      const lines = await composeReview(EXITED);
      await shot("exited-composed");
      const composed = lines.join("\n");
      // The fake login reads as needing reconnecting soon after a stop: Mend would refuse the launch.
      const connected = await world.cli(["connect", "claude", "--from-stdin"], cliEnv(h.state), {
        input: FAKES.claude,
        allowFailure: true,
      });
      expect(connected.status === 0, `mend connect claude exited ${connected.status}`);
      const watch = await h.watch();
      await clickEditorTitle(h, "Send to session");
      const rows = await waitUntil(
        "a follow-up with the new comment",
        async () => {
          const now = await followUps(exited.id);
          return now.some((row) => row.instruction.includes(LATER_WORDS)) ? now : null;
        },
        60_000,
      ).catch(async (cause) => {
        note(cause.message.split("\n")[0]);
        return followUps(exited.id);
      });
      const seen = await commentsSettled();
      const shown = await watch.stop();
      await shot("exited-sent");
      const sent = rows.findLast((row) => row.instruction.includes(LATER_WORDS));
      const observed = `editor ${JSON.stringify(lines)} · follow-ups ${JSON.stringify(brief(rows))} · section ${said(seen)} · toasts ${JSON.stringify(await h.notifications())} · shown ${JSON.stringify(shown)}`;
      expect(
        composed.includes(EARLIER_WORDS) && composed.includes(LATER_WORDS),
        `the review does not list both comments: ${observed}`,
      );
      expect(
        sent !== undefined &&
          sent.instruction.includes(EARLIER_WORDS) &&
          sent.commentIds.length === 2 &&
          sent.status !== "delivery_failed",
        `Mend holds no follow-up with both comments: ${observed}`,
      );
      return observed;
    },
    { via: "api" },
  );

  note(`sessions ${empty.id} (${EMPTY}), ${repin.id} (${REPIN}) and ${exited.id} (${EXITED})`);
  await step("every step under test held", async () => {
    expect(failed.length === 0, `${failed.length} failed: ${JSON.stringify(failed)}`);
    return "all held";
  });
};
