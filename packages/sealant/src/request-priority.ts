import { AsyncLocalStorage } from "node:async_hooks";

import { Effect, Fiber, Scope } from "effect";
import { dual } from "effect/Function";

/** The allowance a workflow asks sealant to spend, independent of its resource principal. */
export type SealantRequestPriority = "normal" | "interactive";

type PrioritySource = SealantRequestPriority | (() => SealantRequestPriority);

const priority = new AsyncLocalStorage<PrioritySource>();

/** Read at HTTP dispatch, including through SDK handles and their separate Promise runtime. */
export const sealantRequestPriority = (): SealantRequestPriority => {
  const source = priority.getStore();
  return typeof source === "function" ? source() : (source ?? "normal");
};

/**
 * Scope a workflow and its retries without changing concurrent work. Starting the fiber inside
 * the async context carries priority through the SDK's Promise runtime as well as Effect waits.
 * A provider follows a turn's lifecycle across later stream polls. The caller's services, scope
 * and interruptibility are preserved; interruption waits for the workflow's finalizers.
 */
export const withSealantRequestPriority =
  (value: PrioritySource) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        restore(
          Effect.callback<A, E>((resume) => {
            const fiber = priority.run(value, () =>
              Effect.runForkWith(context)(restore(self), { uninterruptible: true }),
            );
            fiber.addObserver(resume);
            return Fiber.interrupt(fiber);
          }),
        ),
      ),
    );

/** A person-facing entrypoint defaults to interactive; an explicit background scope stays normal. */
export const withInteractiveSealant = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => self.pipe(withSealantRequestPriority(priority.getStore() ?? "interactive")));

/** Fork maintenance in its owner's scope without inheriting a person's interactive allowance. */
export const forkSealantBackground: typeof Effect.forkIn = dual(
  (args) => Effect.isEffect(args[0]),
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    options?: Parameters<typeof Effect.forkIn>[2],
  ) => Effect.forkIn(self.pipe(withSealantRequestPriority("normal")), scope, options),
);
