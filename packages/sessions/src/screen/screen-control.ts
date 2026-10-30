import { ScreensRepo } from "@mend/db";
import type { ScreenId, SessionId, ViewerConnectionId } from "@mend/domain";
import {
  SCREEN_LIMITS,
  type Screen,
  type ScreenInput,
  type ScreenInputEvent,
  type ScreenInputTransition,
  type ScreenLapse,
  screenHolderConnection,
  transitionInput,
} from "@mend/domain/workbench";
import type { BlobStore } from "@mend/store";
import { Clock, Effect, Fiber, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import { storeFrame } from "./frames.ts";
import type { Hands } from "./hands.ts";
import type { Input } from "./rfb-client.ts";
import { ScreenHost } from "./screen-host.ts";

export type ScreenControlAnswer = ScreenInputTransition | { readonly _tag: "NoScreen" };

const NO_SCREEN: ScreenControlAnswer = { _tag: "NoScreen" };
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
  /** Every change to a screen's row or timer this process makes, one at a time per screen. */
  const serially = <A, E>(screenId: ScreenId, effect: Effect.Effect<A, E>) => {
    const lock = locks.get(screenId) ?? Semaphore.makeUnsafe(1);
    locks.set(screenId, lock);
    return lock.withPermit(effect);
  };

  const frameOf = (screen: Screen) =>
    Effect.gen(function* () {
      const hand = yield* hands.of(screen);
      if (hand === null) return null;
      const png = yield* hand.look.pipe(Effect.option);
      return png._tag === "Some" ? yield* storeFrame(screen.id, png.value) : null;
    }).pipe(Effect.provideContext(context));

  /**
   * Applies `event` under the row's lock, while `still` holds for the row. A transition that logs
   * stores the frame taken just before it. Releases go ahead of anything queued behind them; a
   * fence is acknowledged once the hand has stopped the batch and released.
   */
  const decide = (
    screenId: ScreenId,
    event: ScreenInputEvent,
    owner: string | null,
    still: (screen: Screen) => boolean = () => true,
  ): Effect.Effect<ScreenControlAnswer> =>
    Effect.gen(function* () {
      const screen = yield* screens.byId(screenId);
      if (screen === null) return NO_SCREEN;
      if (!still(screen)) return UNCHANGED;
      const foreseen = transitionInput(screen.input, event, owner);
      const frame =
        foreseen._tag === "Changed" && foreseen.log !== null ? yield* frameOf(screen) : null;
      // The frame took time: what `still` stood for is checked again where nothing can change it.
      const decided = yield* serially(
        screenId,
        Effect.gen(function* () {
          const current = yield* screens.byId(screenId);
          if (current === null) return NO_SCREEN;
          if (!still(current)) return UNCHANGED;
          const answer = yield* screens
            .control(screenId, event, owner, frame)
            .pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.succeed(NO_SCREEN)));
          if (answer._tag === "Changed") yield* arm(screenId, answer.next);
          return answer;
        }),
      );
      if (decided._tag !== "Changed") return decided;
      const fencing = decided.next._tag === "Fencing";
      if (decided.releases || fencing) {
        yield* Effect.ignore(hands.open(screenId)?.release ?? Effect.void);
      }
      if (fencing) yield* decide(screenId, { _tag: "Fenced", epoch: decided.next.epoch }, owner);
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

  return {
    decide,
    serially,
    arm: (screen: Screen, input: ScreenInput) => serially(screen.id, arm(screen.id, input)),
    /** A hand ended by itself. One open since then replaced it, and what it was given stands. */
    ended: (screenId: ScreenId) =>
      decide(screenId, { _tag: "Ended" }, null, () => hands.open(screenId) === null),
    take: (sessionId: SessionId, userId: string, connection: ViewerConnectionId) =>
      byOwner(sessionId, { _tag: "Take", by: userId, connection }),
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
