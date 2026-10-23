import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  changeRows,
  commentOnLine,
  commentThreads,
  editorTabs,
  expect,
  reviewWorld,
  ROUNDS,
  said,
} from "./vscode-review.lib.mjs";

const run = promisify(execFile);

const SESSION = process.env.MEND_REVIEW_SESSION ?? "add-rate-limit";
const FIRST = "Use the shared limiter from guard.ts";
const SECOND = "Count the burst per key, not per request";
const HELD = "Written while a newer version keeps this review";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const days = (ms) => Math.round(ms / 86_400_000);

export default async (h) => {
  const { step, note, sleep, view, treeItem, waitUntil, shot, state } = h;
  const { connectClaude, startClaude, shellBeside, reload, revealSession, project } =
    reviewWorld(h);

  const reviews = join(state.userData, "User", "globalStorage", "sealant-sh.mend", "reviews");
  const folder = async () => {
    const names = (await readdir(reviews)).filter((name) => name.includes("%3A"));
    expect(names.length === 1, `her reviews folder is not one folder: ${JSON.stringify(names)}`);
    return join(reviews, names[0]);
  };

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
  const file = async () => join(await folder(), `${encodeURIComponent(session.id)}.json`);

  const pendingCount = (seen) =>
    seen.rows.find((row) => row.label === "Comments")?.description ?? "";
  const select = async (pending) => {
    await view("Mend");
    await revealSession(SESSION);
    await treeItem(SESSION, { pane: "Sessions" }).click();
    return waitUntil(
      pending === null ? "the section's header" : `the section's Comments · ${pending} pending`,
      async () => {
        const seen = await changeRows(h);
        return seen.rows.some((row) => row.label === `${base} → now ▾`) &&
          (pending === null || pendingCount(seen).startsWith(`${pending} pending`))
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
  const threadOf = async (text) =>
    waitUntil(
      `the thread of "${text}"`,
      async () =>
        (await commentThreads(h)).find((thread) =>
          thread.comments.some((one) => one.text.includes(text)),
        ) ?? null,
      30_000,
    );

  await step("she writes a pending comment on line 12, and does not send it", async () => {
    await select(null);
    await openLimit();
    await commentOnLine(h, 12, FIRST);
    const seen = await select(1);
    await openLimit();
    const thread = await threadOf(FIRST);
    await shot("unsent-comment");
    expect(thread.comments[0]?.label === "pending", `her thread reads ${JSON.stringify(thread)}`);
    return `${said(seen)} · ${JSON.stringify(thread)}`;
  });

  const aged = await step(
    "a month passes: her review's file, a review that holds nothing and another session's unsent comment, each aged 40 days with touch -d",
    async () => {
      const mine = await file();
      const kept = JSON.parse(await readFile(mine, "utf8"));
      expect(kept.format === 1, `her kept file reads format ${kept.format}`);
      expect(
        kept.review.pending.length === 1 && kept.review.pending[0].body === FIRST,
        `her kept file holds ${JSON.stringify(kept.review.pending)}`,
      );
      const dir = await folder();
      const empty = join(dir, "an-old-session.json");
      await writeFile(
        empty,
        JSON.stringify({
          format: 1,
          rev: 1,
          review: { pending: [], sends: [], document: null, replacedDrafts: [] },
        }),
      );
      const other = join(dir, "another-session.json");
      await writeFile(
        other,
        JSON.stringify({
          format: 1,
          rev: 1,
          review: {
            pending: [{ ...kept.review.pending[0], id: "other", body: "Still unsent elsewhere" }],
            sends: [],
            document: null,
            replacedDrafts: [],
          },
        }),
      );
      for (const path of [mine, empty, other]) await run("touch", ["-d", "40 days ago", path]);
      const ages = Object.fromEntries(
        await Promise.all(
          [mine, empty, other].map(async (path) => [
            path.split("/").at(-1),
            days(Date.now() - (await stat(path)).mtimeMs),
          ]),
        ),
      );
      return { mine, empty, other, ages };
    },
    { via: "setup" },
  );

  await step(
    "VS Code starts again (Developer: Reload Window): her unsent comment is there",
    async () => {
      await reload();
      const seen = await select(1);
      await openLimit();
      const thread = await threadOf(FIRST);
      await shot("after-restart");
      return `${said(seen)} · ${JSON.stringify(thread)}`;
    },
  );

  await step(
    "she writes a second comment: the write sweeps her folder, which keeps every unsent comment and deletes only the review that held nothing",
    async () => {
      await commentOnLine(h, 13, SECOND);
      const seen = await select(2);
      await openLimit();
      await threadOf(FIRST);
      await threadOf(SECOND);
      await shot("after-sweep");
      const names = await readdir(await folder());
      expect(
        !names.includes("an-old-session.json"),
        `the sweep did not run: the review that held nothing is still there (${names.join(", ")})`,
      );
      expect(
        names.includes("another-session.json"),
        `the sweep deleted another session's unsent comment (${names.join(", ")})`,
      );
      const other = days(Date.now() - (await stat(aged.other)).mtimeMs);
      const kept = JSON.parse(await readFile(aged.mine, "utf8"));
      const bodies = kept.review.pending.map((one) => one.body);
      expect(
        bodies.includes(FIRST) && bodies.includes(SECOND),
        `her kept file holds ${JSON.stringify(bodies)}`,
      );
      return `${said(seen)} · files ${names.join(", ")} · another session's file still ${other} days old · her file holds ${JSON.stringify(bodies)}`;
    },
  );

  await step(
    "the pins and what this VS Code last looked at are files beside the reviews",
    async () => {
      const shared = {};
      for (const kind of ["pins", "last-seen"]) {
        const names = await readdir(join(reviews, kind));
        expect(names.length === 1, `${kind} holds ${JSON.stringify(names)}`);
        const kept = JSON.parse(await readFile(join(reviews, kind, names[0]), "utf8"));
        expect(kept.format === 1, `${kind} reads format ${kept.format}`);
        shared[kind] = Object.keys(kept.record ?? {});
      }
      return JSON.stringify(shared);
    },
    { via: "setup" },
  );

  const newer = await step(
    "another window runs a newer version of the extension, which writes her review in format 2 with an entry this version cannot read",
    async () => {
      const kept = JSON.parse(await readFile(aged.mine, "utf8"));
      const text = JSON.stringify({
        ...kept,
        format: 2,
        rev: kept.rev + 1,
        review: {
          ...kept.review,
          pending: [
            ...kept.review.pending,
            { ...kept.review.pending[0], id: "later", origin: { kind: "suggested" } },
          ],
        },
      });
      await writeFile(aged.mine, text);
      return { sha: sha(text), bytes: text.length };
    },
    { via: "setup" },
  );

  await step(
    "this window shows what it can read of that review, and keeps her new words held, with why, leaving the file as the newer version wrote it",
    async () => {
      await reload();
      const seen = await select(2);
      await openLimit();
      const watched = await h.watch();
      await commentOnLine(h, 9, HELD).catch((error) => note(`no thread yet: ${error.message}`));
      const thread = await threadOf(HELD);
      await sleep(1_500);
      await shot("newer-version-held");
      const toasts = watched === null ? null : await watched.stop();
      const text = await readFile(aged.mine, "utf8");
      expect(sha(text) === newer.sha, "the file the newer version wrote was changed");
      const words = JSON.stringify(thread);
      expect(
        /newer version of the Mend extension/.test(words) ||
          (toasts?.toasts ?? []).some((one) => /newer version/.test(one)),
        `her held words do not say why: ${words} · ${JSON.stringify(toasts)}`,
      );
      return `${said(seen)} · ${words} · the file's sha256 still ${newer.sha}`;
    },
  );
};
