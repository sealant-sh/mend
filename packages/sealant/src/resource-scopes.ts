import {
  Sealant,
  type ScopeArchivedVolume,
  type ScopeExecResult,
  type ScopeInstance,
  type ScopeInstanceSpec,
} from "@sealant/sdk";
import { Effect, Layer, Option, Redacted } from "effect";
import * as Context from "effect/Context";

import { toPlatformError } from "./client.ts";
import { SealantEnv } from "./config.ts";
import { SealantPlatformError } from "./errors.ts";

export type { ScopeArchivedVolume, ScopeExecResult, ScopeInstance, ScopeInstanceSpec };

/**
 * One project's resources on Sealant (`sealant.scopes`, ADR 0019): its instances and the
 * workspaces that reach them. Instances run on Docker only; on another runtime every call fails
 * with code `ResourceRuntimeUnsupportedError`, which `unsupportedRuntimeOf` reads.
 */
export interface ResourceScope {
  readonly id: string;
  /** Create or update the instance by key, start it and answer once it is ready or failed. */
  readonly up: (
    key: string,
    spec: ScopeInstanceSpec,
    cause: "use" | "person",
  ) => Effect.Effect<ScopeInstance, SealantPlatformError>;
  /** Null when the scope has no instance by this key. */
  readonly get: (key: string) => Effect.Effect<ScopeInstance | null, SealantPlatformError>;
  readonly list: (
    archived?: boolean,
  ) => Effect.Effect<ReadonlyArray<ScopeInstance>, SealantPlatformError>;
  /** A person's stop: it holds against every `use` until a person's `up`. */
  readonly stop: (key: string, by: string) => Effect.Effect<ScopeInstance, SealantPlatformError>;
  /** Run `argv` in the running instance; stdout and stderr come back as capped tails. */
  readonly exec: (
    key: string,
    options: {
      readonly argv: ReadonlyArray<string>;
      readonly user: string;
      readonly timeoutMs: number;
      readonly stdin?: AsyncIterable<Uint8Array>;
    },
  ) => Effect.Effect<ScopeExecResult, SealantPlatformError>;
  /** Stop it and remove its container; every volume stays. */
  readonly archive: (key: string) => Effect.Effect<void, SealantPlatformError>;
  /** Archives every instance and unlinks every workspace; all volumes stay. */
  readonly archiveScope: () => Effect.Effect<
    ReadonlyArray<ScopeArchivedVolume>,
    SealantPlatformError
  >;
  /** This workspace reaches the scope's project instances, and those of `worktreeKey`, by alias. */
  readonly link: (
    workspaceId: string,
    worktreeKey: string,
  ) => Effect.Effect<void, SealantPlatformError>;
}

export class ResourceScopes extends Context.Service<
  ResourceScopes,
  {
    /** The scope with this key, ensured on its first use in this process. */
    readonly of: (key: string) => Effect.Effect<ResourceScope, SealantPlatformError>;
  }
>()("@mend/sealant/ResourceScopes") {}

/** The runtime a Sealant that runs no resources names, or null for any other failure. */
export const unsupportedRuntimeOf = (error: SealantPlatformError): string | null => {
  if (error.code !== "ResourceRuntimeUnsupportedError") return null;
  return /this Sealant runs (\S+)/.exec(error.message)?.[1] ?? "another runtime";
};

const isNotFound = (error: SealantPlatformError) =>
  error.status === 404 || error.code === "ResourceInstanceNotFoundError";

const wrap = <A>(run: () => Promise<A>): Effect.Effect<A, SealantPlatformError> =>
  Effect.tryPromise({ try: run, catch: toPlatformError });

/**
 * Scopes need a service key and never an owner, so one service-level client serves every project.
 * A scope's id is kept for the process once ensured: `ensure` is idempotent by key, so the key is
 * the durable identity and Mend stores no copy of Core's id.
 */
export const ResourceScopesLive: Layer.Layer<ResourceScopes, never, SealantEnv> = Layer.effect(
  ResourceScopes,
  Effect.gen(function* () {
    const env = yield* SealantEnv;
    const sealant = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Sealant({
            baseUrl: env.baseUrl,
            ...Option.match(env.serviceKey, {
              onNone: () => ({}),
              onSome: (key) => ({ apiKey: Redacted.value(key) }),
            }),
          }),
      ),
      (client) => Effect.promise(() => client.close()),
    );
    const ids = new Map<string, string>();

    const scopeOf = (id: string): ResourceScope => {
      const client = sealant.scopes.actAs(id);
      return {
        id,
        up: (key, spec, cause) => wrap(() => client.instances.up(key, spec, { cause })),
        get: (key) =>
          wrap(() => client.instances.get(key)).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(null)),
          ),
        list: (archived) => wrap(() => client.instances.list({ archived: archived === true })),
        archiveScope: () =>
          wrap(() => client.archive()).pipe(Effect.map((answer) => answer.volumes)),
        stop: (key, by) => wrap(() => client.instances.stop(key, { kind: "person", by })),
        exec: (key, options) =>
          wrap(() =>
            client.instances.exec(key, {
              argv: options.argv,
              user: options.user,
              timeoutMs: options.timeoutMs,
              ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
            }),
          ),
        archive: (key) => wrap(() => client.instances.archive(key)).pipe(Effect.asVoid),
        link: (workspaceId, worktreeKey) =>
          wrap(() => client.workspaces.link(workspaceId, { worktreeKey })).pipe(Effect.asVoid),
      };
    };

    const of = Effect.fn("ResourceScopes.of")(function* (key: string) {
      const known = ids.get(key);
      if (known !== undefined) return scopeOf(known);
      const ensured = yield* wrap(() => sealant.scopes.ensure({ key }));
      ids.set(key, ensured.id);
      return scopeOf(ensured.id);
    });

    return { of };
  }),
);
