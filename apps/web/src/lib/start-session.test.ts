// @vitest-environment jsdom
import { SessionId, WorktreeId } from "@mend/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionInboxRowDto } from "./api.ts";
import type { SessionStartReadDto } from "./api.ts";
import { readDraft, writeDrafts } from "./drafts.ts";
import type { StartSpec } from "./new-session.ts";
import { draftItems, holdForStart, type OutboxMessage, readOutbox } from "./outbox.ts";
import {
  beginStart,
  dismissRefusal,
  isPendingRow,
  storedStartIn,
  type PendingStart,
  type RefusedStart,
  startTitle,
  withPendingStarts,
  writingAddressOf,
} from "./pending-starts.ts";
import {
  composerStart,
  RECOVERY_UNKNOWN_MS,
  recoverStart,
  type StartCalls,
  START_NEVER_ARRIVED,
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
  const sent: Array<{
    readonly sessionId: string;
    readonly written: ReadonlyArray<OutboxMessage>;
  }> = [];
  const place: StartPlace = {
    show: (draftId) => log.push(`show ${draftId}`),
    settle: (sessionId) => log.push(`settle ${sessionId}`),
    refuse: (refused) => {
      refusals.push(refused);
      log.push("refused");
    },
    prefetch: (sessionId, opening) => {
      log.push(
        opening ? `read ${sessionId} until it holds the first message` : `read ${sessionId}`,
      );
      return Promise.resolve();
    },
    sendWritten: (sessionId, written) => {
      sent.push({ sessionId, written });
      log.push(`send ${written.length} to ${sessionId}`);
    },
    moved: () => log.push("moved"),
  };
  return { place, log, refusals, sent };
};

/** Mend's one start call: `asked` records each start's key and its first message, in order. */
const callsWith = (made: Promise<Made>, asked: Array<string>) =>
  ({
    start: (key, _target, _harness, launch) => {
      asked.push(`${key}: ${launch.prompt ?? ""}`);
      return made;
    },
  }) satisfies StartCalls;

const start = (made: Promise<Made>, asked: Array<string> = []) => ({
  draftId: "starting-k1",
  userId: "ada",
  project: { id: "p-1", name: "pstack" },
  ...composerStart(callsWith(made, asked), "p-1", { _tag: "new" }, spec),
});

/** Where the start's composer writes, read at the moment of writing, as it does. */
const onStartPage = () => ({ userId: "ada", sessionId: writingAddressOf("starting-hand") });

describe("an instant start", () => {
  it("shows before Mend answers, then settles on the session it made once its page is read", async () => {
    const made = deferred();
    const asked: Array<string> = [];
    const { place, log } = placeOf();
    const started = startInstantly(place, start(made.promise, asked));
    // Pressed Start: the start's page is open already, and one request has gone to Mend, carrying
    // the first message, under the start's key (SLNT-1239): Mend makes and launches the session.
    expect(log).toEqual(["show starting-k1"]);
    expect(asked).toEqual(["k1: Tell me about this repo"]);
    made.resolve({ id: SessionId.make("s-real") });
    await started;
    expect(asked).toHaveLength(1);
    // Mend records the first message as the launch is admitted (SLNT-1237): nothing holds it here,
    // and the page is read until the conversation has it.
    expect(log).toEqual([
      "show starting-k1",
      "moved",
      "read s-real until it holds the first message",
      "settle s-real",
    ]);
  });

  it("sends what was written before Mend answered to the session it made, once it exists", async () => {
    const made = deferred();
    const { place, log, sent } = placeOf();
    const started = startInstantly(place, start(made.promise));
    holdForStart({ userId: "ada", sessionId: "starting-k1" }, "And the tests.", "k-1");
    made.resolve({ id: SessionId.make("s-real") });
    await started;
    // After the start, whose launch records the first message: Mend keeps this one behind it.
    expect(log.slice(0, 2)).toEqual(["show starting-k1", "send 1 to s-real"]);
    expect(sent.map(({ written }) => written.map((m) => m.text))).toEqual([["And the tests."]]);
    expect(readOutbox({ userId: "ada", sessionId: "s-real" }).map((m) => m.text)).toEqual([
      "And the tests.",
    ]);
    expect(readOutbox({ userId: "ada", sessionId: "starting-k1" })).toEqual([]);
  });

  it("gives the session what is written on the start's page after Mend answered (SLNT-1232)", async () => {
    // The session's page is read slowly, so the start's page stays on screen meanwhile.
    const reading = gate();
    const { place, log } = placeOf();
    const started = startInstantly(
      { ...place, prefetch: () => reading.promise },
      {
        ...start(Promise.resolve({ id: SessionId.make("s-hand") })),
        draftId: "starting-hand",
      },
    );
    // Mend has answered and the agent is launching: the session's page is being read now.
    await vi.waitFor(() => expect(log).toContain("moved"));
    // The start's composer writes, and sends, to the session from here (SLNT-1237).
    expect(onStartPage().sessionId).toBe("s-hand");
    writeDrafts([[draftItems(onStartPage()).text, "Half a thought"]]);
    reading.open();
    await started;
    // Settled, but the start's page may still be drawn until the session's page replaces it.
    expect(onStartPage().sessionId).toBe("s-hand");
    const session = { userId: "ada", sessionId: "s-hand" };
    expect(readDraft(draftItems(session).text)).toBe("Half a thought");
    expect(readOutbox({ userId: "ada", sessionId: "starting-hand" })).toEqual([]);
  });

  it("holds no first message for a start that has none (a menu's)", async () => {
    const { place, log } = placeOf();
    await startInstantly(place, {
      ...start(Promise.resolve({ id: SessionId.make("s-real") })),
      prompt: "",
    });
    expect(log).toEqual(["show starting-k1", "moved", "read s-real", "settle s-real"]);
  });

  it("refused, gives back every word written with Mend's reason", async () => {
    const made = deferred();
    const { place, log, refusals } = placeOf();
    const started = startInstantly(place, start(made.promise));
    const draft = { userId: "ada", sessionId: "starting-k1" };
    holdForStart(draft, "And the tests.", "k-1");
    writeDrafts([[draftItems(draft).text, "Half a thought"]]);
    made.reject(new Error("The project is being removed."));
    await started;
    expect(log).toEqual(["show starting-k1", "refused"]);
    expect(refusals).toEqual([
      {
        draftId: "starting-k1",
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

/** Mend's answers to a reloaded start's reads, in turn, on a clock that moves only as it waits. */
const readsOf = (answers: ReadonlyArray<Omit<SessionStartReadDto, "key">>) => {
  const keys: Array<string> = [];
  let clock = 0;
  let turn = 0;
  return {
    keys,
    reads: {
      read: (key: string) => {
        keys.push(key);
        const answer = answers[Math.min(turn, answers.length - 1)];
        turn += 1;
        return answer === undefined
          ? Promise.reject(new Error("no answer"))
          : Promise.resolve({ key, ...answer });
      },
      wait: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    },
  };
};

const unknown = { state: "unknown", sessionId: null, failure: null } as const;
const making = { state: "making", sessionId: null, failure: null } as const;

/** A start the tab kept before a reload, made into `sessionId` if Mend had answered. */
const kept = (sessionId: string | null): PendingStart => ({
  draftId: "starting-k9",
  userId: "ada",
  project: { id: "p-1", name: "pstack" },
  harness: "codex",
  prompt: "Tell me about this repo",
  selection: null,
  sentAt: new Date("2026-11-21T07:00:00Z"),
  sessionId,
});

describe("a start picked up after a reload (SLNT-1239)", () => {
  it("is kept in the tab, so a reloaded page has it", () => {
    const { draftId, userId, project, harness, prompt, selection, sentAt } = kept(null);
    beginStart({ draftId, userId, project, harness, prompt, selection, sentAt });
    expect(storedStartIn(sessionStorage.getItem("mend-pending-starts"), "starting-k9")).toEqual(
      kept(null),
    );
    expect(storedStartIn(sessionStorage.getItem("mend-pending-starts"), "starting-x")).toBeNull();
    expect(storedStartIn("not json", "starting-k9")).toBeNull();
  });

  it("asks Mend by its key until the session is made, then settles on it with what was written", async () => {
    const { place, log, sent } = placeOf();
    holdForStart({ userId: "ada", sessionId: "starting-k9" }, "And the tests.", "k-2");
    const { keys, reads } = readsOf([
      unknown,
      making,
      { state: "made", sessionId: SessionId.make("s-kept"), failure: null },
    ]);
    await recoverStart(place, kept(null), reads);
    expect(keys).toEqual(["k9", "k9", "k9"]);
    expect(log).toEqual([
      "send 1 to s-kept",
      "moved",
      "read s-kept until it holds the first message",
      "settle s-kept",
    ]);
    expect(sent.map(({ written }) => written.map((m) => m.text))).toEqual([["And the tests."]]);
  });

  it("settles at once on a session Mend had already answered with", async () => {
    const { place, log } = placeOf();
    const { keys, reads } = readsOf([]);
    await recoverStart(place, kept("s-answered"), reads);
    expect(keys).toEqual([]);
    expect(log.at(-1)).toBe("settle s-answered");
  });

  it("gives the words back with Mend's reason when Mend refused it", async () => {
    const { place, refusals } = placeOf();
    const { reads } = readsOf([
      { state: "failed", sessionId: null, failure: "The project is being removed." },
    ]);
    await recoverStart(place, kept(null), reads);
    expect(refusals).toEqual([
      {
        draftId: "starting-k9",
        prompt: "Tell me about this repo",
        words: "The session didn't start. The project is being removed.",
      },
    ]);
  });

  it("gives the words back when Mend never got it", async () => {
    const { place, refusals } = placeOf();
    const { keys, reads } = readsOf([unknown]);
    await recoverStart(place, kept(null), reads);
    expect(refusals.map((refused) => refused.words)).toEqual([START_NEVER_ARRIVED]);
    // It asked for as long as a slow request could still reach Mend, and no longer.
    expect(keys.length).toBeGreaterThan(RECOVERY_UNKNOWN_MS / 1000);
  });

  it("waits past that while Mend says it is making the session", async () => {
    const { place, log, refusals } = placeOf();
    const answers = [
      ...Array.from({ length: (RECOVERY_UNKNOWN_MS / 500) * 2 }, () => making),
      { state: "made", sessionId: SessionId.make("s-slow"), failure: null } as const,
    ];
    await recoverStart(place, kept(null), readsOf(answers).reads);
    expect(refusals).toEqual([]);
    expect(log.at(-1)).toBe("settle s-slow");
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
    draftId: "starting-k1",
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
    expect(row?.session.id).toBe("starting-k1");
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
