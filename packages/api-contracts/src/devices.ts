import { PublicOrigin } from "@mend/network";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RegisterDeviceRequest, RegisteredDevice } from "./github.ts";

export const devicesGroup = HttpApiGroup.make("devices")
  .add(
    HttpApiEndpoint.post("register", "/devices", {
      payload: RegisterDeviceRequest,
      success: RegisteredDevice,
    }),
  )
  .add(
    HttpApiEndpoint.delete("unregister", "/devices/:token", {
      params: { token: Schema.String },
    }),
  )
  .middleware(AuthMiddleware);

/** The platforms a paired device can report itself as. */
export const DEVICE_PLATFORMS = ["ios", "android", "web", "desktop", "other"] as const;

/** One device paired to the signed-in user. Revoked devices drop off the list. */
export class DeviceView extends Schema.Class<DeviceView>("DeviceView")({
  id: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
}) {}

/** What the owner types to mint a token by hand: what to call the device, and what it is. */
export class MintDeviceRequest extends Schema.Class<MintDeviceRequest>("MintDeviceRequest")({
  name: Schema.String,
  platform: Schema.Literals(DEVICE_PLATFORMS),
}) {}

/**
 * A token minted by hand, shown once, with the configured origins a device can
 * reach this machine at. Mend keeps only its sha256, like a claimed pairing.
 */
export class MintedDevice extends Schema.Class<MintedDevice>("MintedDevice")({
  token: Schema.String,
  urls: Schema.Array(PublicOrigin),
  device: DeviceView,
}) {}

/** A freshly minted pairing code plus the explicitly configured public origins. */
export class PairingView extends Schema.Class<PairingView>("PairingView")({
  code: Schema.String,
  expiresAt: Schema.String,
  urls: Schema.Array(PublicOrigin),
}) {}

/** What a phone sends to claim a code: the code as typed, and what to call the device. */
export class PairClaimRequest extends Schema.Class<PairClaimRequest>("PairClaimRequest")({
  code: Schema.String,
  name: Schema.String,
  platform: Schema.Literals(DEVICE_PLATFORMS),
}) {}

/** The claimed token, shown once. Mend keeps only its sha256. */
export class PairClaimResult extends Schema.Class<PairClaimResult>("PairClaimResult")({
  token: Schema.String,
  url: PublicOrigin,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
  }),
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
}) {}

/** No pairing code with that value. */
export class PairingCodeNotFound extends Schema.TaggedErrorClass<PairingCodeNotFound>()(
  "PairingCodeNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The code exists but is spent — past its expiry, or already claimed. */
export class PairingCodeSpent extends Schema.TaggedErrorClass<PairingCodeSpent>()(
  "PairingCodeSpent",
  {},
  { httpApiStatus: 410 },
) {}

/** Too many failed claims from one address. `/pair` is unauthenticated; this is its floor. */
export class PairingRateLimited extends Schema.TaggedErrorClass<PairingRateLimited>()(
  "PairingRateLimited",
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {}

// ─── CLI authorize: pairing with the direction reversed ─────────────────────
//
// `mend login` opens a request holding a secret device code, the browser
// approves it by the short user code, and the CLI's poll collects a device
// token. No password ever reaches a terminal; the token is the same
// revocable kind a paired phone holds.

/** What `mend login` sends to open a request: what to call this machine. */
export class CliAuthStartRequest extends Schema.Class<CliAuthStartRequest>("CliAuthStartRequest")({
  name: Schema.String,
}) {}

/**
 * The opened request. `deviceCode` is the CLI's secret — polling with it is
 * the only way to the token; `code` is what the human confirms in the
 * browser, reachable at `verifyPath` on whichever base URL the CLI called.
 */
export class CliAuthStartView extends Schema.Class<CliAuthStartView>("CliAuthStartView")({
  deviceCode: Schema.String,
  code: Schema.String,
  verifyPath: Schema.String,
  expiresAt: Schema.String,
  intervalSeconds: Schema.Int,
}) {}

/** The poll: the device code is a secret, so it travels as a body, never a URL. */
export class CliAuthPollRequest extends Schema.Class<CliAuthPollRequest>("CliAuthPollRequest")({
  deviceCode: Schema.String,
}) {}

/** Nobody has decided yet — keep polling at the stated interval. */
export class CliAuthPending extends Schema.Class<CliAuthPending>("CliAuthPending")({
  status: Schema.Literal("pending"),
}) {}

/** Approved and collected: the token, shown once. Mend keeps only its sha256. */
export class CliAuthApproved extends Schema.Class<CliAuthApproved>("CliAuthApproved")({
  status: Schema.Literal("approved"),
  token: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
  }),
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
}) {}

export const CliAuthPollView = Schema.Union([CliAuthPending, CliAuthApproved]);
export type CliAuthPollView = typeof CliAuthPollView.Type;

/** One request as the approve page sees it: what asked and when it stops mattering. */
export class CliAuthRequestView extends Schema.Class<CliAuthRequestView>("CliAuthRequestView")({
  code: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
}) {}

/** No authorize request with that code or device code. */
export class CliAuthNotFound extends Schema.TaggedErrorClass<CliAuthNotFound>()(
  "CliAuthNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The request exists but is spent — expired, already decided, or already collected. */
export class CliAuthSpent extends Schema.TaggedErrorClass<CliAuthSpent>()(
  "CliAuthSpent",
  {},
  { httpApiStatus: 410 },
) {}

/** A signed-in user looked at the request and said no. */
export class CliAuthDenied extends Schema.TaggedErrorClass<CliAuthDenied>()(
  "CliAuthDenied",
  {},
  { httpApiStatus: 403 },
) {}

/**
 * The signed-in user's paired devices, and the codes that mint them. A device
 * holds a bearer token of its own: revoking the device is what ends its access.
 */
export const userDevicesGroup = HttpApiGroup.make("userDevices")
  .add(HttpApiEndpoint.post("createPairing", "/me/devices/pairings", { success: PairingView }))
  .add(
    HttpApiEndpoint.post("create", "/me/devices", {
      payload: MintDeviceRequest,
      success: MintedDevice,
    }),
  )
  .add(HttpApiEndpoint.get("list", "/me/devices", { success: Schema.Array(DeviceView) }))
  .add(
    HttpApiEndpoint.delete("revoke", "/me/devices/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: DeviceView,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("cliAuthRequest", "/me/cli-auth/:code", {
      params: Schema.Struct({ code: Schema.String }),
      success: CliAuthRequestView,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [CliAuthNotFound, CliAuthSpent],
    }),
  )
  .add(
    HttpApiEndpoint.post("approveCliAuth", "/me/cli-auth/:code/approve", {
      params: Schema.Struct({ code: Schema.String }),
      success: CliAuthRequestView,
      error: [CliAuthNotFound, CliAuthSpent],
    }),
  )
  .add(
    HttpApiEndpoint.post("denyCliAuth", "/me/cli-auth/:code/deny", {
      params: Schema.Struct({ code: Schema.String }),
      success: CliAuthRequestView,
      error: [CliAuthNotFound, CliAuthSpent],
    }),
  )
  .middleware(AuthMiddleware);

/**
 * Claiming a pairing code. Unauthenticated by construction — the code is the
 * only credential the phone has, and it is single use.
 */
export const pairGroup = HttpApiGroup.make("pair").add(
  HttpApiEndpoint.post("claim", "/pair", {
    payload: PairClaimRequest,
    success: PairClaimResult,
    error: [PairingCodeNotFound, PairingCodeSpent, PairingRateLimited],
  }),
);

/**
 * The CLI's side of the authorize walk. Unauthenticated by construction — the
 * CLI has nothing yet; the device code it is handed here is its only
 * credential until a browser approval turns it into a token.
 */
export const cliAuthGroup = HttpApiGroup.make("cliAuth")
  .add(
    HttpApiEndpoint.post("start", "/cli/auth", {
      payload: CliAuthStartRequest,
      success: CliAuthStartView,
      error: [PairingRateLimited],
    }),
  )
  .add(
    HttpApiEndpoint.post("poll", "/cli/auth/token", {
      payload: CliAuthPollRequest,
      success: CliAuthPollView,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [CliAuthNotFound, CliAuthSpent, CliAuthDenied, PairingRateLimited],
    }),
  );
