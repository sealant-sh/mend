import type { MultiModeGateCase } from "@mend/api-contracts";
import { InstanceRolesRepo, OrganizationsRepo, UsersRepo } from "@mend/db";
import { TenancyMode } from "@mend/domain/workbench";
import { Config, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** `MEND_TENANCY` as this process runs it (docs/adr/0003-organizations-and-tenancy.md). */
export class TenancyConfig extends Context.Service<
  TenancyConfig,
  {
    readonly mode: TenancyMode;
    /**
     * `MEND_ORGANIZATION_CREATION`: who may create an organization in `multi`. `operator` (the
     * default) keeps it to accounts holding the operator role, on the web or with
     * `mend operator org create`; `anyone` lets every signed-in person create one and own it.
     * `single` refuses both whatever this says.
     */
    readonly organizationCreation: OrganizationCreation;
    /**
     * The multi mode gate as it stands now, in either mode: configuration as read at start, the
     * operator accounts as they are on each read (the first account registers after start).
     */
    readonly gate: Effect.Effect<ReadonlyArray<GateOutcome>>;
  }
>()("@mend/api/TenancyConfig") {}

export const OrganizationCreation = Schema.Literals(["anyone", "operator"]);
export type OrganizationCreation = typeof OrganizationCreation.Type;

/**
 * Whether this caller may create an organization of their own here and own it: only in `multi`,
 * only an operator unless `MEND_ORGANIZATION_CREATION` is `anyone`, and never through an access
 * key, which acts in one organization and cannot join another (docs/adr/0023, decision 6).
 */
export const peopleCreateOrganizations = (
  tenancy: { readonly mode: TenancyMode; readonly organizationCreation: OrganizationCreation },
  caller: { readonly accessKey: boolean; readonly operator: boolean },
): boolean =>
  tenancy.mode === "multi" &&
  !caller.accessKey &&
  (tenancy.organizationCreation === "anyone" || caller.operator);

/** The process must not start in the requested tenancy mode; the message says why and what to do. */
export class TenancyRefused extends Schema.TaggedError<TenancyRefused>()("TenancyRefused", {
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
  /**
   * MEND_SOURCE_POLICY: `tenant` keeps Mend's own git off private and local networks. The gate
   * asks for it only of a `public` exposure: several organizations on one Mend belong to one
   * business, not to tenants who distrust each other (docs/adr/0003, "What multi means").
   */
  readonly sourcePolicy?: "operator" | "tenant";
  /** MEND_EXPOSURE is `public`: reached from the Internet (docs/adr/0004, item 5). */
  readonly publicExposure?: boolean;
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

/**
 * One item of the multi mode gate, as observed on this instance: its case (`reason`) and that
 * case's data, then the sentences `mend operator gate` prints.
 */
export type GateOutcome = MultiModeGateCase & GateOutcomeFacts;

interface GateOutcomeFacts {
  readonly ok: boolean;
  /** What was observed, in plain words. */
  readonly detail: string;
  /** What would satisfy it, when it is not. */
  readonly fix: string | null;
}

const item = (
  gateCase: MultiModeGateCase,
  ok: boolean,
  detail: string,
  fix: string,
): GateOutcome => ({
  ...gateCase,
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
  const tenantSources = posture.sourcePolicy === "tenant";
  // Several organizations here are one business: the operator policy is enough for them. Only an
  // Internet-facing install still needs Mend's own git kept off the private network.
  const sourcesOk = tenantSources || posture.publicExposure !== true;
  return [
    item(
      { id: "cross-organization-authorization", reason: "built-in" },
      true,
      "every route is classified and refuses across organizations with zero effects (project-access.test.ts)",
      "",
    ),
    item(
      { id: "per-account-resources", reason: "built-in" },
      true,
      "signers, push devices, notifications and GitHub identity belong to one account",
      "",
    ),
    item(
      {
        id: "folders-reach-workspaces",
        reason: posture.sessionStore === "colocated" ? "colocated" : "captured",
      },
      true,
      posture.sessionStore === "colocated"
        ? "folders and references are mounted beside each worktree"
        : "folders and references travel with the plan as content-addressed archives, laid down beside the worktree (needs sealantd 0.16.0 or newer)",
      "",
    ),
    item(
      {
        id: "source-policy",
        reason: posture.sourcePolicy === "tenant" ? "tenant" : "operator",
      },
      sourcesOk,
      tenantSources
        ? "Mend's own git follows the tenant source policy"
        : posture.publicExposure === true
          ? "Mend's own git follows the operator source policy, and a public exposure needs the tenant one"
          : "Mend's own git follows the operator source policy: private networks are allowed, since every organization here belongs to one business",
      "set MEND_SOURCE_POLICY=tenant",
    ),
    item(
      {
        id: "source-address-pinning",
        reason: posture.sourcePolicy === "tenant" ? "tenant" : "operator",
      },
      sourcesOk,
      tenantSources
        ? "git dials the address the source policy checked, for ssh and HTTPS"
        : "the operator source policy leaves git to resolve names itself",
      "set MEND_SOURCE_POLICY=tenant",
    ),
    item(
      {
        id: "transport-bound-to-origin",
        reason: posture.transportBoundToOrigin === false ? "unbound" : "bound",
      },
      posture.transportBoundToOrigin !== false,
      posture.transportBoundToOrigin === false
        ? "a workspace's git transport may sign against any remote"
        : "a workspace's git transport signs only against its project's remote",
      "unset MEND_GIT_TRANSPORT_BIND_ORIGIN",
    ),
    item(
      {
        id: "upload-length-binding",
        reason:
          posture.captureRequireSizes !== true
            ? "no-sizes"
            : posture.blobStore?.startsWith("s3://") === true
              ? "enforced"
              : "directory-store",
      },
      posture.captureRequireSizes === true && posture.blobStore?.startsWith("s3://") === true,
      posture.captureRequireSizes === true
        ? posture.blobStore?.startsWith("s3://") === true
          ? "every capture upload is signed for its size, and the bucket enforces it"
          : "sizes are required, but a directory blob store cannot enforce them"
        : "capture uploads without a declared size are accepted",
      "set MEND_CAPTURE_REQUIRE_SIZES=true with an S3-compatible MEND_BLOB_STORE",
    ),
    item(
      { id: "daemon-declares-sizes", reason: "built-in" },
      true,
      "sealantd declares the length of every upload it asks a URL for (sealantd 0.16.0 or newer)",
      "",
    ),
    item(
      exposed.length === 0
        ? { id: "raw-service-ports", reason: "loopback" }
        : { id: "raw-service-ports", reason: "exposed", addresses: exposed },
      exposed.length === 0,
      exposed.length === 0
        ? "raw service listeners stay on loopback"
        : `raw service listeners on ${exposed.join(", ")}`,
      "unset MEND_SERVICE_HOSTS",
    ),
    item(
      { id: "operator-present", reason: "operators", count: posture.operatorCount ?? 0 },
      (posture.operatorCount ?? 0) > 0,
      `${posture.operatorCount ?? 0} operator account(s)`,
      "grant the operator role to an account",
    ),
  ];
};

/**
 * Why this combination must not start, or null when it may. An instance with no account yet does
 * not hold up its first start in `multi` for `operator-present`: the first account to register
 * becomes the operator. A fresh database already holds its first organization, so accounts are
 * what is counted. The item itself still reads open until then, which keeps a `public` exposure
 * refused while registration is open to whoever arrives first.
 */
export const tenancyRefusal = (
  mode: TenancyMode,
  counts: { readonly organizations: number; readonly accounts: number },
  gate: ReadonlyArray<GateOutcome>,
): string | null => {
  if (mode === "multi") {
    const failing = gate.filter(
      (outcome) => !outcome.ok && !(outcome.id === "operator-present" && counts.accounts === 0),
    );
    if (failing.length === 0) return null;
    return [
      "MEND_TENANCY=multi is refused: the multi mode gate",
      "(docs/adr/0003-organizations-and-tenancy.md, 'Multi mode gate') is not complete.",
      ...failing.map((outcome) => `\n  ${outcome.id}: ${outcome.detail} (${outcome.fix ?? ""})`),
      "\nOr run one organization: MEND_TENANCY=single (mend server setup --tenancy single).",
    ].join(" ");
  }
  if (counts.organizations > 1) {
    return `MEND_TENANCY=single is refused: ${counts.organizations} organizations exist on this instance.`;
  }
  return null;
};

/**
 * Reads `MEND_TENANCY` (default `single` when nothing sets it; `mend server setup` and the Nix
 * module declare `multi` on a fresh install) and refuses to build when the mode may not run against
 * this database. Provided beneath the server and workers, so nothing serves before it passes.
 */
export const TenancyConfigLive: Layer.Layer<
  TenancyConfig,
  TenancyRefused | Config.ConfigError,
  InstanceRolesRepo | OrganizationsRepo | UsersRepo
> = Layer.effect(
  TenancyConfig,
  Effect.gen(function* () {
    const mode = yield* Config.schema(TenancyMode, "MEND_TENANCY").pipe(
      Config.withDefault("single"),
    );
    const organizationCreation = yield* Config.schema(
      OrganizationCreation,
      "MEND_ORGANIZATION_CREATION",
    ).pipe(Config.withDefault("operator" as const));
    const serviceHosts = yield* Config.String("MEND_SERVICE_HOSTS").pipe(
      Config.withDefault("127.0.0.1"),
    );
    const sourcePolicy = yield* Config.schema(
      Schema.Literals(["operator", "tenant"]),
      "MEND_SOURCE_POLICY",
    ).pipe(Config.withDefault("operator" as const));
    const transportBoundToOrigin = yield* Config.Boolean("MEND_GIT_TRANSPORT_BIND_ORIGIN").pipe(
      Config.withDefault(true),
    );
    const captureRequireSizes = yield* Config.Boolean("MEND_CAPTURE_REQUIRE_SIZES").pipe(
      Config.withDefault(false),
    );
    const blobStore = yield* Config.String("MEND_BLOB_STORE").pipe(Config.withDefault(""));
    const sessionStore = yield* Config.schema(
      Schema.Literals(["captured", "colocated"]),
      "MEND_SESSION_STORE",
    ).pipe(Config.withDefault("captured" as const));
    // As apps/api/src/exposure.ts reads it; only `public` changes what the gate asks.
    const publicExposure =
      (yield* Config.String("MEND_EXPOSURE").pipe(Config.withDefault(""))) === "public";
    const organizations = yield* OrganizationsRepo;
    const roles = yield* InstanceRolesRepo;
    const currentGate = roles.operatorCount().pipe(
      Effect.map((operatorCount) =>
        evaluateGate({
          serviceHosts,
          sourcePolicy,
          transportBoundToOrigin,
          captureRequireSizes,
          blobStore,
          sessionStore,
          publicExposure,
          operatorCount,
        }),
      ),
    );
    const gate = yield* currentGate;
    const counts = {
      organizations: yield* organizations.count(),
      accounts: yield* (yield* UsersRepo).count(),
    };
    const refusal = tenancyRefusal(mode, counts, gate);
    if (refusal !== null) return yield* new TenancyRefused({ message: refusal });
    yield* Effect.logInfo("tenancy").pipe(
      Effect.annotateLogs({
        mode,
        organizationCreation,
        gate: gate.every((outcome) => outcome.ok) ? "passed" : "not passed",
        failing: gate
          .filter((outcome) => !outcome.ok)
          .map((outcome) => outcome.id)
          .join(","),
      }),
    );
    return { mode, organizationCreation, gate: currentGate };
  }),
);
