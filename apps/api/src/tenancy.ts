import { InstanceRolesRepo, OrganizationsRepo } from "@mend/db";
import { TenancyMode } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** `MEND_TENANCY` as this process runs it (docs/adr/0003-organizations-and-tenancy.md). */
export class TenancyConfig extends Context.Service<
  TenancyConfig,
  {
    readonly mode: TenancyMode;
    /** The multi mode gate as evaluated at start, in either mode. */
    readonly gate: ReadonlyArray<GateOutcome>;
  }
>()("@mend/api/TenancyConfig") {}

/** The process must not start in the requested tenancy mode; the message says why and what to do. */
export class TenancyRefused extends Schema.TaggedErrorClass<TenancyRefused>()("TenancyRefused", {
  message: Schema.String,
}) {}

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
  /** MEND_SESSION_STORE: `captured` workspaces receive folders as archives, not bind mounts. */
  readonly sessionStore?: "captured" | "colocated";
  /** Accounts holding the operator role. */
  readonly operatorCount?: number;
}

/** One item of the multi mode gate, as observed on this instance. */
export interface GateOutcome {
  readonly id: string;
  readonly ok: boolean;
  /** What was observed, in plain words. */
  readonly detail: string;
  /** What would satisfy it, when it is not. */
  readonly fix: string | null;
}

const item = (id: string, ok: boolean, detail: string, fix: string): GateOutcome => ({
  id,
  ok,
  detail,
  fix: ok ? null : fix,
});

/**
 * The multi mode gate (docs/adr/0003-organizations-and-tenancy.md, "Multi mode gate"), computed
 * from what this build contains and how this instance is configured. Items this build already
 * carries answer from the code that implements them; configuration items answer from the posture;
 * items that wait on work outside this build say so.
 */
export const evaluateGate = (posture: TenancyPosture): ReadonlyArray<GateOutcome> => {
  const exposed = exposedServiceHosts(posture.serviceHosts);
  return [
    item(
      "cross-organization-authorization",
      true,
      "every route is classified and refuses across organizations with zero effects (project-access.test.ts)",
      "",
    ),
    item(
      "per-account-resources",
      true,
      "signers, push devices, notifications and GitHub identity belong to one account",
      "",
    ),
    item(
      "folders-reach-workspaces",
      true,
      posture.sessionStore === "colocated"
        ? "folders and references are mounted beside each worktree"
        : "folders and references travel with the plan as content-addressed archives, laid down beside the worktree (needs sealantd 0.16.0 or newer)",
      "",
    ),
    item(
      "source-policy",
      posture.sourcePolicy === "tenant",
      `Mend's own git follows the ${posture.sourcePolicy ?? "operator"} source policy`,
      "set MEND_SOURCE_POLICY=tenant",
    ),
    item(
      "source-address-pinning",
      posture.sourcePolicy === "tenant",
      posture.sourcePolicy === "tenant"
        ? "git dials the address the source policy checked, for ssh and HTTPS"
        : "the operator source policy leaves git to resolve names itself",
      "set MEND_SOURCE_POLICY=tenant",
    ),
    item(
      "transport-bound-to-origin",
      posture.transportBoundToOrigin !== false,
      posture.transportBoundToOrigin === false
        ? "a workspace's git transport may sign against any remote"
        : "a workspace's git transport signs only against its project's remote",
      "unset MEND_GIT_TRANSPORT_BIND_ORIGIN",
    ),
    item(
      "upload-length-binding",
      posture.captureRequireSizes === true && posture.blobStore?.startsWith("s3://") === true,
      posture.captureRequireSizes === true
        ? posture.blobStore?.startsWith("s3://") === true
          ? "every capture upload is signed for its size, and the bucket enforces it"
          : "sizes are required, but a directory blob store cannot enforce them"
        : "capture uploads without a declared size are accepted",
      "set MEND_CAPTURE_REQUIRE_SIZES=true with an S3-compatible MEND_BLOB_STORE",
    ),
    item(
      "daemon-declares-sizes",
      true,
      "sealantd declares the length of every upload it asks a URL for (sealantd 0.16.0 or newer)",
      "",
    ),
    item(
      "raw-service-ports",
      exposed.length === 0,
      exposed.length === 0
        ? "raw service listeners stay on loopback"
        : `raw service listeners on ${exposed.join(", ")}`,
      "unset MEND_SERVICE_HOSTS",
    ),
    item(
      "operator-present",
      (posture.operatorCount ?? 0) > 0,
      `${posture.operatorCount ?? 0} operator account(s)`,
      "grant the operator role to an account",
    ),
  ];
};

/** Why this combination must not start, or null when it may. */
export const tenancyRefusal = (
  mode: TenancyMode,
  organizationCount: number,
  gate: ReadonlyArray<GateOutcome>,
): string | null => {
  if (mode === "multi") {
    const failing = gate.filter((outcome) => !outcome.ok);
    if (failing.length === 0) return null;
    return [
      "MEND_TENANCY=multi is refused: the multi mode gate",
      "(docs/adr/0003-organizations-and-tenancy.md, 'Multi mode gate') is not complete.",
      ...failing.map((outcome) => `\n  ${outcome.id}: ${outcome.detail} (${outcome.fix ?? ""})`),
      "\nStart with MEND_TENANCY=single (the default).",
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
  InstanceRolesRepo | OrganizationsRepo
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
    const sessionStore = yield* Config.schema(
      Schema.Literals(["captured", "colocated"]),
      "MEND_SESSION_STORE",
    ).pipe(Config.withDefault("captured" as const));
    const organizations = yield* OrganizationsRepo;
    const operators = yield* (yield* InstanceRolesRepo).operators();
    const gate = evaluateGate({
      serviceHosts,
      sourcePolicy,
      transportBoundToOrigin,
      captureRequireSizes,
      blobStore,
      sessionStore,
      operatorCount: operators.length,
    });
    const refusal = tenancyRefusal(mode, yield* organizations.count(), gate);
    if (refusal !== null) return yield* new TenancyRefused({ message: refusal });
    yield* Effect.logInfo("tenancy").pipe(
      Effect.annotateLogs({
        mode,
        gate: gate.every((outcome) => outcome.ok) ? "passed" : "not passed",
        failing: gate
          .filter((outcome) => !outcome.ok)
          .map((outcome) => outcome.id)
          .join(","),
      }),
    );
    return { mode, gate };
  }),
);
