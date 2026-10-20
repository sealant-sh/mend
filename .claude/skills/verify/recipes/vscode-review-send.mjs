// Story d, steps 6 and 7 of the VS Code redesign (flow 6, branch review-send), with its edge cases,
// driven as Dana meets them: Send review opens an editor with the instruction Mend will send, her
// comments in order with file and line, which she edits; Send to session records the follow-up
// under one idempotency key, and since her claude runs as a terminal agent (Mend holds the
// follow-up pending, G12), it attaches claude's terminal in her panel and pastes the review into
// its input without Enter; the threads read `follow-up pending · in claude's terminal`. A second
// review before Enter keeps the first as she sent it and pastes only its new comments. The agent's
// next round moves the worktree on: the slice stays pinned and the section says so, offering since
// my last review, where each sent comment sits at its anchor and she marks it Addressed, then
// Reopen. Then the edge cases: Mend offline (Send review disabled, her comment kept), Ana's
// stopped terminal session (no Send review, then a disabled one that says only Ana sends it one),
// and a delivery that fails (a stopped session whose claude login is gone), Retry delivery with
// the same key, and Mend starting the stopped session with the review as its first prompt.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-review-send.mjs --out <dir>
//
// Needs a world from `up` (signed in, workspace SSH set up) whose extension sends reviews. Claude
// runs on the skill's fake setup token and sits at its prompt; the recipe never presses Enter in
// it, because the fake login would only answer 401.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FAKES } from "../scripts/fakes.mjs";
import {
  ADDRESSED,
  changeActions,
  changeRows,
  clickChangeAction,
  clickEditorTitle,
  cliEnv,
  commentOnLine,
  commentThreads,
  editorLines,
  editorTabs,
  expect,
  reviewWorld,
  ROUNDS,
  said,
  world,
} from "./vscode-review.lib.mjs";

// A world that already ran this recipe names its next sessions apart: `MEND_REVIEW_SESSION`.
const SESSION = process.env.MEND_REVIEW_SESSION ?? "add-rate-limit";
const STOPPED = `${SESSION}-stopped`;
const FIRST = "Use the shared limiter from guard.ts";
const SECOND = "Test the sixth request";
const THIRD = "Key by account once she signs in";
const EDITED = "Keep the tests green.";
const IN_TERMINAL = "follow-up pending · in claude's terminal";
const NOT_HERS =
  "Only the session's owner sends it a review: Mend types it into a terminal agent, live or started for the stopped session";

/** Claude folds a long paste in its input: `[Pasted text #1 +12 lines]`, one per paste. */
const pastes = (text) =>
  [...text.matchAll(/\[Pasted text #(\d+) \+(\d+) lines\]/g)].map((found) => ({
    n: Number(found[1]),
    lines: Number(found[2]),
  }));
const times = (text, words) => text.split(words).length - 1;
/** A prompt Mend starts an agent with rides its argv base64-encoded: `sh -c <decode> sh <chunks…>`. */
const promptOf = (argv) =>
  argv[0] === "sh" && argv[3] === "sh"
    ? Buffer.from(argv.slice(4).join(""), "base64").toString("utf8")
    : argv.join(" ");

export default async (h) => {
  const { step, note, api, sleep, view, treeItem, quickInput, waitUntil, shot, page, state } = h;
  const lane = reviewWorld(h);
  const { project, connectClaude, startClaude, shellBeside, reload } = lane;

  await connectClaude();
  const session = await step(
    `${SESSION}: a claude terminal agent in its own worktree, at its prompt`,
    async () => startClaude(SESSION),
    { via: "setup" },
  );
  const shell = await step(
    "the change written in two rounds by a shell beside the agent, a checkpoint after each",
    async () => {
      const opened = await shellBeside(session);
      await opened.write(ROUNDS[0]);
      await opened.write(ROUNDS[1]);
      return opened;
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
  const commentsOf = (seen) => seen.rows.find((row) => row.label === "Comments")?.description ?? "";
  /** Her row when the view shows it; else Mend: Review change, which picks the session by name. */
  const select = async (label) => {
    // Another session's diffs would answer for this one's: the editors close first.
    await h.palette("View: Close All Editors");
    await view("Mend");
    const shown = (await h.viewRows("Sessions")).rows.some((row) => row.label === label);
    if (shown) await treeItem(label, { pane: "Sessions" }).click();
    else {
      await h.palette("Mend: Review change");
      await quickInput.waitFor();
      await quickInput.pick(label, { exact: true });
    }
    // The title moves at once and the rows a moment later: read until two reads agree.
    let last = "";
    return sectionUntil(`${label}'s change, held still`, (now) => {
      const drawn = JSON.stringify(now);
      const still = drawn === last;
      last = drawn;
      return still && now.title.endsWith(label) && now.rows.some((row) => row.label.endsWith("▾"));
    });
  };
  const openFile = async (name, tab) => {
    await treeItem(new RegExp(`^${name.replaceAll(".", "\\.")}`), { pane: "Change" }).click();
    await waitUntil(
      `${name}'s diff`,
      async () =>
        (await editorTabs(h)).find((one) => one.active && one.label.startsWith(tab)) ?? null,
      30_000,
    );
    await sleep(800);
  };
  const threadsReading = (words) =>
    waitUntil(
      `threads reading "${words}"`,
      async () => {
        const seen = await commentThreads(h);
        return seen.length > 0 &&
          seen.every((thread) => thread.comments.every((one) => one.label === words))
          ? seen
          : null;
      },
      60_000,
    );

  await step("d4 · two pending comments on limit.ts, lines 12 and 13", async () => {
    await select(SESSION);
    await openFile("limit.ts", "limit.ts (");
    await commentOnLine(h, 12, FIRST);
    await commentOnLine(h, 13, SECOND);
    const seen = await sectionUntil("Comments · 2 pending", (now) =>
      commentsOf(now).startsWith("2 pending"),
    );
    return said(seen);
  });

  const editor = await step(
    "d6 · Send review: an editor with the instruction Mend will send, her comments in order with file and line",
    async () => {
      const actions = await changeActions(h);
      expect(
        actions.some((action) => action.title === "Send review" && !action.disabled),
        `the section's buttons are ${JSON.stringify(actions)}`,
      );
      await clickChangeAction(h, "Send review");
      const tab = await waitUntil(
        "the review's editor",
        async () =>
          (await editorTabs(h)).find(
            (one) => one.active && one.title.startsWith(`review · ${SESSION}.md`),
          ) ?? null,
        30_000,
      );
      await sleep(800);
      const lines = await editorLines(h);
      await shot("d6-send-it-back");
      const first = lines.indexOf("## 1 · src/auth/limit.ts:12");
      const second = lines.indexOf("## 2 · src/auth/limit.ts:13");
      expect(
        lines[0] === `# Review for ${SESSION}`,
        `the editor starts ${JSON.stringify(lines[0])}`,
      );
      expect(
        first !== -1 && lines[first + 1] === FIRST,
        `no "## 1 · src/auth/limit.ts:12" then her words: ${JSON.stringify(lines)}`,
      );
      expect(
        second > first && lines[second + 1] === SECOND,
        `no "## 2 · src/auth/limit.ts:13" after it: ${JSON.stringify(lines)}`,
      );
      return { observed: `tab "${tab.title}" · ${JSON.stringify(lines)}`, lines };
    },
  );
  void editor;

  await step(
    "d6 · she edits the instruction before sending: one more line under What to do",
    async () => {
      await page().keyboard.press("Control+End");
      await page().keyboard.type(EDITED);
      await sleep(300);
      const lines = await editorLines(h);
      expect(
        lines.includes(EDITED),
        `her line is not in the editor: ${JSON.stringify(lines.slice(-3))}`,
      );
      return JSON.stringify(lines.slice(-3));
    },
  );

  let firstPaste = "";
  await step(
    "d6 · Send to session: claude's terminal attaches in her panel with the review pasted in its input, and no Enter",
    async () => {
      await clickEditorTitle(h, "Send to session");
      const tabs = await waitUntil(
        "claude's terminal in the panel",
        async () => {
          const seen = await h.terminal().tabs();
          return seen.names.some((name) => name.startsWith("claude") && name.includes(SESSION))
            ? seen
            : null;
        },
        60_000,
      );
      const text = await waitUntil(
        "the review in claude's input",
        async () => {
          const rows = (await h.terminal().read()).join("\n");
          return /Pasted text|Review for/.test(rows) ? rows : null;
        },
        60_000,
      );
      // Enter would make claude ask its provider, which answers 401 to the fake login.
      await sleep(4_000);
      const after = (await h.terminal().read()).join("\n");
      await shot("d6-sent-in-claudes-terminal");
      expect(
        !/401|API Error|authentication_error/i.test(after),
        `claude ran the review: ${after.slice(-400)}`,
      );
      firstPaste = after;
      return `terminal tabs ${JSON.stringify(tabs)} · claude reads ${JSON.stringify(text.slice(-600))}`;
    },
  );

  await step(
    "d6 · Mend holds one follow-up for the session, pending under the review's key",
    async () => {
      const followUp = await api(`/sessions/${session.id}/follow-up`);
      const rows = await lane.followUpRows(session.id);
      expect(followUp?.status === "pending", `the follow-up reads ${JSON.stringify(followUp)}`);
      expect(
        rows.length === 1 && rows[0].startsWith("vscode-follow-up:"),
        `follow_ups rows ${JSON.stringify(rows)}`,
      );
      return `status ${followUp.status} · rows ${JSON.stringify(rows.map((row) => row.replace(/:[0-9a-f-]{36}\|/, ":<uuid>|")))}`;
    },
    { via: "api" },
  );

  await step(`d6 · her threads read "${IN_TERMINAL}"`, async () => {
    await openFile("limit.ts", "limit.ts (");
    const threads = await threadsReading(IN_TERMINAL);
    const seen = await sectionUntil(
      "Comments · 2 sent · follow-up pending",
      (now) => commentsOf(now) === `2 sent · ${IN_TERMINAL}`,
    );
    await shot("d6-threads-follow-up-pending");
    return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments))}`;
  });

  await step(
    "edge · a second review before Enter: one more comment, Send review again, and the editor holds the first review as she sent it, then More comments",
    async () => {
      await commentOnLine(h, 9, THIRD);
      await sectionUntil("Comments · 1 pending", (now) => commentsOf(now).startsWith("1 pending"));
      await clickChangeAction(h, "Send review");
      const lines = await waitUntil(
        "the review's editor with More comments",
        async () => {
          const tab = (await editorTabs(h)).find(
            (one) => one.active && one.title.startsWith(`review · ${SESSION}.md`),
          );
          const now = tab === undefined ? [] : await editorLines(h);
          return now.includes("## More comments") ? now : null;
        },
        30_000,
      );
      await shot("edge-second-review-editor");
      const more = lines.indexOf("## More comments");
      const third = lines.indexOf("## 3 · src/auth/limit.ts:9");
      expect(
        lines.indexOf(`# Review for ${SESSION}`) !== -1 &&
          lines.indexOf(`# Review for ${SESSION}`) < more,
        `the first review is not above More comments: ${JSON.stringify(lines)}`,
      );
      expect(
        lines.filter((line) => line === FIRST).length === 1 &&
          lines.indexOf(FIRST) < more &&
          lines.indexOf(EDITED) !== -1 &&
          lines.indexOf(EDITED) < more,
        `the first review is not there once, as she edited it: ${JSON.stringify(lines)}`,
      );
      expect(
        third > more && lines[third + 1] === THIRD,
        `no "## 3 · src/auth/limit.ts:9" then her words under More comments: ${JSON.stringify(lines)}`,
      );
      return JSON.stringify(lines);
    },
  );

  await step(
    "edge · Send to session again: claude's input holds the first review once and only the new comments after it",
    async () => {
      await clickEditorTitle(h, "Send to session");
      const text = await waitUntil(
        "the new comments in claude's input",
        async () => {
          const rows = (await h.terminal().read()).join("\n");
          return rows !== firstPaste && (pastes(rows).length > 1 || rows.includes(THIRD))
            ? rows
            : null;
        },
        60_000,
      );
      await sleep(4_000);
      const after = (await h.terminal().read()).join("\n");
      await shot("edge-second-review-in-claudes-terminal");
      const [first, second, ...more] = pastes(after);
      expect(
        !/401|API Error|authentication_error/i.test(after),
        `claude ran the review: ${after.slice(-400)}`,
      );
      expect(
        first !== undefined && more.length === 0 && times(after, "Review for") === 0,
        `claude's input does not hold the first review once: ${after.slice(-800)}`,
      );
      // The whole review again would fold to more lines than the first; the new part alone, fewer.
      expect(
        second === undefined
          ? times(after, THIRD) === 1 && times(after, FIRST) === 0
          : second.lines < first.lines && times(after, FIRST) === 0,
        `claude's input repeats the first review: ${after.slice(-800)}`,
      );
      return `pastes ${JSON.stringify(pastes(after))} · claude reads ${JSON.stringify(after.slice(-600))} · first read ${JSON.stringify(text.slice(-200))}`;
    },
  );

  await step(
    "edge · Mend holds the whole review as she sent it: the first as edited, once, then the new comment",
    async () => {
      const followUp = await waitUntil(
        "a follow-up holding the new comment",
        async () => {
          const now = await api(`/sessions/${session.id}/follow-up`);
          return now?.instruction.includes(THIRD) ? now : null;
        },
        60_000,
      );
      const rows = await lane.followUpRows(session.id);
      const said3 = followUp.instruction;
      expect(followUp.status === "pending", `the follow-up reads ${followUp.status}`);
      expect(
        times(said3, FIRST) === 1 &&
          times(said3, EDITED) === 1 &&
          said3.indexOf(EDITED) < said3.indexOf("## More comments") &&
          said3.indexOf("## More comments") < said3.indexOf(THIRD),
        `Mend holds ${JSON.stringify(said3)}`,
      );
      return `status ${followUp.status} · ${followUp.commentIds.length} comments · rows ${JSON.stringify(rows.map((row) => row.replace(/:[0-9a-f-]{36}\|/, ":<uuid>|")))} · instruction ${JSON.stringify(said3)}`;
    },
    { via: "api" },
  );

  await step(`edge · after the second review the threads read "${IN_TERMINAL}"`, async () => {
    await openFile("limit.ts", "limit.ts (");
    const threads = await threadsReading(IN_TERMINAL);
    const seen = await sectionUntil("Comments · 3 sent · follow-up pending", (now) =>
      commentsOf(now).startsWith("3 sent"),
    );
    return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments.map((one) => one.label)))}`;
  });

  await step(
    "the agent's next round (the shell beside it) moves the worktree on, a checkpoint after it",
    async () => {
      await shell.write(ADDRESSED);
      return "limit.ts takes the shared limiter from guard.ts";
    },
    { via: "setup" },
  );

  await step(
    "edge · the worktree moved on: the slice stays pinned, and the section says what changed since",
    async () => {
      const seen = await sectionUntil(
        "the worktree-changed line",
        (now) => now.rows.some((row) => row.label.startsWith("worktree changed since this review")),
        90_000,
      );
      await shot("edge-worktree-moved-on");
      expect(
        seen.rows.some((row) => row.label === `${base} → now ▾`),
        "the pinned slice moved",
      );
      expect(
        seen.rows.some((row) => row.label.startsWith("since my last review")),
        `no since my last review row: ${said(seen)}`,
      );
      return said(seen);
    },
  );

  await step(
    "d7 · since my last review: the newer change, each sent comment at its anchor on the left",
    async () => {
      await treeItem(/^since my last review/, { pane: "Change" }).click();
      const seen = await sectionUntil("since my last review ▾", (now) =>
        now.rows.some((row) => row.label === "since my last review ▾"),
      );
      await openFile("limit.ts", "limit.ts (checkpoint");
      const threads = await waitUntil(
        "the sent threads over the newer diff",
        async () => {
          const found = await commentThreads(h);
          return found.length >= 2 ? found : null;
        },
        30_000,
      );
      await shot("d7-she-checks-what-it-did");
      const tab = (await editorTabs(h)).find((one) => one.active);
      return `${said(seen)} · tab "${tab?.label}" · ${JSON.stringify(threads.map((thread) => thread.comments.map((one) => one.label)))}`;
    },
  );

  await step(
    "d7 · she marks the first Addressed, then Reopens it; Mend says neither itself",
    async () => {
      const first = page()
        .locator(".editor-group-container.active .review-widget", { hasText: FIRST })
        .first();
      await first.locator(".comment-title").hover();
      await first.locator(".comment-title .action-label[aria-label^='Addressed']").click();
      await waitUntil(
        "the first comment addressed",
        async () =>
          (await commentThreads(h)).some((thread) =>
            thread.comments.some((one) => one.text.includes(FIRST) && one.label === "addressed"),
          ) || null,
        30_000,
      );
      await shot("d7-addressed");
      const changeId = (await api(`/sessions/${session.id}`)).change.id;
      const marked = (await api(`/changes/${changeId}/comments`)).find((one) => one.body === FIRST);
      expect(marked?.state === "addressed", `Mend holds the comment ${marked?.state}`);
      await first.locator(".comment-title").hover();
      await first.locator(".comment-title .action-label[aria-label^='Reopen']").click();
      await waitUntil(
        "the first comment open again",
        async () =>
          (await commentThreads(h)).some((thread) =>
            thread.comments.some((one) => one.text.includes(FIRST) && one.label !== "addressed"),
          ) || null,
        30_000,
      );
      const reopened = (await api(`/changes/${changeId}/comments`)).find(
        (one) => one.body === FIRST,
      );
      return `addressed, then ${reopened?.state} on Mend`;
    },
  );

  await step(
    "edge · offline: a pending comment, then Mend stops",
    async () => {
      await treeItem("▾", { pane: "Change" }).click();
      await quickInput.waitFor();
      await quickInput.pick(`${base} → now`, { exact: true });
      await sectionUntil(`${base} → now`, (now) =>
        now.rows.some((row) => row.label === `${base} → now ▾`),
      );
      await openFile("guard.ts", "guard.ts (");
      await commentOnLine(h, 3, "Name the window, not just its length");
      await lane.server("stop");
      return "server stopped";
    },
    { via: "setup" },
  );

  await step(
    "edge · offline: Send review is disabled and says Mend is offline; her comment is kept, the diff readable",
    async () => {
      const disabled = await waitUntil(
        "the offline Send review",
        async () => {
          const found = (await changeActions(h)).find(
            (action) => action.title === "Mend is offline; your comments are kept",
          );
          return found ?? null;
        },
        120_000,
      );
      const seen = await section();
      await openFile("guard.ts", "guard.ts (");
      const threads = await commentThreads(h);
      await shot("edge-offline");
      expect(disabled.disabled, "the offline Send review is enabled");
      expect(commentsOf(seen).startsWith("1 pending"), `her comment is gone: ${said(seen)}`);
      expect(
        threads.some((thread) => thread.comments.some((one) => one.label === "pending")),
        "her thread is gone",
      );
      return `button "${disabled.title}" disabled · ${said(seen)}`;
    },
  );

  await step(
    "edge · Mend comes back",
    async () => {
      await lane.server("start");
      await waitUntil(
        "Send review again",
        async () =>
          (await changeActions(h)).some((action) => action.title === "Send review") || null,
        240_000,
      );
      return "Send review offered again";
    },
    { via: "setup" },
  );

  // ── Ana's session ──
  let asAna = null;
  const ana = await step(
    "Ana joins, the project is shared, and her stopped claude session holds a change; shared control off",
    async () => {
      const { token: invitation } = await api("/organization/invitations", {
        method: "POST",
        body: JSON.stringify({ role: "member" }),
      });
      const signUp = await fetch(`${lane.origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: lane.origin,
          "content-type": "application/json",
          "x-mend-invitation": invitation,
        },
        body: JSON.stringify({
          email: `ana-${state.run}-${Date.now().toString(36)}@verify.invalid`,
          password: `ana-${crypto.randomUUID()}`,
          name: "Ana",
        }),
      });
      const bearer = signUp.headers.get("set-auth-token");
      expect(signUp.ok && bearer, `Ana's sign-up answered ${signUp.status}`);
      asAna = async (route, init = {}) => {
        const response = await fetch(`${lane.origin}/api${route}`, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        });
        const text = await response.text();
        expect(response.ok, `${init.method ?? "GET"} ${route} as Ana → ${response.status}`);
        return text === "" ? null : JSON.parse(text);
      };
      await api(`/projects/${project.id}/visibility`, {
        method: "PUT",
        body: JSON.stringify({ visibility: "shared" }),
      });
      const scratch = mkdtempSync(join(state.scratch, "ana-"));
      try {
        mkdirSync(join(scratch, "mend"), { mode: 0o700 });
        writeFileSync(
          join(scratch, "mend", "cli.json"),
          JSON.stringify({ url: lane.origin, token: bearer }),
          { mode: 0o600 },
        );
        const ran = await world.cli(
          ["connect", "claude", "--from-stdin"],
          { ...process.env, HOME: scratch, XDG_CONFIG_HOME: scratch },
          { input: FAKES.claude, allowFailure: true },
        );
        expect(ran.status === 0, `mend connect claude as Ana exited ${ran.status}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const started = await startClaude("ana-limits", asAna);
      const opened = await shellBeside(started, asAna);
      await opened.write(ROUNDS[0]);
      await opened.close();
      await asAna(`/sessions/${started.id}/stop`, { method: "POST", body: "{}" });
      await waitUntil(
        "Ana's session settled",
        async () =>
          ["stopped", "completed", "failed"].includes(
            (await lane.sessionRead(started.id, asAna)).session.status,
          ) || null,
        180_000,
      );
      return {
        observed: `ana-limits ${started.id.slice(0, 8)} · stopped · shared control off`,
        ...started,
      };
    },
    { via: "api" },
  );

  await step(
    "edge · Ana's session: Dana reads its change and comments, and Send review is not offered",
    async () => {
      await view("Mend");
      await h.palette("Mend: Refresh");
      await select("ana-limits");
      await openFile("limit.ts", "limit.ts (");
      await commentOnLine(h, 4, "Ask Ana: why true here?");
      const seen = await sectionUntil("Ana's change with Dana's comment", (now) =>
        commentsOf(now).startsWith("1 pending"),
      );
      const actions = await changeActions(h);
      await shot("edge-anas-session-no-send");
      expect(
        !actions.some((action) => action.title.startsWith("Send review")),
        `Send review is offered on Ana's session: ${JSON.stringify(actions)}`,
      );
      return `${said(seen)} · buttons ${JSON.stringify(actions.map((action) => action.title))}`;
    },
  );

  await step(
    "edge · Ana turns shared control on: her stopped terminal session's Send review is disabled, and says only its owner sends it one",
    async () => {
      await asAna(`/sessions/${ana.id}/shared-control`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      await h.palette("Mend: Read the change again");
      const actions = await waitUntil(
        "the owner-only Send review on Ana's session",
        async () => {
          const found = await changeActions(h);
          return found.some((action) => action.title === NOT_HERS) ? found : null;
        },
        60_000,
      );
      const tooltip = await h.viewAction(NOT_HERS).tooltip();
      await shot("edge-anas-session-shared-control");
      expect(
        actions.find((action) => action.title === NOT_HERS)?.disabled === true,
        `the owner-only Send review is enabled: ${JSON.stringify(actions)}`,
      );
      expect(
        !actions.some((action) => action.title === "Send review"),
        `Send review is offered on Ana's terminal session: ${JSON.stringify(actions)}`,
      );
      expect(tooltip === NOT_HERS, `its tooltip reads ${JSON.stringify(tooltip)}`);
      return `buttons ${JSON.stringify(actions)} · tooltip ${JSON.stringify(tooltip)}`;
    },
  );

  // ── delivery fails, then Retry delivery with the same key ──
  const stopped = await step(
    `${STOPPED}: a second claude session with a change, stopped; then claude disconnected`,
    async () => {
      const started = await startClaude(STOPPED);
      const opened = await shellBeside(started);
      await opened.write(ROUNDS[0]);
      await opened.close();
      await api(`/sessions/${started.id}/stop`, { method: "POST", body: "{}" });
      await waitUntil(
        `${STOPPED} settled`,
        async () =>
          ["stopped", "completed", "failed"].includes(
            (await lane.sessionRead(started.id)).session.status,
          ) || null,
        180_000,
      );
      const removed = await world.cli(["connect", "claude", "--remove"], cliEnv(state), {
        allowFailure: true,
      });
      expect(
        removed.status === 0,
        `mend connect claude --remove exited ${removed.status}: ${removed.stderr}`,
      );
      return started;
    },
    { via: "setup" },
  );

  await step(
    "edge · delivery fails: Send to session on the stopped session, whose launch Mend cannot make",
    async () => {
      await select(STOPPED);
      await openFile("limit.ts", "limit.ts (");
      await commentOnLine(h, 4, "Return the limit's answer, not true");
      await clickChangeAction(h, "Send review");
      await waitUntil(
        "the review's editor",
        async () =>
          (await editorTabs(h)).find(
            (one) => one.active && one.title.startsWith(`review · ${STOPPED}.md`),
          ) ?? null,
        30_000,
      );
      await clickEditorTitle(h, "Send to session");
      const seen = await sectionUntil(
        "delivery failed · retryable",
        (now) => commentsOf(now).includes("delivery failed · retryable"),
        300_000,
      );
      await openFile("limit.ts", "limit.ts (");
      const threads = await threadsReading("delivery failed · retryable");
      await shot("edge-delivery-failed");
      const rows = await lane.followUpRows(stopped.id);
      return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments))} · rows ${JSON.stringify(rows.map((row) => row.replace(/:[0-9a-f-]{36}\|/, ":<uuid>|")))} · toasts ${JSON.stringify(await h.notifications())}`;
    },
  );

  await step(
    "claude connected again with the fake setup token",
    async () => {
      const ran = await world.cli(["connect", "claude", "--from-stdin"], cliEnv(state), {
        input: FAKES.claude,
        allowFailure: true,
      });
      expect(ran.status === 0, `mend connect claude exited ${ran.status}`);
      return ran.stdout.trim();
    },
    { via: "setup" },
  );

  await step(
    "edge · Retry delivery sends the same key: one follow-up row, moved from failed on, and Mend launches the session on it",
    async () => {
      const before = await lane.followUpRows(stopped.id);
      await clickChangeAction(h, "Retry delivery");
      const rows = await waitUntil(
        "the follow-up moved on under its key",
        async () => {
          const now = await lane.followUpRows(stopped.id);
          return now.length === 1 && !now[0].endsWith("|delivery_failed") ? now : null;
        },
        60_000,
      ).catch(async (cause) => {
        // What Mend is doing instead: still inside a deliver it never answered, or nothing.
        const activity = await lane.serverActivity().catch((error) => [`unread: ${error.message}`]);
        throw new Error(`${cause.message} · Mend's connections ${JSON.stringify(activity)}`);
      });
      const key = (row) => row.split("|")[0];
      expect(
        before.length === 1 && key(before[0]) === key(rows[0]),
        `the retry used another key: ${JSON.stringify([before, rows])}`,
      );
      const seen = await section();
      await shot("edge-retry-same-key");
      return `${said(seen)} · rows before ${JSON.stringify(before.map((row) => row.replace(/:[0-9a-f-]{36}:/, ":<change>:")))} after ${JSON.stringify(rows.map((row) => row.replace(/:[0-9a-f-]{36}:/, ":<change>:")))}`;
    },
  );

  await step(
    "edge · after Retry delivery the thread reads where the follow-up is (sending, delivery in progress or sent), no longer delivery failed",
    async () => {
      await openFile("limit.ts", "limit.ts (");
      const threads = await waitUntil(
        "the thread past delivery failed",
        async () => {
          const seen = await commentThreads(h);
          const label = seen[0]?.comments[0]?.label ?? "";
          return ["sending", "delivery in progress", "sent"].includes(label) ? seen : null;
        },
        60_000,
      );
      await shot("edge-retry-delivery-in-progress");
      return JSON.stringify(threads.map((thread) => thread.comments));
    },
  );

  await step(
    "edge · Mend starts the stopped session with the review as its first prompt: a new claude terminal whose command carries it, the follow-up delivered",
    async () => {
      const rows = await waitUntil(
        "the follow-up delivered",
        async () => {
          const now = await lane.followUpRows(stopped.id);
          return now.length === 1 && now[0].endsWith("|delivered") ? now : null;
        },
        300_000,
      ).catch(async (cause) => {
        const now = await lane.followUpRows(stopped.id).catch((error) => [error.message]);
        const activity = await lane.serverActivity().catch((error) => [`unread: ${error.message}`]);
        throw new Error(
          `${cause.message} · rows ${JSON.stringify(now)} · Mend's connections ${JSON.stringify(activity)}`,
        );
      });
      const read = await lane.sessionRead(stopped.id);
      const agents = read.processes.filter((row) => row.kind.startsWith("agent-"));
      const started = agents.filter((row) => row.id !== stopped.agent);
      const carries = started.find(
        (row) =>
          promptOf(row.argv).startsWith(`# Review for ${STOPPED}`) &&
          promptOf(row.argv).includes("Return the limit's answer, not true"),
      );
      expect(
        carries !== undefined && carries.kind === "agent-pty",
        `no new claude terminal carries the review: ${JSON.stringify(agents.map((row) => ({ kind: row.kind, status: row.status, argv: row.argv.map((part) => part.slice(0, 60)) })))}`,
      );
      const transcript = await api(`/sessions/${stopped.id}/transcript`).catch((error) => ({
        events: [],
        unread: error.message,
      }));
      const firstUser = transcript.events.find((event) => event.kind === "user");
      return `session ${read.session.status} · rows ${JSON.stringify(rows.map((row) => row.replace(/:[0-9a-f-]{36}:/, ":<change>:")))} · ${carries.kind} ${carries.status}, its prompt ${JSON.stringify(promptOf(carries.argv))} · transcript's first user event ${JSON.stringify(firstUser?.text?.slice(0, 160) ?? null)} of ${transcript.events.length}`;
    },
    { via: "api" },
  );

  await step(
    "edge · the stopped session's thread reads sent once Mend reads its comment back as sent",
    async () => {
      await openFile("limit.ts", "limit.ts (");
      const threads = await threadsReading("sent");
      const seen = await sectionUntil("Comments · 1 sent", (now) =>
        commentsOf(now).startsWith("1 sent"),
      );
      const changeId = (await api(`/sessions/${stopped.id}`)).change.id;
      const onMend = (await api(`/changes/${changeId}/comments`)).map(
        (one) => `${one.body} · ${one.state} · sent to ${one.sentToSessionId?.slice(0, 8) ?? null}`,
      );
      await shot("edge-stopped-session-sent");
      return `${said(seen)} · ${JSON.stringify(threads.map((thread) => thread.comments.map((one) => one.label)))} · on Mend ${JSON.stringify(onMend)}`;
    },
  );

  note(
    "G12 not built: Mend holds a terminal agent's follow-up pending and nothing flushes it; the extension pastes the review into claude's input for her to press Enter (Yiannis's fallback, 2026-10-19).",
  );
};
