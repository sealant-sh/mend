import { Sealant, type ScopeInstance, type ScopeInstanceSpec } from "@sealant/sdk";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import type * as Scope from "effect/Scope";

import { toPlatformError } from "./client.ts";
import { SealantEnv } from "./config.ts";
import type { SealantPlatformError } from "./errors.ts";
import { sealantRequestPriority } from "./request-priority.ts";

/** Caller-only services deliberately have no workspace-link capability. */
export interface CallerService {
  readonly get: () => Effect.Effect<ScopeInstance | null, SealantPlatformError>;
  readonly up: (
    spec: ScopeInstanceSpec,
    secrets?: Redacted.Redacted<Readonly<Record<string, string>>>,
  ) => Effect.Effect<ScopeInstance, SealantPlatformError>;
  readonly stop: () => Effect.Effect<ScopeInstance, SealantPlatformError>;
  readonly backup: () => Effect.Effect<ReadableStream<Uint8Array>, SealantPlatformError>;
  readonly purge: (expectedInstanceId: string) => Effect.Effect<void, SealantPlatformError>;
}

/** An organization owns its retained service independently of projects and sessions. */
export class CallerServices extends Context.Service<
  CallerServices,
  {
    readonly organization: (
      key: string,
      budget: {
        readonly cpuMillicores: number;
        readonly memoryBytes: number;
        readonly storageBytes: number;
      },
    ) => Effect.Effect<CallerService, SealantPlatformError>;
  }
>()("@mend/sealant/CallerServices") {}

const wrap = <A>(run: () => Promise<A>): Effect.Effect<A, SealantPlatformError> =>
  Effect.tryPromise({ try: run, catch: toPlatformError });

const make: Effect.Effect<CallerServices["Service"], never, SealantEnv | Scope.Scope> = Effect.gen(
  function* () {
    const env = yield* SealantEnv;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Sealant({
            baseUrl: env.baseUrl,
            requestPriority: sealantRequestPriority,
            ...Option.match(env.serviceKey, {
              onNone: () => ({}),
              onSome: (key) => ({ apiKey: Redacted.value(key) }),
            }),
          }),
      ),
      (value) => Effect.promise(() => value.close()),
    );
    return CallerServices.of({
      organization: Effect.fn("CallerServices.organization")(function* (key, budget) {
        const scope = yield* wrap(() =>
          client.scopes.ensure({ key, ownerKind: "organization", budget }),
        );
        const instances = client.scopes.actAs(scope.id).instances;
        return {
          get: () =>
            wrap(() => instances.get("executor")).pipe(
              Effect.catchIf(
                (error) => error.code === "ResourceInstanceNotFoundError" || error.status === 404,
                () => Effect.succeed(null),
              ),
            ),
          up: (spec, secrets) =>
            wrap(() =>
              instances.up("executor", spec, {
                cause: "person",
                ...(secrets === undefined ? {} : { secretEnv: Redacted.value(secrets) }),
              }),
            ),
          stop: () =>
            wrap(() =>
              instances.stop("executor", { kind: "person", by: "Mend organization owner" }),
            ),
          backup: () => wrap(() => instances.backup("executor", "data")),
          purge: (expectedInstanceId) =>
            wrap(() => instances.purge("executor", { expectedInstanceId })).pipe(Effect.asVoid),
        } satisfies CallerService;
      }),
    });
  },
);

/** One scoped SDK client; Core owns containers, networks, secrets and retained volumes. */
export const CallerServicesLive: Layer.Layer<CallerServices, never, SealantEnv> = Layer.effect(
  CallerServices,
  make,
);
