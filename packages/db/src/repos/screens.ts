import {
  ScreenId,
  type SealantWorkspaceId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  Screen,
  SCREEN_INPUT_INITIAL,
  ScreenInput,
  type ScreenInputEvent,
  type ScreenInputTransition,
  ScreenLife,
  transitionInput,
} from "@mend/domain/workbench";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { type MendDatabase, MendDB } from "../client.ts";
import { screens } from "../schema/workbench.ts";

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
    /** The session ended: its display goes back to the workspace. */
    readonly release: (sessionId: SessionId) => Effect.Effect<void>;
    /** Applies `transitionInput` under the screen's lock and stores what it decided. */
    readonly control: (
      id: ScreenId,
      event: ScreenInputEvent,
      owner: string | null,
    ) => Effect.Effect<ScreenInputTransition, ScreenNotFoundError>;
  }
>()("@mend/db/ScreensRepo") {}

const DISPLAYS = { first: 10, last: 99 } as const;
const RESERVE_ATTEMPTS = DISPLAYS.last - DISPLAYS.first + 2;

const decodeScreen = Schema.decodeSync(Screen);
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
type Tx = Pick<MendDatabase, "select" | "insert" | "update">;

const toScreen = (row: Row): Screen => decodeScreen(row);

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

export const ScreensRepoLive: Layer.Layer<ScreensRepo, never, MendDB> = Layer.effect(
  ScreensRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

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

    const release = Effect.fn("ScreensRepo.release")(function* (sessionId: SessionId) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const held = yield* heldRow(tx, sessionId);
            if (held !== null) yield* releaseRow(tx, held, ENDED_BY_SESSION);
          }),
        )
        .pipe(Effect.orDie);
    });

    const control = Effect.fn("ScreensRepo.control")(function* (
      id: ScreenId,
      event: ScreenInputEvent,
      owner: string | null,
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
                .set({ input: encodeInput(transition.next), updatedAt: yield* DateTime.nowAsDate })
                .where(eq(screens.id, id));
            }
            return transition;
          }),
        )
        .pipe(Effect.orDie);
      if (decided === null) return yield* new ScreenNotFoundError({ screenId: id });
      return decided;
    });

    return { reserve, byId, ofSession, setLife, release, control };
  }),
);

interface MemoryRow {
  screen: Screen;
  released: boolean;
}

/** For service and route tests: the same rules. */
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
        rows.push({ screen, released: false });
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
        return Effect.succeed(row.screen);
      }),
    release: (sessionId) =>
      Effect.sync(() => {
        const row = held(sessionId);
        if (row !== null) release(row, ENDED_BY_SESSION);
      }),
    control: (id, event, owner) =>
      Effect.suspend(() => {
        const row = rowOf(id);
        if (row === null) return Effect.fail(new ScreenNotFoundError({ screenId: id }));
        const transition = transitionInput(row.screen.input, event, owner);
        if (transition._tag === "Changed") row.screen = { ...row.screen, input: transition.next };
        return Effect.succeed(transition);
      }),
  };
};

export const ScreensRepoMemory: Layer.Layer<ScreensRepo> = Layer.sync(
  ScreensRepo,
  makeScreensMemory,
);
