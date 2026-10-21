import { SealantPlatformError } from "@mend/sealant";
import { Deferred, Effect } from "effect";

export const LAUNCH_UNDER_WAY_WORDS =
  "starting · a launch of this session is already under way · nothing new started";

/**
 * One launch verb per session at a time (alpha 2026-09-30, 523ce2cb). A resume leaves the settled
 * row as it is until its agent runs, so a second resume sent meanwhile (a phone still showing
 * Resume) found nothing live, drained the first one's new executor and created another, three
 * times over, while the first carried on setting up a machine that was gone. The gate refuses
 * the second; the first carries on, and the gate opens again however it ends.
 */
export interface LaunchGate {
  readonly run: (
    sessionId: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SealantPlatformError, R>;
  /**
   * `run`, answering a refusal with `refused` (a public launch says why in its own terms; a hold
   * answers the session as it stands).
   */
  readonly runOr: <A2, E2, R2>(
    sessionId: string,
    refused: Effect.Effect<A2, E2, R2>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
  /**
   * `run`, waiting for the launch under way to end instead of refusing. For Mend's own recovery
   * of an agent a restart left behind (SLNT-167): it must run, but only between launches, and it
   * reads what it recovers again once it holds the gate.
   */
  readonly runWhenFree: (
    sessionId: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly underWay: (sessionId: string) => boolean;
}

export const makeLaunchGate = (): LaunchGate => {
  /** Each holder's release, awaited by whoever waits for the gate. */
  const held = new Map<string, Deferred.Deferred<void>>();
  const hold = <A, E, R>(sessionId: string, effect: Effect.Effect<A, E, R>) => {
    const released = Deferred.makeUnsafe<void>();
    held.set(sessionId, released);
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          held.delete(sessionId);
          Deferred.doneUnsafe(released, Effect.void);
        }),
      ),
    );
  };
  const runOr =
    <A2, E2, R2>(sessionId: string, refused: Effect.Effect<A2, E2, R2>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(
        (): Effect.Effect<A | A2, E | E2, R | R2> =>
          held.has(sessionId) ? refused : hold(sessionId, effect),
      );
  const runWhenFree =
    (sessionId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      const attempt: Effect.Effect<A, E, R> = Effect.suspend(() => {
        const current = held.get(sessionId);
        return current === undefined
          ? hold(sessionId, effect)
          : Deferred.await(current).pipe(Effect.andThen(attempt));
      });
      return attempt;
    };
  return {
    run: (sessionId) =>
      runOr(
        sessionId,
        Effect.fail(
          new SealantPlatformError({
            code: "session_starting",
            status: 409,
            message: LAUNCH_UNDER_WAY_WORDS,
            cause: null,
          }),
        ),
      ),
    runOr,
    runWhenFree,
    underWay: (sessionId) => held.has(sessionId),
  };
};
