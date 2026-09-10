import { Timestamp } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware, HealthStatus } from "./common.ts";

/**
 * What the settings page shows: what was observed when Mend last talked to the
 * control plane — never a judgment about it.
 */
export const SealantConnectionStatus = Schema.Literals([
  "connected",
  "unauthorized",
  /** The control plane responded, but not with the SDK surface Mend speaks. */
  "mismatched",
  "unreachable",
]);
export type SealantConnectionStatus = typeof SealantConnectionStatus.Type;

export class SealantConnection extends Schema.Class<SealantConnection>("SealantConnection")({
  status: SealantConnectionStatus,
  baseUrl: Schema.String,
  /** The observed failure, verbatim, when not connected. */
  detail: Schema.NullOr(Schema.String),
  checkedAt: Timestamp,
}) {}

export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("status", "/health", { success: HealthStatus }),
);

/**
 * What a signed-out visitor may learn about this instance: whether any account exists.
 * A fresh install's first visit is the registration, so the login page asks this before it
 * decides which form to lead with. Nothing else about the instance is disclosed here.
 */
export class InstanceView extends Schema.Class<InstanceView>("InstanceView")({
  /** `none` until the first account is created. */
  users: Schema.Literals(["none", "some"]),
}) {}

export const instanceGroup = HttpApiGroup.make("instance").add(
  HttpApiEndpoint.get("get", "/instance", { success: InstanceView }),
);

/**
 * The machine Mend runs on, as the shell shows it: hostname · platform, and whether a
 * tailnet address is bound (plan §7.5 — the private-network promise made visible).
 * "reachable" is an observation about the interface, not a promise about routing.
 */
export class MachineView extends Schema.Class<MachineView>("MachineView")({
  hostname: Schema.String,
  platform: Schema.String,
  tailnet: Schema.Struct({
    status: Schema.Literals(["reachable", "not-detected"]),
    address: Schema.NullOr(Schema.String),
  }),
}) {}

export const machineGroup = HttpApiGroup.make("machine")
  .add(HttpApiEndpoint.get("get", "/machine", { success: MachineView }))
  .middleware(AuthMiddleware);

/** The settings page's connection check — reports what was observed, never a judgment. */
export const sealantGroup = HttpApiGroup.make("sealant")
  .add(HttpApiEndpoint.get("connection", "/sealant/connection", { success: SealantConnection }))
  .middleware(AuthMiddleware);

/** The platform refused the credential (format, a dead token, an unknown account). */
export class AccountRejected extends Schema.TaggedErrorClass<AccountRejected>()(
  "AccountRejected",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The platform could not be reached or answered outside its contract. */
export class SealantUnavailable extends Schema.TaggedErrorClass<SealantUnavailable>()(
  "SealantUnavailable",
  { code: Schema.String, message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** Connect coordinates for the platform's workspace SSH gateway (docs/WORKSPACE-SSH.md). */
export class WorkspaceSshGateway extends Schema.Class<WorkspaceSshGateway>("WorkspaceSshGateway")({
  host: Schema.String,
  port: Schema.Number,
  /** The SSH username is `<usernamePrefix>-<workspaceId>`. */
  usernamePrefix: Schema.String,
}) {}

/** One registered SSH public key — never carries the key material back. */
export class WorkspaceSshKey extends Schema.Class<WorkspaceSshKey>("WorkspaceSshKey")({
  sshKeyId: Schema.String,
  name: Schema.String,
  algorithm: Schema.String,
  fingerprint: Schema.String,
  createdAt: Schema.String,
}) {}

/** Everything a client needs to decide whether workspace SSH is ready for this user. */
export class WorkspaceSshView extends Schema.Class<WorkspaceSshView>("WorkspaceSshView")({
  /** Null when the deployment exposes no workspace SSH gateway. */
  gateway: Schema.NullOr(WorkspaceSshGateway),
  /** The signed-in user's registered keys. */
  keys: Schema.Array(WorkspaceSshKey),
}) {}

/** Offer the signed-in user's SSH public key; idempotent — re-offering returns the existing row. */
export class EnsureWorkspaceSshKeyRequest extends Schema.Class<EnsureWorkspaceSshKeyRequest>(
  "EnsureWorkspaceSshKeyRequest",
)({
  /** Raw `<algorithm> <base64> [comment]` line; normalized and fingerprinted platform-side. */
  publicKey: Schema.String,
  name: Schema.optionalKey(Schema.String),
}) {}

/**
 * Workspace SSH for the signed-in user: gateway discovery plus self-service key registration —
 * what the editor extension's one-time setup runs against (docs/WORKSPACE-SSH.md phase 1).
 */
export const workspaceSshGroup = HttpApiGroup.make("workspaceSsh")
  .add(
    HttpApiEndpoint.get("get", "/workspace-ssh", {
      success: WorkspaceSshView,
      error: [SealantUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("ensureKey", "/workspace-ssh/keys", {
      payload: EnsureWorkspaceSshKeyRequest,
      success: WorkspaceSshKey,
      error: [AccountRejected, SealantUnavailable],
    }),
  )
  .middleware(AuthMiddleware);

/**
 * The signed-in user's platform identity and connected accounts
 * (docs/SEALANT-IDENTITY.md). Secrets pass straight through to Sealant under
 * the user's own Sealant user; Mend never stores or echoes them.
 */
