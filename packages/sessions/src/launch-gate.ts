import { SealantPlatformError } from "@mend/sealant";
import { Effect } from "effect";

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
  readonly underWay: (sessionId: string) => boolean;
}

export const makeLaunchGate = (): LaunchGate => {
  const underWay = new Set<string>();
  return {
    run:
      (sessionId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend((): Effect.Effect<A, E | SealantPlatformError, R> => {
          if (underWay.has(sessionId)) {
            return Effect.fail(
              new SealantPlatformError({
                code: "session_starting",
                status: 409,
                message:
                  "starting · a launch of this session is already under way · nothing new started",
                cause: null,
              }),
            );
          }
          underWay.add(sessionId);
          return effect.pipe(Effect.ensuring(Effect.sync(() => underWay.delete(sessionId))));
        }),
    underWay: (sessionId) => underWay.has(sessionId),
  };
};
