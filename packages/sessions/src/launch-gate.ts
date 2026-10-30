import { said } from "@mend/domain";
import { curatedError, type SealantPlatformError } from "@mend/sealant";
import { Deferred, Effect } from "effect";

export const LAUNCH_UNDER_WAY_WORDS = said`starting · a launch of this session is already under way · nothing new started`;

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
   * answers the session as it stands). Work between launches (`runBetween`) is waited for, not
   * refused.
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
  /**
   * Work between the session's launches, not a launch (a display going back, ADR 0020): it waits
   * for the holder as `runWhenFree` does, and a launch sent while it runs waits for it in turn
   * instead of being refused. `underWay` stays false: nothing of the session is starting.
   */
  readonly runBetween: (
    sessionId: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** `runBetween` while nothing holds the gate; `busy` at once otherwise. */
  readonly runBetweenOr: <A2, E2, R2>(
    sessionId: string,
    busy: Effect.Effect<A2, E2, R2>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A | A2, E | E2, R | R2>;
  /**
   * A launch of the session is under way, or waits for work between launches to end; that work
   * alone is not one.
   */
  readonly underWay: (sessionId: string) => boolean;
}

export const makeLaunchGate = (): LaunchGate => {
  /** Each holder's release, awaited by whoever waits for the gate, and whether it is a launch. */
  const held = new Map<
    string,
    { readonly released: Deferred.Deferred<void>; readonly launch: boolean }
  >();
  const hold = <A, E, R>(sessionId: string, launch: boolean, effect: Effect.Effect<A, E, R>) => {
    const released = Deferred.makeUnsafe<void>();
    held.set(sessionId, { released, launch });
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          held.delete(sessionId);
          Deferred.doneUnsafe(released, Effect.void);
        }),
      ),
    );
  };
  /** Launches waiting for work between launches to end: under way already, so a Stop finds them. */
  const waiting = new Map<string, number>();
  const waitFor = (sessionId: string, released: Deferred.Deferred<void>) =>
    Effect.suspend(() => {
      waiting.set(sessionId, (waiting.get(sessionId) ?? 0) + 1);
      return Deferred.await(released).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const left = (waiting.get(sessionId) ?? 1) - 1;
            if (left <= 0) waiting.delete(sessionId);
            else waiting.set(sessionId, left);
          }),
        ),
      );
    });
  const runOr =
    <A2, E2, R2>(sessionId: string, refused: Effect.Effect<A2, E2, R2>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const attempt: Effect.Effect<A | A2, E | E2, R | R2> = Effect.suspend(() => {
        const current = held.get(sessionId);
        if (current === undefined) return hold(sessionId, true, effect);
        return current.launch
          ? refused
          : waitFor(sessionId, current.released).pipe(Effect.andThen(attempt));
      });
      return attempt;
    };
  const whenFree =
    (sessionId: string, launch: boolean) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
      const attempt: Effect.Effect<A, E, R> = Effect.suspend(() => {
        const current = held.get(sessionId);
        return current === undefined
          ? hold(sessionId, launch, effect)
          : Deferred.await(current.released).pipe(Effect.andThen(attempt));
      });
      return attempt;
    };
  return {
    run: (sessionId) =>
      runOr(
        sessionId,
        Effect.fail(
          curatedError({
            code: "session_starting",
            status: 409,
            words: LAUNCH_UNDER_WAY_WORDS,
            cause: null,
          }),
        ),
      ),
    runOr,
    runWhenFree: (sessionId) => whenFree(sessionId, true),
    runBetween: (sessionId) => whenFree(sessionId, false),
    runBetweenOr:
      <A2, E2, R2>(sessionId: string, busy: Effect.Effect<A2, E2, R2>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(
          (): Effect.Effect<A | A2, E | E2, R | R2> =>
            held.has(sessionId) ? busy : hold(sessionId, false, effect),
        ),
    underWay: (sessionId) => held.get(sessionId)?.launch === true || waiting.has(sessionId),
  };
};
