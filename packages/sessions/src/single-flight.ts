import { Deferred, Effect } from "effect";

/**
 * Work in flight by key (e2e8 F2): a caller asking for work already running joins it instead of
 * starting it again, and the work runs detached from whoever started it — a caller that gives up
 * (sealantd timing a register out, a request whose client went away) leaves it running for the
 * next caller to join, rather than abandoning half of it or running a second copy beside it. The
 * entry leaves the map once the work ends: a later caller starts it afresh.
 */
export interface SingleFlight<A, E, T> {
  /**
   * `work`'s outcome: joined when an entry for `key` is running and `joins` accepts the tag it
   * was started with (the same request), else started detached under `key` with `tag`.
   */
  readonly run: (
    key: string,
    tag: T,
    work: Effect.Effect<A, E>,
    joins?: (running: T) => boolean,
  ) => Effect.Effect<A, E>;
  /** Whether work is in flight under `key`. */
  readonly running: (key: string) => boolean;
}

export const makeSingleFlight = <A, E, T = null>(): SingleFlight<A, E, T> => {
  const inFlight = new Map<string, { readonly tag: T; readonly done: Deferred.Deferred<A, E> }>();
  const run = (
    key: string,
    tag: T,
    work: Effect.Effect<A, E>,
    joins?: (running: T) => boolean,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const current = inFlight.get(key);
      if (current !== undefined && (joins === undefined || joins(current.tag))) {
        return yield* Deferred.await(current.done);
      }
      const done = yield* Deferred.make<A, E>();
      inFlight.set(key, { tag, done });
      yield* Effect.forkDetach(
        work.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              if (inFlight.get(key)?.done === done) inFlight.delete(key);
            }).pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
        ),
      );
      return yield* Deferred.await(done);
    });
  return { run, running: (key) => inFlight.has(key) };
};
