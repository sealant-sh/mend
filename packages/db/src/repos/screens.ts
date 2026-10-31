import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AgentTurnId,
  ScreenId,
  type ScreenFrameId,
  type SealantWorkspaceId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  type FrameDigest,
  Screen,
  type ScreenActParams,
  ScreenActor,
  type ScreenCallOutcome,
  SCREEN_INPUT_INITIAL,
  ScreenInput,
  type ScreenInputEvent,
  type ScreenInputTransition,
  ScreenLife,
  ScreenLogBody,
  ScreenLogEntry,
  transitionInput,
  withoutTypedText,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { type MendDatabase, MendDB } from "../client.ts";
import {
  agentSessions,
  checkpoints,
  screenCalls,
  screenLog,
  screens,
} from "../schema/workbench.ts";
import { notifyAgentConversation } from "./agent-conversation.ts";
import { sessionInListedProject } from "./projects.ts";
import { ensureScreenEpisode } from "./screen-episodes.ts";
import { isForeignKeyViolation } from "./unique-violation.ts";

export class ScreenNotFoundError extends Schema.TaggedError<ScreenNotFoundError>()(
  "ScreenNotFoundError",
  { screenId: Schema.String },
) {}

export class ScreenDisplaysFullError extends Schema.TaggedError<ScreenDisplaysFullError>()(
  "ScreenDisplaysFullError",
  { workspaceId: Schema.String },
) {}

type Ended = Extract<ScreenLife, { readonly _tag: "Ended" }>;

export type ScreenLifeChange =
  | {
      readonly life: Extract<ScreenLife, { readonly _tag: "Starting" | "Live" }>;
      readonly processId: SessionProcessId;
    }
  | { readonly life: Ended };

export interface ScreenFrameRef {
  readonly id: ScreenFrameId;
  readonly digest: FrameDigest;
}

/** A person's or Mend's entry. An agent's entry is written only as its call settles. */
export interface NewScreenLogEntry {
  readonly screenId: ScreenId;
  readonly actor: Extract<ScreenActor, { readonly _tag: "Person" | "Mend" }>;
  readonly body: ScreenLogBody;
  readonly frame: ScreenFrameRef | null;
}

export interface ScreenAgentAnswer {
  readonly processId: SessionProcessId;
  readonly turnId: AgentTurnId | null;
  readonly body: Extract<ScreenLogBody, { readonly _tag: "Looked" | "Acted" }>;
  readonly frame: ScreenFrameRef | null;
}

export type ScreenCallArguments =
  | { readonly tool: "screen_look" }
  | { readonly tool: "screen_act"; readonly params: ScreenActParams };

export interface SettledScreenCall {
  readonly outcome: ScreenCallOutcome;
  readonly seq: number | null;
}

export type ScreenCallClaim =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Open" }
  | { readonly _tag: "Settled"; readonly call: SettledScreenCall }
  | { readonly _tag: "CallReused" };

const CLAIMED: ScreenCallClaim = { _tag: "Claimed" };
const OPEN: ScreenCallClaim = { _tag: "Open" };
const CALL_REUSED: ScreenCallClaim = { _tag: "CallReused" };

const claimOf = (
  first: { readonly argsSha256: string; readonly settled: SettledScreenCall | null },
  argsSha256: string,
): ScreenCallClaim => {
  if (first.argsSha256 !== argsSha256) return CALL_REUSED;
  return first.settled === null ? OPEN : { _tag: "Settled", call: first.settled };
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const fields = Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`);
  return `{${fields.join(",")}}`;
};

/** SHA-256 of the call's canonical arguments, each `type` text replaced by its length. */
export const screenCallDigest = (call: ScreenCallArguments): string =>
  createHash("sha256")
    .update(
      canonicalJson(
        call.tool === "screen_act"
          ? { tool: call.tool, actions: call.params.actions.map(withoutTypedText) }
          : { tool: call.tool },
      ),
      "utf8",
    )
    .digest("hex");

export class ScreensRepo extends Context.Service<
  ScreensRepo,
  {
    /**
     * The session's screen in this workspace, reserving a display on its first launch there. The
     * session keeps its display number in a later workspace when that number is free there.
     */
    readonly reserve: (at: {
      readonly sessionId: SessionId;
      readonly workspaceId: SealantWorkspaceId;
    }) => Effect.Effect<Screen, ScreenDisplaysFullError>;
    readonly byId: (id: ScreenId) => Effect.Effect<Screen | null>;
    /** The screen holding the session's display, or null once it is released. */
    readonly ofSession: (sessionId: SessionId) => Effect.Effect<Screen | null>;
    readonly setLife: (
      id: ScreenId,
      change: ScreenLifeChange,
    ) => Effect.Effect<Screen, ScreenNotFoundError>;
    /**
     * The session ended: the reservation `id` gives its display back, if it still holds it. Only
     * that reservation: one the session takes after it is a new row, and keeps its display. Once
     * is enough.
     */
    readonly release: (id: ScreenId) => Effect.Effect<void>;
    /** Every screen still holding a display, oldest first. */
    readonly listHeld: () => Effect.Effect<ReadonlyArray<Screen>>;
    /**
     * The screen's last activity (ADR 0020, D7): its latest log entry, change of holder or change
     * of life; null for no such screen. What a viewer does is none of these.
     */
    readonly lastActivityAt: (id: ScreenId) => Effect.Effect<Date | null>;
    /** Every screen holding a display, whatever its life. */
    readonly held: () => Effect.Effect<ReadonlyArray<Screen>>;
    /**
     * Applies `transitionInput` under the screen's lock and stores what it decided; an entry the
     * transition logs carries `frame`.
     */
    readonly control: (
      id: ScreenId,
      event: ScreenInputEvent,
      owner: string | null,
      frame?: ScreenFrameRef | null,
    ) => Effect.Effect<ScreenInputTransition, ScreenNotFoundError>;
    readonly append: (
      entry: NewScreenLogEntry,
    ) => Effect.Effect<ScreenLogEntry, ScreenNotFoundError>;
    readonly log: (id: ScreenId) => Effect.Effect<ReadonlyArray<ScreenLogEntry>>;
    /** When the screen's latest entry of one of `bodies` was written; null for none. */
    readonly lastLoggedAt: (
      id: ScreenId,
      bodies: ReadonlyArray<ScreenLogBody["_tag"]>,
    ) => Effect.Effect<Date | null>;
    /**
     * Claims a tool call before any input. A retry with the same key and arguments answers what
     * the first did; the same key with other arguments answers `CallReused`.
     */
    readonly claim: (call: {
      readonly screenId: ScreenId;
      readonly callKey: string;
      readonly args: ScreenCallArguments;
    }) => Effect.Effect<ScreenCallClaim, ScreenNotFoundError>;
    /** Records a claimed call's outcome and its agent's entry, once; a repeat answers the first. */
    readonly settle: (call: {
      readonly screenId: ScreenId;
      readonly callKey: string;
      readonly outcome: ScreenCallOutcome;
      readonly answer: ScreenAgentAnswer | null;
    }) => Effect.Effect<SettledScreenCall>;
    /** Mend booted: no open call can still finish, so each reads `outcome_unknown`. */
    readonly boot: () => Effect.Effect<number>;
  }
>()("@mend/db/ScreensRepo") {}

const DISPLAYS = { first: 10, last: 99 } as const;
const RESERVE_ATTEMPTS = DISPLAYS.last - DISPLAYS.first + 2;

const decodeScreen = Schema.decodeSync(Screen);
const decodeEntry = Schema.decodeSync(ScreenLogEntry);
const encodeActor = Schema.encodeSync(ScreenActor);
const encodeBody = Schema.encodeSync(ScreenLogBody);
const encodeLife = Schema.encodeSync(ScreenLife);
const encodeInput = Schema.encodeSync(ScreenInput);

const ENDED_BY_SESSION: Ended = { _tag: "Ended", reason: "session-stopped" };
const ENDED_BY_WORKSPACE: Ended = { _tag: "Ended", reason: "workspace-ended" };

const endedLife = (life: ScreenLife, ended: Ended): ScreenLife =>
  life._tag === "Ended" ? life : ended;

const freeDisplay = (held: ReadonlySet<number>, preferred: number | null): number | null => {
  if (preferred !== null && !held.has(preferred)) return preferred;
  for (let display = DISPLAYS.first; display <= DISPLAYS.last; display++) {
    if (!held.has(display)) return display;
  }
  return null;
};

type Row = typeof screens.$inferSelect;
interface Written {
  readonly actor: ScreenActor;
  readonly body: ScreenLogBody;
  readonly frame: ScreenFrameRef | null;
}
type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "execute">;

const toScreen = (row: Row): Screen => decodeScreen(row);

const toEntry = (row: typeof screenLog.$inferSelect): ScreenLogEntry =>
  decodeEntry({
    ...row,
    frame:
      row.frameId === null || row.frameDigest === null || row.frameState === null
        ? null
        : { id: row.frameId, digest: row.frameDigest, state: row.frameState },
    checkpoint:
      row.checkpointId === null ? null : { _tag: "ObservedAfter", checkpointId: row.checkpointId },
  });

const agentActor = (callKey: string, answer: ScreenAgentAnswer): ScreenActor => ({
  _tag: "Agent",
  processId: answer.processId,
  turnId: answer.turnId,
  callKey,
  toolCall: { _tag: "Pending" },
});

const settledOf = (row: {
  readonly outcome: ScreenCallOutcome | null;
  readonly logSeq: number | null;
}): SettledScreenCall | null =>
  row.outcome === null ? null : { outcome: row.outcome, seq: row.logSeq };

const heldRow = (tx: Tx, sessionId: SessionId) =>
  tx
    .select()
    .from(screens)
    .where(and(eq(screens.sessionId, sessionId), isNull(screens.releasedAt)))
    .for("update")
    .pipe(Effect.map((rows) => rows[0] ?? null));

const releaseRow = Effect.fn("ScreensRepo.releaseRow")(function* (tx: Tx, row: Row, ended: Ended) {
  const now = yield* DateTime.nowAsDate;
  yield* tx
    .update(screens)
    .set({
      releasedAt: now,
      updatedAt: now,
      processId: null,
      life: encodeLife(endedLife(toScreen(row).life, ended)),
    })
    .where(eq(screens.id, row.id));
});

const appendIn = Effect.fn("ScreensRepo.appendIn")(function* (
  tx: Tx,
  screenId: ScreenId,
  written: Written,
) {
  const [counter] = yield* tx
    .update(screens)
    .set({ lastSeq: sql`${screens.lastSeq} + 1` })
    .where(eq(screens.id, screenId))
    .returning({ seq: screens.lastSeq, sessionId: screens.sessionId });
  if (counter === undefined) return null;
  const [checkpoint] = yield* tx
    .select({ id: checkpoints.id })
    .from(checkpoints)
    .innerJoin(agentSessions, eq(agentSessions.worktreeId, checkpoints.worktreeId))
    .where(eq(agentSessions.id, counter.sessionId))
    .orderBy(desc(checkpoints.ordinal))
    .limit(1);
  const [row] = yield* tx
    .insert(screenLog)
    .values({
      screenId,
      seq: counter.seq,
      at: yield* DateTime.nowAsDate,
      actor: encodeActor(written.actor),
      body: encodeBody(written.body),
      frameId: written.frame?.id ?? null,
      frameDigest: written.frame?.digest ?? null,
      frameState: written.frame === null ? null : "stored",
      checkpointId: checkpoint?.id ?? null,
    })
    .returning();
  return row === undefined ? null : { entry: toEntry(row), sessionId: counter.sessionId };
});

type Database = MendDB | PgClient.PgClient;

export const ScreensRepoLive: Layer.Layer<ScreensRepo, never, Database> = Layer.effect(
  ScreensRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const reserve = Effect.fn("ScreensRepo.reserve")(function* (at: {
      readonly sessionId: SessionId;
      readonly workspaceId: SealantWorkspaceId;
    }) {
      const reserved = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [latest] = yield* tx
              .select({ display: screens.display })
              .from(screens)
              .where(eq(screens.sessionId, at.sessionId))
              .orderBy(desc(screens.createdAt))
              .limit(1);
            for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
              const held = yield* heldRow(tx, at.sessionId);
              if (held?.workspaceId === at.workspaceId) return held;
              if (held !== null) yield* releaseRow(tx, held, ENDED_BY_WORKSPACE);
              const taken = yield* tx
                .select({ display: screens.display })
                .from(screens)
                .where(and(eq(screens.workspaceId, at.workspaceId), isNull(screens.releasedAt)));
              const display = freeDisplay(
                new Set(taken.map((row) => row.display)),
                latest?.display ?? null,
              );
              if (display === null) return null;
              const [inserted] = yield* tx
                .insert(screens)
                .values({
                  id: ScreenId.make(crypto.randomUUID()),
                  sessionId: at.sessionId,
                  workspaceId: at.workspaceId,
                  display,
                  life: encodeLife({ _tag: "NotStarted" }),
                  input: encodeInput(SCREEN_INPUT_INITIAL),
                })
                .onConflictDoNothing()
                .returning();
              if (inserted !== undefined) return inserted;
            }
            return null;
          }),
        )
        .pipe(Effect.orDie);
      if (reserved === null) {
        return yield* new ScreenDisplaysFullError({ workspaceId: at.workspaceId });
      }
      return toScreen(reserved);
    });

    const byId = Effect.fn("ScreensRepo.byId")(function* (id: ScreenId) {
      const [row] = yield* db
        .select()
        .from(screens)
        .where(eq(screens.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toScreen(row);
    });

    const ofSession = Effect.fn("ScreensRepo.ofSession")(function* (sessionId: SessionId) {
      const [row] = yield* db
        .select()
        .from(screens)
        .where(and(eq(screens.sessionId, sessionId), isNull(screens.releasedAt)))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toScreen(row);
    });

    const setLife = Effect.fn("ScreensRepo.setLife")(function* (
      id: ScreenId,
      change: ScreenLifeChange,
    ) {
      const [row] = yield* db
        .update(screens)
        .set({
          life: encodeLife(change.life),
          processId: "processId" in change ? change.processId : null,
          updatedAt: yield* DateTime.nowAsDate,
        })
        .where(eq(screens.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ScreenNotFoundError({ screenId: id });
      return toScreen(row);
    });

    const release = Effect.fn("ScreensRepo.release")(function* (id: ScreenId) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [held] = yield* tx
              .select()
              .from(screens)
              .where(and(eq(screens.id, id), isNull(screens.releasedAt)))
              .for("update");
            if (held !== undefined) yield* releaseRow(tx, held, ENDED_BY_SESSION);
          }),
        )
        .pipe(Effect.orDie);
    });

    const listHeld = Effect.fn("ScreensRepo.listHeld")(function* () {
      const rows = yield* db
        .select()
        .from(screens)
        .where(and(isNull(screens.releasedAt), sessionInListedProject(db, screens.sessionId)))
        .orderBy(asc(screens.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toScreen);
    });

    const lastActivityAt = Effect.fn("ScreensRepo.lastActivityAt")(function* (id: ScreenId) {
      const latestEntry = db
        .select({ at: sql`max(${screenLog.at})` })
        .from(screenLog)
        .where(eq(screenLog.screenId, id));
      const [row] = yield* db
        .select({
          at: sql<Date>`greatest(${screens.updatedAt}, (${latestEntry}))`.mapWith(
            screens.updatedAt,
          ),
        })
        .from(screens)
        .where(eq(screens.id, id))
        .pipe(Effect.orDie);
      return row?.at ?? null;
    });

    const held = Effect.fn("ScreensRepo.held")(function* () {
      const rows = yield* db
        .select()
        .from(screens)
        .where(isNull(screens.releasedAt))
        .pipe(Effect.orDie);
      return rows.map(toScreen);
    });

    const control = Effect.fn("ScreensRepo.control")(function* (
      id: ScreenId,
      event: ScreenInputEvent,
      owner: string | null,
      frame: ScreenFrameRef | null = null,
    ) {
      const decided = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .select({ input: screens.input })
              .from(screens)
              .where(eq(screens.id, id))
              .for("update");
            if (row === undefined) return null;
            const transition = transitionInput(
              Schema.decodeSync(ScreenInput)(row.input),
              event,
              owner,
            );
            if (transition._tag === "Changed") {
              yield* tx
                .update(screens)
                .set({
                  input: encodeInput(transition.next),
                  updatedAt: yield* DateTime.nowAsDate,
                })
                .where(eq(screens.id, id));
              if (transition.log !== null) yield* appendIn(tx, id, { ...transition.log, frame });
            }
            return transition;
          }),
        )
        .pipe(Effect.orDie);
      if (decided === null) return yield* new ScreenNotFoundError({ screenId: id });
      return decided;
    });

    const append = Effect.fn("ScreensRepo.append")(function* ({
      screenId,
      ...written
    }: NewScreenLogEntry) {
      const appended = yield* db
        .transaction((tx) => appendIn(tx, screenId, written))
        .pipe(Effect.orDie);
      if (appended === null) return yield* new ScreenNotFoundError({ screenId });
      return appended.entry;
    });

    const log = Effect.fn("ScreensRepo.log")(function* (id: ScreenId) {
      const rows = yield* db
        .select()
        .from(screenLog)
        .where(eq(screenLog.screenId, id))
        .orderBy(asc(screenLog.seq))
        .pipe(Effect.orDie);
      return rows.map(toEntry);
    });

    const lastLoggedAt = Effect.fn("ScreensRepo.lastLoggedAt")(function* (
      id: ScreenId,
      bodies: ReadonlyArray<ScreenLogBody["_tag"]>,
    ) {
      if (bodies.length === 0) return null;
      const [row] = yield* db
        .select({ at: screenLog.at })
        .from(screenLog)
        .where(
          and(
            eq(screenLog.screenId, id),
            inArray(sql<string>`${screenLog.body}->>'_tag'`, [...bodies]),
          ),
        )
        .orderBy(desc(screenLog.seq))
        .limit(1)
        .pipe(Effect.orDie);
      return row?.at ?? null;
    });

    const claim = Effect.fn("ScreensRepo.claim")(function* (call: {
      readonly screenId: ScreenId;
      readonly callKey: string;
      readonly args: ScreenCallArguments;
    }) {
      const argsSha256 = screenCallDigest(call.args);
      const [inserted] = yield* db
        .insert(screenCalls)
        .values({ screenId: call.screenId, callKey: call.callKey, argsSha256 })
        .onConflictDoNothing()
        .returning({ callKey: screenCalls.callKey })
        .pipe(
          Effect.catch((cause) =>
            isForeignKeyViolation(cause)
              ? Effect.fail(new ScreenNotFoundError({ screenId: call.screenId }))
              : Effect.die(cause),
          ),
        );
      if (inserted !== undefined) return CLAIMED;
      const [first] = yield* db
        .select()
        .from(screenCalls)
        .where(and(eq(screenCalls.screenId, call.screenId), eq(screenCalls.callKey, call.callKey)))
        .pipe(Effect.orDie);
      if (first === undefined)
        return yield* Effect.die("screen call conflict without a stored row");
      return claimOf({ argsSha256: first.argsSha256, settled: settledOf(first) }, argsSha256);
    });

    const settle = Effect.fn("ScreensRepo.settle")(function* (call: {
      readonly screenId: ScreenId;
      readonly callKey: string;
      readonly outcome: ScreenCallOutcome;
      readonly answer: ScreenAgentAnswer | null;
    }) {
      const settled = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const where = and(
              eq(screenCalls.screenId, call.screenId),
              eq(screenCalls.callKey, call.callKey),
            );
            const [claimed] = yield* tx.select().from(screenCalls).where(where).for("update");
            if (claimed === undefined)
              return yield* Effect.die("settled a screen call never claimed");
            const before = settledOf(claimed);
            if (before !== null) return { call: before, episodeOf: null };
            const { answer } = call;
            const appended =
              answer === null
                ? null
                : yield* appendIn(tx, call.screenId, {
                    actor: agentActor(call.callKey, answer),
                    body: answer.body,
                    frame: answer.frame,
                  });
            const seq = appended?.entry.seq ?? null;
            yield* tx
              .update(screenCalls)
              .set({ outcome: call.outcome, logSeq: seq, settledAt: yield* DateTime.nowAsDate })
              .where(where);
            const episode =
              appended !== null &&
              (yield* ensureScreenEpisode(tx, appended.sessionId, appended.entry));
            return {
              call: { outcome: call.outcome, seq },
              episodeOf: episode ? appended.sessionId : null,
            };
          }),
        )
        .pipe(Effect.orDie);
      if (settled.episodeOf !== null) {
        yield* notifyAgentConversation(db, pg, settled.episodeOf);
      }
      return settled.call;
    });

    const boot = Effect.fn("ScreensRepo.boot")(function* () {
      const settled = yield* db
        .update(screenCalls)
        .set({ outcome: "outcome_unknown", settledAt: yield* DateTime.nowAsDate })
        .where(isNull(screenCalls.outcome))
        .returning({ callKey: screenCalls.callKey })
        .pipe(Effect.orDie);
      return settled.length;
    });

    return {
      reserve,
      byId,
      ofSession,
      setLife,
      release,
      listHeld,
      lastActivityAt,
      held,
      control,
      append,
      log,
      lastLoggedAt,
      claim,
      settle,
      boot,
    };
  }),
);

interface MemoryRow {
  screen: Screen;
  released: boolean;
  activeAt: Date;
  log: Array<ScreenLogEntry>;
  calls: Map<string, { argsSha256: string; settled: SettledScreenCall | null }>;
}

const appendTo = (row: MemoryRow, written: Written) => {
  const entry = decodeEntry({
    screenId: row.screen.id,
    seq: row.log.length + 1,
    at: new Date(),
    actor: written.actor,
    body: written.body,
    frame: written.frame === null ? null : { ...written.frame, state: "stored" },
    checkpoint: null,
  });
  row.log.push(entry);
  row.activeAt = entry.at;
  return entry;
};

/** For service and route tests: the same rules, with no record items and no checkpoints. */
export const makeScreensMemory = (): ScreensRepo["Service"] => {
  const rows: Array<MemoryRow> = [];
  const held = (sessionId: SessionId) =>
    rows.find((row) => row.screen.sessionId === sessionId && !row.released) ?? null;
  const rowOf = (id: ScreenId) => rows.find((row) => row.screen.id === id) ?? null;
  const release = (row: MemoryRow, ended: Ended) => {
    row.released = true;
    row.screen = { ...row.screen, processId: null, life: endedLife(row.screen.life, ended) };
  };
  return {
    reserve: (at) =>
      Effect.suspend(() => {
        const current = held(at.sessionId);
        if (current?.screen.workspaceId === at.workspaceId) return Effect.succeed(current.screen);
        if (current !== null) release(current, ENDED_BY_WORKSPACE);
        const latest = rows.findLast((row) => row.screen.sessionId === at.sessionId);
        const display = freeDisplay(
          new Set(
            rows
              .filter((row) => row.screen.workspaceId === at.workspaceId && !row.released)
              .map((row) => row.screen.display),
          ),
          latest?.screen.display ?? null,
        );
        if (display === null) {
          return Effect.fail(new ScreenDisplaysFullError({ workspaceId: at.workspaceId }));
        }
        const screen = decodeScreen({
          id: crypto.randomUUID(),
          sessionId: at.sessionId,
          workspaceId: at.workspaceId,
          display,
          processId: null,
          life: { _tag: "NotStarted" },
          input: encodeInput(SCREEN_INPUT_INITIAL),
        });
        rows.push({ screen, released: false, activeAt: new Date(), log: [], calls: new Map() });
        return Effect.succeed(screen);
      }),
    byId: (id) => Effect.sync(() => rowOf(id)?.screen ?? null),
    ofSession: (sessionId) => Effect.sync(() => held(sessionId)?.screen ?? null),
    setLife: (id, change) =>
      Effect.suspend(() => {
        const row = rowOf(id);
        if (row === null) return Effect.fail(new ScreenNotFoundError({ screenId: id }));
        row.screen = {
          ...row.screen,
          life: change.life,
          processId: "processId" in change ? change.processId : null,
        };
        row.activeAt = new Date();
        return Effect.succeed(row.screen);
      }),
    release: (id) =>
      Effect.sync(() => {
        const row = rowOf(id);
        if (row !== null && !row.released) release(row, ENDED_BY_SESSION);
      }),
    listHeld: () => Effect.sync(() => rows.filter((row) => !row.released).map((row) => row.screen)),
    lastActivityAt: (id) => Effect.sync(() => rowOf(id)?.activeAt ?? null),
    held: () => Effect.sync(() => rows.filter((row) => !row.released).map((row) => row.screen)),
    control: (id, event, owner, frame = null) =>
      Effect.suspend(() => {
        const row = rowOf(id);
        if (row === null) return Effect.fail(new ScreenNotFoundError({ screenId: id }));
        const transition = transitionInput(row.screen.input, event, owner);
        if (transition._tag === "Changed") {
          row.screen = { ...row.screen, input: transition.next };
          row.activeAt = new Date();
          if (transition.log !== null) appendTo(row, { ...transition.log, frame });
        }
        return Effect.succeed(transition);
      }),
    append: ({ screenId, ...written }) =>
      Effect.suspend(() => {
        const row = rowOf(screenId);
        if (row === null) return Effect.fail(new ScreenNotFoundError({ screenId }));
        return Effect.succeed(appendTo(row, written));
      }),
    log: (id) => Effect.sync(() => [...(rowOf(id)?.log ?? [])]),
    lastLoggedAt: (id, bodies) =>
      Effect.sync(
        () => rowOf(id)?.log.findLast((entry) => bodies.includes(entry.body._tag))?.at ?? null,
      ),
    claim: (call) =>
      Effect.suspend(() => {
        const row = rowOf(call.screenId);
        if (row === null) return Effect.fail(new ScreenNotFoundError({ screenId: call.screenId }));
        const argsSha256 = screenCallDigest(call.args);
        const first = row.calls.get(call.callKey);
        if (first !== undefined) return Effect.succeed(claimOf(first, argsSha256));
        row.calls.set(call.callKey, { argsSha256, settled: null });
        return Effect.succeed(CLAIMED);
      }),
    settle: (call) =>
      Effect.suspend(() => {
        const row = rowOf(call.screenId);
        const claimed = row?.calls.get(call.callKey);
        if (row === null || claimed === undefined) {
          return Effect.die("settled a screen call never claimed");
        }
        if (claimed.settled !== null) return Effect.succeed(claimed.settled);
        const entry =
          call.answer === null
            ? null
            : appendTo(row, {
                actor: agentActor(call.callKey, call.answer),
                body: call.answer.body,
                frame: call.answer.frame,
              });
        claimed.settled = { outcome: call.outcome, seq: entry?.seq ?? null };
        return Effect.succeed(claimed.settled);
      }),
    boot: () =>
      Effect.sync(() => {
        let settled = 0;
        for (const row of rows) {
          for (const call of row.calls.values()) {
            if (call.settled !== null) continue;
            call.settled = { outcome: "outcome_unknown", seq: null };
            settled++;
          }
        }
        return settled;
      }),
  };
};

export const ScreensRepoMemory: Layer.Layer<ScreensRepo> = Layer.sync(
  ScreensRepo,
  makeScreensMemory,
);
