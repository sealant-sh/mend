import { OrganizationsRepo } from "@mend/db";
import { TenancyMode } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** `MEND_TENANCY` as this process runs it (docs/adr/0003-organizations-and-tenancy.md). */
export class TenancyConfig extends Context.Service<TenancyConfig, { readonly mode: TenancyMode }>()(
  "@mend/api/TenancyConfig",
) {}

/** The process must not start in the requested tenancy mode; the message says why and what to do. */
export class TenancyRefused extends Schema.TaggedErrorClass<TenancyRefused>()("TenancyRefused", {
  message: Schema.String,
}) {}

/**
 * Items of the multi mode gate that are not yet in place. Later steps of the organizations stack
 * remove entries as they land; the final step replaces this list with computed checks.
 */
export const MULTI_MODE_MISSING: ReadonlyArray<string> = [
  "Mend-managed folders in place of host paths",
  "checked git source addresses pinned against DNS rebinding",
  "a sealantd that declares every upload's size (PLATFORM-FEEDBACK.md, 2026-09-17)",
];

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Raw service listeners have no Mend authorization: whoever reaches the port reaches the Service
 * (docs/adr/0003, "Raw service ports"). In `multi` they must stay on loopback, and Services are
 * reached through the authenticated tunnel. Returns the offending addresses.
 */
export const exposedServiceHosts = (serviceHosts: string | undefined): ReadonlyArray<string> =>
  (serviceHosts ?? "127.0.0.1")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "" && !LOOPBACK.has(address));

/** The deployment facts the multi mode gate reads from configuration. */
export interface TenancyPosture {
  readonly serviceHosts?: string;
  /** MEND_SOURCE_POLICY: `tenant` keeps Mend's own git off private and local networks. */
  readonly sourcePolicy?: "operator" | "tenant";
  /** MEND_GIT_TRANSPORT_BIND_ORIGIN: a workspace signs only against its project's remote. */
  readonly transportBoundToOrigin?: boolean;
  /** MEND_CAPTURE_REQUIRE_SIZES: every capture upload is signed for its declared size. */
  readonly captureRequireSizes?: boolean;
  /** MEND_BLOB_STORE: only an S3-compatible bucket enforces a signed length. */
  readonly blobStore?: string;
}

/** Why this combination must not start, or null when it may. */
export const tenancyRefusal = (
  mode: TenancyMode,
  organizationCount: number,
  posture: TenancyPosture = {},
): string | null => {
  if (mode === "multi") {
    const exposed = exposedServiceHosts(posture.serviceHosts);
    const missing = [
      ...MULTI_MODE_MISSING,
      ...(exposed.length === 0
        ? []
        : [`raw service listeners on ${exposed.join(", ")} (unset MEND_SERVICE_HOSTS)`]),
      ...(posture.sourcePolicy === "tenant"
        ? []
        : ["the tenant source policy (set MEND_SOURCE_POLICY=tenant)"]),
      ...(posture.transportBoundToOrigin === false
        ? ["git transport bound to each project's remote (unset MEND_GIT_TRANSPORT_BIND_ORIGIN)"]
        : []),
      ...(posture.captureRequireSizes === true
        ? []
        : ["capture uploads signed for their size (set MEND_CAPTURE_REQUIRE_SIZES=true)"]),
      ...(posture.blobStore?.startsWith("s3://") === true
        ? []
        : ["an S3-compatible blob store, which enforces signed lengths (MEND_BLOB_STORE=s3://…)"]),
    ];
    return [
      "MEND_TENANCY=multi is refused: the multi mode gate",
      "(docs/adr/0003-organizations-and-tenancy.md, 'Multi mode gate') is not complete.",
      `Missing: ${missing.join("; ")}.`,
      "Start with MEND_TENANCY=single (the default).",
    ].join(" ");
  }
  if (organizationCount > 1) {
    return `MEND_TENANCY=single is refused: ${organizationCount} organizations exist on this instance.`;
  }
  return null;
};

/**
 * Reads `MEND_TENANCY` (default `single`) and refuses to build when the mode may not run against
 * this database. Provided beneath the server and workers, so nothing serves before it passes.
 */
export const TenancyConfigLive: Layer.Layer<
  TenancyConfig,
  TenancyRefused | Config.ConfigError,
  OrganizationsRepo
> = Layer.effect(
  TenancyConfig,
  Effect.gen(function* () {
    const mode = yield* Config.schema(TenancyMode, "MEND_TENANCY").pipe(
      Config.withDefault("single"),
    );
    const serviceHosts = yield* Config.string("MEND_SERVICE_HOSTS").pipe(
      Config.withDefault("127.0.0.1"),
    );
    const sourcePolicy = yield* Config.schema(
      Schema.Literals(["operator", "tenant"]),
      "MEND_SOURCE_POLICY",
    ).pipe(Config.withDefault("operator" as const));
    const transportBoundToOrigin = yield* Config.boolean("MEND_GIT_TRANSPORT_BIND_ORIGIN").pipe(
      Config.withDefault(true),
    );
    const captureRequireSizes = yield* Config.boolean("MEND_CAPTURE_REQUIRE_SIZES").pipe(
      Config.withDefault(false),
    );
    const blobStore = yield* Config.string("MEND_BLOB_STORE").pipe(Config.withDefault(""));
    const organizations = yield* OrganizationsRepo;
    const refusal = tenancyRefusal(mode, yield* organizations.count(), {
      serviceHosts,
      sourcePolicy,
      transportBoundToOrigin,
      captureRequireSizes,
      blobStore,
    });
    if (refusal !== null) return yield* new TenancyRefused({ message: refusal });
    yield* Effect.logInfo("tenancy").pipe(Effect.annotateLogs({ mode }));
    return { mode };
  }),
);
