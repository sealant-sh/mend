import type { BoatKeyProof } from "@mend/domain/workbench";
import { type BoatAccountRefusal, SealantClients, type SealantPlatformError } from "@mend/sealant";
import { Context, DateTime, Duration, Effect, Exit, Fiber, FiberMap, Layer, Option } from "effect";

/**
 * Full checks of Boat keys (SLNT-784). Core's `prove` answers when the check is done, about a
 * minute against Boat, so the call runs in a fiber of this service, not of the request: a browser
 * tab closed or a proxy that gives up on the request does not interrupt it, and Core keeps the
 * result on the account (`lastProof`), which the key's status reads back. A request waits a few
 * seconds for the answer; a check still running then is answered as running, and its status says
 * since when until Core's answer replaces it.
 */
export type BoatFullCheckRun =
  | { readonly _tag: "finished"; readonly proof: BoatKeyProof }
  | { readonly _tag: "running"; readonly since: Date };

export class BoatKeyFullChecks extends Context.Service<
  BoatKeyFullChecks,
  {
    /**
     * Starts a full check of the Core Boat account, unless one this server started is running,
     * and waits a few seconds for its answer. Core's refusals (a check of the account still
     * running or cleaning up, the account gone) fail as Core gave them.
     */
    readonly run: (
      sealantBoatAccountId: string,
    ) => Effect.Effect<BoatFullCheckRun, BoatAccountRefusal | SealantPlatformError>;
    /** When the check of the account this server is running started; null when none is. */
    readonly runningSince: (sealantBoatAccountId: string) => Effect.Effect<Date | null>;
  }
>()("@mend/api/BoatKeyFullChecks") {}

/** How long a request waits for a full check's answer before answering it as running. */
export const FullCheckAnswerWait = Context.Reference<Duration.Input>(
  "@mend/api/FullCheckAnswerWait",
  { defaultValue: () => Duration.seconds(3) },
);

export const BoatKeyFullChecksLive: Layer.Layer<BoatKeyFullChecks, never, SealantClients> =
  Layer.effect(
    BoatKeyFullChecks,
    Effect.gen(function* () {
      const clients = yield* SealantClients;
      const fibers = yield* FiberMap.make<
        string,
        BoatKeyProof,
        BoatAccountRefusal | SealantPlatformError
      >();
      const started = new Map<string, Date>();

      const fiberFor = Effect.fn("BoatKeyFullChecks.fiberFor")(function* (account: string) {
        const running = yield* FiberMap.get(fibers, account);
        if (Option.isSome(running)) return running.value;
        started.set(account, yield* DateTime.nowAsDate);
        return yield* FiberMap.run(
          fibers,
          account,
          clients.proveBoatAccount(account).pipe(
            Effect.tapError((error) =>
              Effect.logInfo(
                `boat key: full check of Sealant account ${account} not run · ${error._tag} · ${error.message}`,
              ),
            ),
            Effect.ensuring(Effect.sync(() => started.delete(account))),
          ),
        );
      });

      const run = Effect.fn("BoatKeyFullChecks.run")(function* (account: string) {
        const fiber = yield* fiberFor(account);
        const answered = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOption(yield* FullCheckAnswerWait),
        );
        if (Option.isNone(answered)) {
          const since = started.get(account) ?? (yield* DateTime.nowAsDate);
          return { _tag: "running", since } satisfies BoatFullCheckRun;
        }
        const exit = answered.value;
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
        return { _tag: "finished", proof: exit.value } satisfies BoatFullCheckRun;
      });

      const runningSince = (account: string) => Effect.sync(() => started.get(account) ?? null);

      return { run, runningSince };
    }),
  );
