import { ScreensRepo } from "@mend/db";
import type { ScreenId, SessionId, ViewerConnectionId } from "@mend/domain";
import {
  SCREEN_LIMITS,
  type Screen,
  type ScreenInput,
  type ScreenInputEvent,
  type ScreenInputTransition,
  type ScreenLapse,
  type ScreenLogBody,
  screenHolderConnection,
  transitionInput,
} from "@mend/domain/workbench";
import type { BlobStore } from "@mend/store";
import { Clock, Deferred, Effect, Fiber, Option, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import { storeFrame } from "./frames.ts";
import type { Hands } from "./hands.ts";
import type { Input } from "./rfb-client.ts";
import { ScreenHost } from "./screen-host.ts";

/** `NoHand`: a take over refused, since no hand could put the person's input on the screen. */
export type ScreenControlAnswer =
  | ScreenInputTransition
  | { readonly _tag: "NoScreen" }
  | { readonly _tag: "NoHand" };

const NO_SCREEN: ScreenControlAnswer = { _tag: "NoScreen" };
const NO_HAND: ScreenControlAnswer = { _tag: "NoHand" };
const UNCHANGED: ScreenControlAnswer = { _tag: "Unchanged" };

export type PersonLapse = Exclude<ScreenLapse, "restart">;

/** The timer a state runs against the row: a holder's heartbeat lease, or the `Paused` timeout. */
const timerOf = (
  input: ScreenInput,
  nowMs: number,
): { readonly afterMs: number; readonly event: (at: Date) => ScreenInputEvent } | null => {
  const connection = screenHolderConnection(input);
  if (connection !== null) {
    return {
      afterMs: SCREEN_LIMITS.heartbeatMs,
      event: (at) => ({ _tag: "Lapse", connection, reason: "lease-lapsed", at }),
    };
  }
  if (input._tag !== "Paused") return null;
  return {
    afterMs: Math.max(0, input.since.getTime() + SCREEN_LIMITS.pausedTimeoutMs - nowMs),
    event: (at) => ({ _tag: "PausedTimeout", at }),
  };
};

const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

/** A timer armed for the row at `epoch`; it decides only while it is still the screen's timer. */
interface Armed {
  readonly epoch: number;
  fiber: Fiber.Fiber<void> | null;
}

/** People's input transitions and the timers that stand in for them, over the screen's row. */
export const makeScreenControl = Effect.fnUntraced(function* (hands: Hands) {
  const screens = yield* ScreensRepo;
  const host = yield* ScreenHost;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<BlobStore>();
  const timers = new Map<ScreenId, Armed>();
  const locks = new Map<ScreenId, Semaphore.Semaphore>();
  const booting = new Map<ScreenId, Deferred.Deferred<void>>();
  /** Every change to a screen's row or timer this process makes, one at a time per screen. */
  const lockOf = (screenId: ScreenId) => {
    const lock = locks.get(screenId) ?? Semaphore.makeUnsafe(1);
    locks.set(screenId, lock);
    return lock;
  };
  const serially = <A, E>(screenId: ScreenId, effect: Effect.Effect<A, E>) =>
    lockOf(screenId).withPermit(effect);

  const frameOf = (screen: Screen) =>
    Effect.gen(function* () {
      const hand = yield* hands.of(screen);
      const png = hand === null ? Option.none() : yield* hand.look.pipe(Effect.option);
      if (Option.isSome(png)) return yield* storeFrame(screen.id, png.value);
      yield* Effect.logWarning("screen: no frame · the screen was not observable").pipe(
        Effect.annotateLogs({ screenId: screen.id, life: screen.life._tag }),
      );
      return null;
    }).pipe(Effect.provideContext(context));

  /**
   * Applies `event` under the row's lock, while `still` holds for the row, and answers `unmet`
   * when it does not. A transition that logs stores the frame taken just before it. Releases go
   * ahead of anything queued behind them; a fence is acknowledged once the hand has stopped the
   * batch and released, and one to a person only while that hand is still open.
   */
  const decide = (
    screenId: ScreenId,
    event: ScreenInputEvent,
    owner: string | null,
    still: (screen: Screen) => boolean = () => true,
    unmet: ScreenControlAnswer = UNCHANGED,
  ): Effect.Effect<ScreenControlAnswer> =>
    Effect.gen(function* () {
      const screen = yield* screens.byId(screenId);
      if (screen === null) return NO_SCREEN;
      if (!still(screen)) return unmet;
      const foreseen = transitionInput(screen.input, event, owner);
      const frame =
        foreseen._tag === "Changed" && foreseen.log !== null ? yield* frameOf(screen) : null;
      // The frame took time: what `still` stood for is checked again where nothing can change it.
      const decided = yield* serially(
        screenId,
        Effect.gen(function* () {
          const current = yield* screens.byId(screenId);
          if (current === null) return NO_SCREEN;
          if (!still(current)) return unmet;
          const answer = yield* screens
            .control(screenId, event, owner, frame)
            .pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.succeed(NO_SCREEN)));
          if (answer._tag === "Changed") yield* arm(screenId, answer.next);
          return answer;
        }),
      );
      if (decided._tag !== "Changed") return decided;
      const { next } = decided;
      if (decided.releases || next._tag === "Fencing") {
        yield* Effect.ignore(hands.open(screenId)?.release ?? Effect.void);
      }
      if (next._tag === "Fencing") {
        // A hand that ended meanwhile resets the input itself, and the fence stays unacknowledged.
        const handed = () => next.to._tag === "AwaitingAgent" || hands.open(screenId) !== null;
        yield* decide(screenId, { _tag: "Fenced", epoch: next.epoch }, owner, handed);
      }
      return decided;
    });

  /**
   * Under the screen's lock: replaces its timer with the one `input` runs. A timer decides in a
   * fiber of its own, so replacing it never interrupts a decision, and the decision is made only
   * if no later arm replaced it and the row is still at the epoch it was armed for.
   */
  const arm = (screenId: ScreenId, input: ScreenInput): Effect.Effect<void> =>
    Effect.gen(function* () {
      const before = timers.get(screenId)?.fiber;
      timers.delete(screenId);
      if (before != null) yield* Fiber.interrupt(before);
      const timer = timerOf(input, yield* Clock.currentTimeMillis);
      if (timer === null) return;
      const armed: Armed = { epoch: input.epoch, fiber: null };
      timers.set(screenId, armed);
      const still = (screen: Screen) =>
        timers.get(screenId) === armed && screen.input.epoch === armed.epoch;
      armed.fiber = yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* Effect.sleep(timer.afterMs);
          const event = timer.event(yield* now);
          yield* Effect.forkIn(decide(screenId, event, null, still), scope);
        }),
        scope,
      );
    });

  /** Runs where the caller's interruption cannot strand a fence half done. */
  const detached = <A>(effect: Effect.Effect<A>) =>
    Effect.flatMap(Effect.forkIn(effect, scope), Fiber.join);

  const onSession = <A>(
    sessionId: SessionId,
    use: (screen: Screen) => Effect.Effect<A>,
    otherwise: A,
  ): Effect.Effect<A> =>
    Effect.flatMap(screens.ofSession(sessionId), (screen) =>
      screen === null ? Effect.succeed(otherwise) : use(screen),
    );

  const byOwner = (sessionId: SessionId, event: ScreenInputEvent) =>
    onSession(
      sessionId,
      (screen) =>
        Effect.flatMap(host.ownerOf(sessionId), (owner) =>
          detached(decide(screen.id, event, owner)),
        ),
      NO_SCREEN,
    );

  /** Waits while the screen's boot runs; at once for one that is not booting. */
  const booted = (screenId: ScreenId) =>
    Effect.suspend(() => {
      const done = booting.get(screenId);
      return done === undefined ? Effect.void : Deferred.await(done);
    });

  /**
   * Take over goes ahead only with a hand to put the person's input on the screen, so it never
   * reports Person while that input would be dropped. It waits for the screen's boot first, since
   * the boot is what opens a hand after Mend restarted.
   */
  const take = (sessionId: SessionId, userId: string, connection: ViewerConnectionId) =>
    onSession(
      sessionId,
      (screen) =>
        Effect.gen(function* () {
          yield* booted(screen.id);
          const owner = yield* host.ownerOf(sessionId);
          const event: ScreenInputEvent = { _tag: "Take", by: userId, connection };
          const current = yield* screens.byId(screen.id);
          if (current === null) return NO_SCREEN;
          if (transitionInput(current.input, event, owner)._tag !== "Changed") {
            return yield* detached(decide(screen.id, event, owner));
          }
          if ((yield* hands.of(current)) === null) return NO_HAND;
          const handed = () => hands.open(screen.id) !== null;
          return yield* detached(decide(screen.id, event, owner, handed, NO_HAND));
        }),
      NO_SCREEN,
    );

  return {
    decide,
    serially,
    arm: (screen: Screen, input: ScreenInput) => serially(screen.id, arm(screen.id, input)),
    /**
     * Mend booted: the screen's lock is held from now until `prepare` has run and Boot is stored,
     * with the frame a fresh hand takes, so nothing else changes the row before its boot.
     */
    boot: (screen: Screen, at: Date, prepare: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const lock = lockOf(screen.id);
        yield* lock.take(1);
        const done = yield* Deferred.make<void>();
        booting.set(screen.id, done);
        const boot = Effect.gen(function* () {
          yield* prepare;
          const current = yield* screens.byId(screen.id);
          if (current === null) return;
          const event: ScreenInputEvent = { _tag: "Boot", at };
          const foreseen = transitionInput(current.input, event, null);
          const frame =
            foreseen._tag === "Changed" && foreseen.log !== null ? yield* frameOf(current) : null;
          const decided = yield* screens
            .control(screen.id, event, null, frame)
            .pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.succeed(NO_SCREEN)));
          yield* arm(screen.id, decided._tag === "Changed" ? decided.next : current.input);
          // A fresh hand lets go of whatever the last process's hand left held before anything else.
          yield* hands.of(current);
        });
        const finished = lock
          .release(1)
          .pipe(
            Effect.andThen(Effect.sync(() => booting.delete(screen.id))),
            Effect.andThen(Deferred.succeed(done, undefined)),
          );
        yield* Effect.forkIn(Effect.ensuring(boot, finished), scope);
      }),
    booted,
    /** Mend's own entry in the screen's log, with the frame it shows now if it can be observed. */
    note: (screen: Screen, body: ScreenLogBody) =>
      Effect.flatMap(frameOf(screen), (frame) =>
        screens.append({ screenId: screen.id, actor: { _tag: "Mend" }, body, frame }),
      ).pipe(
        Effect.catchTag("ScreenNotFoundError", () => Effect.void),
        Effect.asVoid,
      ),
    /** A hand ended by itself. One open since then replaced it, and what it was given stands. */
    ended: (screenId: ScreenId) =>
      decide(screenId, { _tag: "Ended" }, null, () => hands.open(screenId) === null),
    take,
    handBack: (sessionId: SessionId, userId: string) =>
      byOwner(sessionId, { _tag: "HandBack", by: userId }),
    lapse: (sessionId: SessionId, connection: ViewerConnectionId, reason: PersonLapse) =>
      onSession(
        sessionId,
        (screen) =>
          Effect.flatMap(now, (at) =>
            detached(decide(screen.id, { _tag: "Lapse", connection, reason, at }, null)),
          ),
        NO_SCREEN,
      ),
    /** Renews the holder's lease; false for a connection that holds nothing. */
    heartbeat: (sessionId: SessionId, connection: ViewerConnectionId) =>
      onSession(
        sessionId,
        (screen) =>
          serially(
            screen.id,
            Effect.gen(function* () {
              const current = yield* screens.byId(screen.id);
              if (current === null || screenHolderConnection(current.input) !== connection) {
                return false;
              }
              yield* arm(current.id, current.input);
              return true;
            }),
          ),
        false,
      ),
    /** The holder's keys and pointer, sent through the hand while that connection holds. */
    input: (sessionId: SessionId, connection: ViewerConnectionId, inputs: ReadonlyArray<Input>) =>
      onSession(
        sessionId,
        (screen) => {
          const { input } = screen;
          if (input._tag !== "Person" || input.connection !== connection) {
            return Effect.succeed(false);
          }
          return Effect.flatMap(hands.of(screen), (hand) =>
            hand === null
              ? Effect.succeed(false)
              : hand.relay(inputs, input.epoch).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ),
          );
        },
        false,
      ),
  };
});

export type ScreenControl = Effect.Success<ReturnType<typeof makeScreenControl>>;
