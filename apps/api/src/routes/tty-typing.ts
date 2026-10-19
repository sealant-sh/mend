import { Clock, Effect, type Scope } from "effect";

/** How long after a key that cleared a wait the next clear waits. */
export const TYPED_CLEAR_EVERY_MS = 2_000;

/**
 * Keys in a terminal agent's terminal, as calls to `clear` (the engine's `personTyped`, true when
 * it cleared a wait). Only a call that cleared something opens the window, so keys typed while
 * nothing waits never hold back the answer to the next ask. A key inside the window schedules one
 * call at the window's end, so an answer typed right after a clear lands late, never dropped.
 */
export const makeKeystrokeClear = (
  clear: Effect.Effect<boolean>,
  scope: Scope.Scope,
  windowMs: number = TYPED_CLEAR_EVERY_MS,
): Effect.Effect<void> => {
  let windowEndsAt = Number.NEGATIVE_INFINITY;
  let trailing = false;
  const call = clear.pipe(
    Effect.flatMap((cleared) =>
      cleared
        ? Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              windowEndsAt = now + windowMs;
            }),
          )
        : Effect.void,
    ),
  );
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now >= windowEndsAt) {
      yield* Effect.forkIn(call, scope);
      return;
    }
    if (trailing) return;
    trailing = true;
    yield* Effect.forkIn(
      Effect.sleep(windowEndsAt - now).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trailing = false;
          }),
        ),
        Effect.andThen(call),
      ),
      scope,
    );
  });
};
