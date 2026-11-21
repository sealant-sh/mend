// @vitest-environment jsdom
import { SessionId, WorktreeId } from "@mend/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import { readDraft, writeDrafts } from "./drafts.ts";
import type { StartSpec } from "./new-session.ts";
import { draftItems, holdUntilStarted, readOutbox, waitingMessages } from "./outbox.ts";
import {
  dismissRefusal,
  isPendingRow,
  type PendingStart,
  type RefusedStart,
  startTitle,
  withPendingStarts,
  writingAddressOf,
} from "./pending-starts.ts";
import {
  composerStart,
  type StartCalls,
  type StartPlace,
  startInstantly,
} from "./start-session.ts";

beforeEach(() => {
  sessionStorage.clear();
  dismissRefusal();
});

const spec: StartSpec = {
  agent: "claude",
  prompt: "Tell me about this repo",
  model: "opus",
  effort: null,
  speed: null,
  permission: null,
  autoLand: null,
};

type Made = { readonly id: SessionId };

/** Mend's answer to making the session, and the hands that give it. */
const deferred = () => {
  const hands: { ok?: (made: Made) => void; fail?: (cause: unknown) => void } = {};
  const promise = new Promise<Made>((ok, fail) => {
    hands.ok = ok;
    hands.fail = fail;
  });
  return {
    promise,
    resolve: (made: Made) => hands.ok?.(made),
    reject: (cause: unknown) => hands.fail?.(cause),
  };
};

/** A read that answers when told to. */
const gate = () => {
  const hands: { open?: () => void } = {};
  const promise = new Promise<void>((open) => {
    hands.open = open;
  });
  return { promise, open: () => hands.open?.() };
};

/** Where the start shows: what it did there, in order, and what it was refused with. */
const placeOf = () => {
  const log: Array<string> = [];
  const refusals: Array<RefusedStart> = [];
  const place: StartPlace = {
    show: (draftId) => log.push(`show ${draftId}`),
    settle: (sessionId) => log.push(`settle ${sessionId}`),
    refuse: (refused) => {
      refusals.push(refused);
      log.push("refused");
    },
    prefetch: (sessionId) => {
      log.push(`read ${sessionId}`);
      return Promise.resolve();
    },
    holdOpening: (sessionId, text) => log.push(`hold ${sessionId}: ${text}`),
    moved: () => log.push("moved"),
  };
  return { place, log, refusals };
};

const callsWith = (made: Promise<Made>, launched: Array<string>) =>
  ({
    create: () => made,
    createInWorktree: () => made,
    launch: (sessionId) => {
      launched.push(sessionId);
      return Promise.resolve();
    },
  }) satisfies StartCalls;

const start = (made: Promise<Made>, launched: Array<string> = []) => ({
  draftId: "starting-1",
  userId: "ada",
  project: { id: "p-1", name: "pstack" },
  ...composerStart(callsWith(made, launched), "p-1", { _tag: "new" }, spec),
});

/** Where the start's composer writes, read at the moment of writing, as it does. */
const onStartPage = () => ({ userId: "ada", sessionId: writingAddressOf("starting-hand") });

describe("an instant start", () => {
  it("shows before Mend answers, then settles on the session it made once its page is read", async () => {
    const made = deferred();
    const launched: Array<string> = [];
    const { place, log } = placeOf();
    const started = startInstantly(place, start(made.promise, launched));
    // Pressed Start: the start's page is open already, with nothing back from Mend.
    expect(log).toEqual(["show starting-1"]);
    made.resolve({ id: SessionId.make("s-real") });
    await started;
    expect(launched).toEqual(["s-real"]);
    expect(log).toEqual([
      "show starting-1",
      "hold s-real: Tell me about this repo",
      "moved",
      "read s-real",
      "settle s-real",
    ]);
  });

  it("moves what was written while it started onto the session Mend made", async () => {
    const made = deferred();
    const started = startInstantly(placeOf().place, start(made.promise));
    holdUntilStarted({ userId: "ada", sessionId: "starting-1" }, "And the tests.", "k-1");
    made.resolve({ id: SessionId.make("s-real") });
    await started;
    expect(waitingMessages({ userId: "ada", sessionId: "s-real" }).map((m) => m.text)).toEqual([
      "And the tests.",
    ]);
    expect(readOutbox({ userId: "ada", sessionId: "starting-1" })).toEqual([]);
  });

  it("gives the session what is written on the start's page after Mend answered (SLNT-1232)", async () => {
    // The session's page is read slowly, so the start's page stays on screen meanwhile.
    const reading = gate();
    const { place } = placeOf();
    const launched: Array<string> = [];
    const started = startInstantly(
      { ...place, prefetch: () => reading.promise },
      {
        ...start(Promise.resolve({ id: SessionId.make("s-hand") }), launched),
        draftId: "starting-hand",
      },
    );
    // Mend has answered and the agent is launching: the session's page is being read now.
    await vi.waitFor(() => expect(launched).toEqual(["s-hand"]));
    holdUntilStarted(onStartPage(), "Also the README.", "k-1");
    writeDrafts([[draftItems(onStartPage()).text, "Half a thought"]]);
    reading.open();
    await started;
    // Settled, but the start's page may still be drawn until the session's page replaces it.
    holdUntilStarted(onStartPage(), "And the tests.", "k-2");
    const session = { userId: "ada", sessionId: "s-hand" };
    expect(waitingMessages(session).map((m) => m.text)).toEqual([
      "Also the README.",
      "And the tests.",
    ]);
    expect(readDraft(draftItems(session).text)).toBe("Half a thought");
    expect(readOutbox({ userId: "ada", sessionId: "starting-hand" })).toEqual([]);
  });

  it("holds no first message for a start that has none (a menu's)", async () => {
    const { place, log } = placeOf();
    await startInstantly(place, {
      ...start(Promise.resolve({ id: SessionId.make("s-real") })),
      prompt: "",
    });
    expect(log).toEqual(["show starting-1", "moved", "read s-real", "settle s-real"]);
  });

  it("refused, gives back every word written with Mend's reason, and launches nothing", async () => {
    const made = deferred();
    const launched: Array<string> = [];
    const { place, log, refusals } = placeOf();
    const started = startInstantly(place, start(made.promise, launched));
    const draft = { userId: "ada", sessionId: "starting-1" };
    holdUntilStarted(draft, "And the tests.", "k-1");
    writeDrafts([[draftItems(draft).text, "Half a thought"]]);
    made.reject(new Error("The project is being removed."));
    await started;
    expect(launched).toEqual([]);
    expect(log).toEqual(["show starting-1", "refused"]);
    expect(refusals).toEqual([
      {
        draftId: "starting-1",
        prompt: "Tell me about this repo\n\nAnd the tests.\n\nHalf a thought",
        words: "The session didn't start. The project is being removed.",
      },
    ]);
    expect(readOutbox(draft)).toEqual([]);
    expect(readDraft(draftItems(draft).text)).toBe("");
  });

  it("says a refusal in the start's own first words", async () => {
    const { place, refusals } = placeOf();
    await startInstantly(place, {
      ...start(Promise.reject(new Error("No such worktree."))),
      failure: "The shell didn't start.",
    });
    expect(refusals[0]?.words).toBe("The shell didn't start. No such worktree.");
  });
});

/** A row as the server lists it, under another session id. */
const listed = (row: SessionInboxRowDto, id: string): SessionInboxRowDto => ({
  ...row,
  session: { ...row.session, id: SessionId.make(id) },
});

describe("a start in the inbox", () => {
  const sentAt = new Date("2026-11-20T03:02:00Z");
  const pending = (sessionId: string | null): PendingStart => ({
    draftId: "starting-1",
    userId: "ada",
    project: { id: "p-1", name: "pstack" },
    harness: "claude",
    prompt: "Tell me about this repo\nand its tests",
    selection: null,
    sentAt,
    sessionId,
  });

  it("is a starting session of its own, named by its first line, with no actions", () => {
    const [row] = withPendingStarts([], [pending(null)]);
    expect(row?.session.status).toBe("starting");
    expect(row?.session.id).toBe("starting-1");
    expect(row?.title).toBe("Tell me about this repo");
    expect(row !== undefined && isPendingRow(row)).toBe(true);
  });

  it("carries the made session's id until that session is listed, then gives way to it", () => {
    const [made] = withPendingStarts([], [pending("s-real")]);
    expect(made?.session.id).toBe("s-real");
    if (made === undefined) throw new Error("no row");
    // The server's own row for it: same id, its real worktree.
    const real = listed(
      { ...made, session: { ...made.session, worktreeId: WorktreeId.make("w-1") } },
      "s-real",
    );
    expect(withPendingStarts([real], [pending("s-real")])).toEqual([real]);
  });

  it("names an empty first message as a new session", () => {
    expect(startTitle("  ")).toBe("New session");
  });
});
