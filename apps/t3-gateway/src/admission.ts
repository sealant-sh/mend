import { Duration, Effect, Option, type Scope } from "effect";

export interface AdmissionLimits {
  /** Units the pool holds: requests, or bytes for a pool with costs. */
  readonly total: number;
  /** Admissions one key (a device) may hold at once. */
  readonly perKey: number;
  /** Requests that may wait at once; past it, a request that does not fit is refused. */
  readonly queue: number;
}

/**
 * A pool shared by every key, of which one key may hold `perKey` admissions. A request that does
 * not fit waits until a release makes room, up to `wait`, and is refused past it or when `queue`
 * requests already wait. An admission is held until the caller's scope closes.
 */
export const makeAdmission = (limits: AdmissionLimits, wait: Duration.Duration) => {
  interface Waiter {
    readonly key: string;
    readonly cost: number;
    admitted: boolean;
    resume: () => void;
  }
  let used = 0;
  const held = new Map<string, number>();
  const waiting: Array<Waiter> = [];
  const fits = (key: string, cost: number) =>
    used + cost <= limits.total && (held.get(key) ?? 0) < limits.perKey;
  const take = (key: string, cost: number) => {
    used += cost;
    held.set(key, (held.get(key) ?? 0) + 1);
  };
  const give = (key: string, cost: number) => {
    used -= cost;
    const now = (held.get(key) ?? 1) - 1;
    if (now === 0) held.delete(key);
    else held.set(key, now);
    for (let index = 0; index < waiting.length; ) {
      const waiter = waiting[index];
      if (waiter === undefined || !fits(waiter.key, waiter.cost)) {
        index++;
        continue;
      }
      waiting.splice(index, 1);
      take(waiter.key, waiter.cost);
      waiter.admitted = true;
      waiter.resume();
    }
  };
  /** Whichever of the wait's end and its admission comes second hands the units back once. */
  const abandon = (waiter: Waiter) => {
    const index = waiting.indexOf(waiter);
    if (index >= 0) waiting.splice(index, 1);
    if (waiter.admitted) {
      waiter.admitted = false;
      give(waiter.key, waiter.cost);
    }
  };
  return (key: string, cost = 1): Effect.Effect<boolean, never, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (cost > limits.total) return false;
        if (fits(key, cost)) take(key, cost);
        else {
          if (waiting.length >= limits.queue) return false;
          const waiter: Waiter = { key, cost, admitted: false, resume: () => undefined };
          const admitted = yield* restore(
            Effect.callback<void>((resume) => {
              waiter.resume = () => resume(Effect.void);
              waiting.push(waiter);
              return Effect.sync(() => abandon(waiter));
            }).pipe(Effect.timeoutOption(wait)),
          ).pipe(Effect.onInterrupt(() => Effect.sync(() => abandon(waiter))));
          if (Option.isNone(admitted)) {
            abandon(waiter);
            return false;
          }
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => give(key, cost)));
        return true;
      }),
    );
};
