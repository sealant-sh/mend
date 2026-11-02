import { Effect, Schema } from "effect";

import { ServiceDependency } from "./service-dependency.ts";

/** Directory-, shell- and URL-safe recipe names; also the CLI lookup key. */
export const RECIPE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const segmentsOf = (raw: string) =>
  raw.split("/").filter((segment) => segment !== "" && segment !== ".");

/** Why `raw` is not a path inside the repository, or null when it is one. */
export const repoRelativePathIssue = (raw: string): string | null => {
  if (raw.includes("\0")) return "contains a NUL byte";
  if (raw.startsWith("/")) return "is absolute; name a path inside the repository";
  if (segmentsOf(raw).includes("..")) return "leaves the repository (..)";
  return null;
};

/**
 * A directory inside the repository, normalized, never the root itself: `apps/web`, never
 * `/apps/web`, `./apps/web/`, `apps/../web` or `.`.
 */
export const RepoRelativePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value === "" || segmentsOf(value).join("/") !== value
        ? "a normalized path below the repository root"
        : (repoRelativePathIssue(value) ?? undefined),
    ),
  ),
  Schema.brand("RepoRelativePath"),
);
export type RepoRelativePath = typeof RepoRelativePath.Type;

/**
 * A recipe's `cwd` as written, read: null for the repository root (`""`, `"."`), else the
 * normalized path, else why it is refused.
 */
export const repoRelativePathOf = (
  raw: string,
):
  | { readonly ok: true; readonly path: RepoRelativePath | null }
  | { readonly ok: false; readonly issue: string } => {
  const issue = repoRelativePathIssue(raw);
  if (issue !== null) return { ok: false, issue };
  const normalized = segmentsOf(raw).join("/");
  return { ok: true, path: normalized === "" ? null : RepoRelativePath.make(normalized) };
};

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const EnvName = Schema.String.check(Schema.isPattern(ENV_NAME));

/** A recipe's own environment: the names it sets, never Mend's (`MEND_*`, `PORT`). */
export const RecipeEnv = Schema.Record(EnvName, Schema.String);
export type RecipeEnv = typeof RecipeEnv.Type;

export const READY_TIMEOUT_MIN_MS = 1000;
export const READY_TIMEOUT_MAX_MS = 600_000;
export const READY_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * When a started Service counts as up: its port accepting a TCP connection, or answering an HTTP
 * request for `path` with any status line. Either waits at most `timeoutMs`.
 */
export const RecipeReady = Schema.Union([
  Schema.TaggedStruct("Tcp", { timeoutMs: Schema.Int }),
  Schema.TaggedStruct("Http", { path: Schema.String, timeoutMs: Schema.Int }),
]);
export type RecipeReady = typeof RecipeReady.Type;

export const DEFAULT_RECIPE_READY: RecipeReady = {
  _tag: "Tcp",
  timeoutMs: READY_TIMEOUT_DEFAULT_MS,
};

/**
 * The `Host` a preview's requests carry to the Service: `localhost:<port>` (rewrite), or the
 * preview's own host (preserve), for an app that builds its links from the host it was asked as.
 */
export const ServiceHostPolicy = Schema.Literals(["rewrite", "preserve"]);
export type ServiceHostPolicy = typeof ServiceHostPolicy.Type;

/**
 * Where the Service listens: the workspace's loopback, or a container Docker publishes. A docker
 * Service is always dialled port-scoped: nothing can prove which process holds a container's port.
 */
export const ServiceAddress = Schema.Literals(["loopback", "docker"]);
export type ServiceAddress = typeof ServiceAddress.Type;

/**
 * A declared Service recipe (docs/SESSION-SERVICES.md): one entry of the repo's `.mend/mend.toml`,
 * versioned with the code, or a project row. A recipe is intent, never a running process: `mend
 * service run <name>` starts one; a command-less entry is an `add` recipe (an already-listening
 * port to adopt). The launch fields default to what a recipe meant before they existed, so a
 * project row and an older server's answer read the same.
 */
export class ServiceRecipe extends Schema.Class<ServiceRecipe>("ServiceRecipe")({
  name: Schema.String,
  /** Shell command to supervise; null = adopt-only (compose sidecar, external daemon). */
  command: Schema.NullOr(Schema.String),
  /** The port the Service listens on inside the workspace. */
  port: Schema.Int,
  /** Declared transport; UDP entries relay datagrams instead of a byte stream. */
  protocol: Schema.Literals(["tcp", "udp"]),
  /** Open exists only when explicitly declared; TCP alone never implies HTTP. */
  browserScheme: Schema.NullOr(Schema.Literals(["http", "https"])),
  /** Where it was declared: the repo's .mend/mend.toml (travels, reviewable) or this machine's project row. */
  source: Schema.Literals(["file", "project"]),
  /** A colliding declaration remains visible but cannot run. */
  shadowedBy: Schema.NullOr(Schema.Literals(["file", "project"])),
  /** Where the command runs; null is the repository root. */
  cwd: Schema.NullOr(RepoRelativePath).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  env: RecipeEnv.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({})),
  ),
  ready: RecipeReady.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_RECIPE_READY)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_RECIPE_READY)),
  ),
  host: ServiceHostPolicy.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("rewrite" as const)),
    Schema.withConstructorDefault(Effect.succeed("rewrite" as const)),
  ),
  address: ServiceAddress.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("loopback" as const)),
    Schema.withConstructorDefault(Effect.succeed("loopback" as const)),
  ),
  /** Recipes of the same session started first, in this order. */
  depends: Schema.Array(ServiceDependency).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
}) {}

/**
 * Why one declaration cannot run: the recipe it belongs to (null for a file-level table such as
 * `[preview]`), the key it names (`cwd`, `env.MEND_X`, `ready.timeout`, `preview.service`) and
 * what is wrong with it.
 */
export class RecipeRefusal extends Schema.Class<RecipeRefusal>("RecipeRefusal")({
  name: Schema.NullOr(Schema.String),
  key: Schema.String,
  message: Schema.String,
}) {}

/** A key this Mend does not read: a later version's, or a typo. Listed, never refused. */
export class IgnoredDeclaration extends Schema.Class<IgnoredDeclaration>("IgnoredDeclaration")({
  name: Schema.NullOr(Schema.String),
  key: Schema.String,
}) {}

/**
 * `[setup]` (ADR 0017, decision 4): commands a recipe start runs first in the worktree, in order,
 * once per place and fingerprint. The fingerprint covers `run` and the bytes of each of `inputs`,
 * so editing a command or a lockfile runs setup again.
 */
export class SetupDeclaration extends Schema.Class<SetupDeclaration>("SetupDeclaration")({
  run: Schema.NonEmptyArray(Schema.String),
  /** Files, repository-relative, whose bytes join the fingerprint; an absent one counts too. */
  inputs: Schema.Array(RepoRelativePath),
}) {}

export class RecipeDigestView extends Schema.Class<RecipeDigestView>("RecipeDigestView")({
  name: Schema.String,
  digest: Schema.String,
}) {}

/** `[preview]`: the Service a worktree's preview shows. */
export class PreviewDeclaration extends Schema.Class<PreviewDeclaration>("PreviewDeclaration")({
  service: Schema.String,
}) {}

/**
 * Everything a session's `.mend/mend.toml` and its project's rows declare, read whole: the recipes that
 * can be listed, the ones refused and why, the keys ignored, and the preview.
 */
export class ServiceDeclarations extends Schema.Class<ServiceDeclarations>("ServiceDeclarations")({
  recipes: Schema.Array(ServiceRecipe),
  refused: Schema.Array(RecipeRefusal),
  ignored: Schema.Array(IgnoredDeclaration),
  preview: Schema.NullOr(PreviewDeclaration),
  /** `[setup]` when the file declares one Mend can run; a refused one is in `refused`. */
  setup: Schema.NullOr(SetupDeclaration).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Each runnable recipe with a command, and its digest. */
  digests: Schema.Array(RecipeDigestView).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
}) {}

export const setupRefusalsOf = (
  refused: ReadonlyArray<RecipeRefusal>,
): ReadonlyArray<RecipeRefusal> =>
  refused.filter(
    (refusal) =>
      refusal.name === null && (refusal.key === "setup" || refusal.key.startsWith("setup.")),
  );

export const ServiceStartStepState = Schema.Literals([
  "waiting",
  "starting",
  "ready",
  /** Already running: waited for, never started again. */
  "reused",
  /** Running, and its `ready` rule never held within its timeout. */
  "not-ready",
  "stopped",
  "failed",
]);

export class ServiceStartStep extends Schema.Class<ServiceStartStep>("ServiceStartStep")({
  name: Schema.String,
  port: Schema.Int,
  state: ServiceStartStepState,
  reason: Schema.NullOr(Schema.String),
}) {}

export const ServiceStartSetupState = Schema.Literals([
  "waiting",
  "running",
  /** It ran now, every step exiting 0. */
  "ran",
  /** It ran here before for this fingerprint and succeeded, so it was not run again. */
  "unchanged",
  /** `[setup]` is refused: an explicit start goes on without it, and says why. */
  "refused",
  "failed",
  "stopped",
]);

export class ServiceStartSetup extends Schema.Class<ServiceStartSetup>("ServiceStartSetup")({
  state: ServiceStartSetupState,
  step: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
}) {}

/**
 * A recipe start Mend runs to its end whatever its request does (ADR 0017, delivery 9): the
 * file's `[setup]` first, when it declares one, then each recipe of its plan, dependencies first
 * and the Service asked for last. `running` until that Service's start has finished (`started`),
 * setup or a dependency did not finish (`failed`) or a Stop came first (`stopped`); `message`
 * says why for the last two.
 */
export class ServiceStartProgress extends Schema.Class<ServiceStartProgress>(
  "ServiceStartProgress",
)({
  service: Schema.String,
  state: Schema.Literals(["running", "started", "failed", "stopped"]),
  steps: Schema.Array(ServiceStartStep),
  message: Schema.NullOr(Schema.String),
  /** Null when the file declares no `[setup]`, or nothing in the plan runs a command. */
  setup: Schema.NullOr(ServiceStartSetup).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

/** `MEND_SERVICE_<NAME>`: the recipe name upper-cased, each character outside `[A-Z0-9]` a `_`. */
export const dependencyEnvPrefix = (name: string): string =>
  `MEND_SERVICE_${name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;

/** A refusal as a person reads it: `web · cwd · is absolute; …`. */
export const recipeRefusalLine = (refusal: RecipeRefusal): string =>
  [refusal.name ?? ".mend/mend.toml", refusal.key, refusal.message].join(" · ");

/**
 * How one Service attempt was launched, as its row records it: a restart replays it rather than
 * reading the file again. `env` is the recipe's own, never Mend's; `depends` names the session
 * dependencies whose addresses its env carries, which a restart looks up again.
 */
export interface ServiceLaunch {
  readonly cwd: RepoRelativePath | null;
  readonly env: RecipeEnv;
  readonly ready: RecipeReady;
  readonly depends: ReadonlyArray<ServiceDependency>;
}

/** An explicit `mend service run` and an attempt from before 0143 launch this way. */
export const DEFAULT_SERVICE_LAUNCH: ServiceLaunch = {
  cwd: null,
  env: {},
  ready: DEFAULT_RECIPE_READY,
  depends: [],
};
