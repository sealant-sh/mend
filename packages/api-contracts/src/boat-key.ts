import { SessionRuntime } from "@mend/domain";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, PersonCredentialOnly } from "./common.ts";

/**
 * Boat keys. The organization's (SLNT-790): new Boat sessions in the organization run in, and are
 * billed to, the Boat account of the key an owner connected. A person's own (SLNT-797): the Boat
 * sessions they start in the organization run in their own Boat account instead. A launch takes
 * the person's key, else the organization's, else the server's. Sealant Core holds each key
 * sealed; Mend keeps which Core Boat account is whose, and no answer, error or audit entry here
 * ever carries a key. Members read whether the organization has one; only owners read its
 * details, connect, replace, check or remove it. Only the person reads or changes their own; an
 * owner sees that a member has one, never its details.
 */

/** The key was not sent, or Boat refused it; the message says why and what to do. */
export class BoatKeyRefused extends Schema.TaggedError<BoatKeyRefused>()(
  "BoatKeyRefused",
  {
    message: Schema.String,
    /**
     * `shape`: not a Boat key, nothing sent. `refused`: Boat said no. `unverified`: Boat did not
     * answer. `missing-permissions`: the key lacks Boat permissions Mend needs; the message names them.
     */
    reason: Schema.Literals(["shape", "refused", "unverified", "missing-permissions"]),
  },
  { httpApiStatus: 422 },
) {}

/**
 * Core refused the change because of what the Boat account holds now. The counts are Core's:
 * `liveRuns` VMs Boat may still hold, `buildsInFlight` image builds, `unseen` VMs or saved images
 * the new key cannot see.
 */
export class BoatKeyConflict extends Schema.TaggedError<BoatKeyConflict>()(
  "BoatKeyConflict",
  {
    message: Schema.String,
    reason: Schema.Literals(["in-use", "cannot-see", "removing", "changed", "taken"]),
    liveRuns: Schema.NullOr(Schema.Number),
    buildsInFlight: Schema.NullOr(Schema.Number),
    unseen: Schema.NullOr(Schema.Number),
  },
  { httpApiStatus: 409 },
) {}

/** A member asked to change or check the key: only owners do. */
export class BoatKeyOwnersOnly extends Schema.TaggedError<BoatKeyOwnersOnly>()(
  "BoatKeyOwnersOnly",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** This server's Sealant serves no Boat, or could not be reached; nothing changed. */
export class BoatUnavailable extends Schema.TaggedError<BoatUnavailable>()(
  "BoatUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/**
 * A fact about the key Boat did not let Sealant observe, and why. `refused`: Boat refused the
 * read (an organization key is refused Boat's key list). `no-answer`: Boat did not answer.
 * `not-listed`: Boat's key list did not include this key, or included more than one that could be
 * it. `unreadable`: Boat answered with something Sealant could not read. Never shown as fine.
 */
export const BoatKeyNotObserved = Schema.Struct({
  observed: Schema.Literal(false),
  reason: Schema.Literals(["refused", "no-answer", "not-listed", "unreadable"]),
  /** What Boat itself said, when it answered: its error code, status and message. */
  boat: Schema.NullOr(
    Schema.Struct({
      code: Schema.NullOr(Schema.String),
      status: Schema.NullOr(Schema.Number),
      message: Schema.NullOr(Schema.String),
    }),
  ),
});
export type BoatKeyNotObserved = typeof BoatKeyNotObserved.Type;

const observedOr = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([Schema.Struct({ observed: Schema.Literal(true), ...fields }), BoatKeyNotObserved]);

/**
 * What Sealant last observed of a Boat key, from Boat's own answers, at `observedAt`: Core's
 * `BoatKeyReport` (SLNT-781) field for field, with Mend's dates and nulls. Each fact is observed
 * with its value, or not observed with why. The page judges missing permissions by comparing
 * `permissions.held` with `BOAT_KEY_REQUIRED_PERMISSIONS`, the list its create-key command shows.
 */
export const BoatKeyReport = Schema.Struct({
  observedAt: Schema.Date,
  /** The Boat organization every request for the account names, or null when none is named. */
  organization: Schema.NullOr(Schema.String),
  /** Who the key is (Boat's `GET /me`). `accountId` is Boat's account id, not a person. */
  identity: observedOr({
    accountId: Schema.NullOr(Schema.String),
    login: Schema.NullOr(Schema.String),
    displayName: Schema.NullOr(Schema.String),
    serviceAccount: Schema.NullOr(Schema.Boolean),
    accountStatus: Schema.Literals(["active", "suspended", "closed", "unknown"]),
  }),
  /** A personal (account) key, or a Boat organization's key. */
  keyKind: observedOr({ kind: Schema.Literals(["personal", "organization"]) }),
  /** Which wallet a VM started with the key bills (`GET /limits`). */
  wallet: observedOr({
    kind: Schema.Literals(["personal", "organization"]),
    organizationId: Schema.NullOr(Schema.String),
    organizationName: Schema.NullOr(Schema.String),
    role: Schema.NullOr(Schema.String),
  }),
  /** The permissions Core needs of every key, as Core lists them. */
  requiredPermissions: Schema.Array(Schema.String),
  /** The key's permissions (`GET /api-keys`), and which of Core's required ones it lacks. */
  permissions: observedOr({
    held: Schema.Array(Schema.String),
    missing: Schema.Array(Schema.String),
    /** The key is limited to some VMs or environments, so it cannot reach the VMs Sealant makes. */
    limitedToSandboxes: Schema.Boolean,
  }),
  /** When the key expires; `expiresAt` null: it never does. */
  expiry: observedOr({
    expiresAt: Schema.NullOr(Schema.Date),
    expired: Schema.Boolean,
    /** Boat's own judgement that expiry is near; the page warns from fourteen days either way. */
    expiringSoon: Schema.Boolean,
  }),
  /** Whether the wallet can start a VM now, Boat's reason when it cannot, and its VM counts. */
  start: observedOr({
    canStart: Schema.Boolean,
    blockedReason: Schema.NullOr(Schema.String),
    billingStatus: Schema.NullOr(Schema.String),
    runningVms: Schema.Number,
    allowedVms: Schema.Number,
  }),
  /** The wallet's saved snapshot slots (`GET /saved-snapshots`). */
  snapshots: observedOr({ used: Schema.Number, included: Schema.Number }),
});
export type BoatKeyReport = typeof BoatKeyReport.Type;

/** Who connected the key and when, and when it was last replaced. Owners only. */
export class BoatKeyDetails extends Schema.Class<BoatKeyDetails>("BoatKeyDetails")({
  /** Core's id for the Boat account that holds the key: what a launch names. */
  sealantBoatAccountId: Schema.String,
  connectedByUserId: Schema.String,
  /** The connecting account's name, null when it is gone. */
  connectedByName: Schema.NullOr(Schema.String),
  connectedAt: Schema.Date,
  keyReplacedAt: Schema.NullOr(Schema.Date),
  /**
   * What Sealant last observed of the key, without asking Boat again; null until this server's
   * Sealant returns a report. A server from before the report answers without the field.
   */
  report: Schema.NullOr(BoatKeyReport).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

/** What the removal this request made did first (SLNT-803). */
export class BoatKeyRemoval extends Schema.Class<BoatKeyRemoval>("BoatKeyRemoval")({
  /** Standby workspaces Mend stopped in the organization's Boat account before Core removed it. */
  standbysDrained: Schema.Number,
}) {}

/** A person in the organization whose own Boat key decides their Boat sessions. */
export class BoatKeyPerson extends Schema.Class<BoatKeyPerson>("BoatKeyPerson")({
  userId: Schema.String,
  /** Their name as the instance knows it; null when the account is gone. */
  name: Schema.NullOr(Schema.String),
}) {}

export class BoatKeyStatus extends Schema.Class<BoatKeyStatus>("BoatKeyStatus")({
  connected: Schema.Boolean,
  /**
   * Where this organization's new sessions run: the key is used only for Boat sessions. Null:
   * Core picks.
   */
  sessionRuntime: Schema.NullOr(SessionRuntime),
  /** Null for members, and when no key is connected. */
  details: Schema.NullOr(BoatKeyDetails),
  /**
   * The members whose own Boat key decides their Boat sessions here, so the organization's code
   * runs in their Boat accounts (SLNT-797). Owners only: null for members, and from older servers.
   */
  peopleWithOwnKeys: Schema.NullOr(Schema.Array(BoatKeyPerson)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * Only on the answer to a removal this request made. Absent when there was no key to remove,
   * including when another request removed it at the same moment.
   */
  removal: Schema.optionalKey(BoatKeyRemoval),
}) {}

/**
 * The caller's own Boat key in their active organization (SLNT-797). Only they read it; the
 * details are always theirs to see.
 */
export class PersonBoatKeyStatus extends Schema.Class<PersonBoatKeyStatus>("PersonBoatKeyStatus")({
  /** The organization the key applies to: the caller's active one. */
  organizationName: Schema.String,
  connected: Schema.Boolean,
  /** Where the organization's new sessions run: the key is used only for Boat sessions. */
  sessionRuntime: Schema.NullOr(SessionRuntime),
  /** Whether the organization has its own key: what the person's sessions use without theirs. */
  organizationKey: Schema.Boolean,
  /** Null when no key is connected. */
  details: Schema.NullOr(BoatKeyDetails),
  /** As on `BoatKeyStatus`: only on the answer to a removal this request made. */
  removal: Schema.optionalKey(BoatKeyRemoval),
}) {}

/** What Core said of the organization's Boat account when it was asked, and when. */
export class BoatKeyCheck extends Schema.Class<BoatKeyCheck>("BoatKeyCheck")({
  /**
   * `active`: Core holds the key and sessions may run in its account. `removing`: its removal was
   * asked. `missing`: Core no longer lists the account Mend recorded. `none`: no key is connected.
   */
  state: Schema.Literals(["active", "removing", "missing", "none"]),
  observedAt: Schema.Date,
  keyReplacedAt: Schema.NullOr(Schema.Date),
  /**
   * Boat's own report about the key (who it is, the wallet it bills, permissions, expiry, whether
   * it can start a VM), observed by this check, once this server's Sealant returns one (SLNT-781).
   * Null until then.
   */
  report: Schema.NullOr(BoatKeyReport),
}) {}

export const ConnectBoatKeyRequest = Schema.Struct({
  /** The Boat key, exactly as Boat showed it. Checked by Boat before Core keeps it. */
  key: Schema.String,
});

export const boatKeyGroup = HttpApiGroup.make("boatKey")
  .add(
    HttpApiEndpoint.get("status", "/organization/boat-key", {
      success: BoatKeyStatus,
      error: NotFound,
    }),
  )
  .add(
    // Connects the organization's key, or replaces it when there is one.
    HttpApiEndpoint.put("connect", "/organization/boat-key", {
      payload: ConnectBoatKeyRequest,
      success: BoatKeyStatus,
      error: [NotFound, BoatKeyOwnersOnly, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("check", "/organization/boat-key/check", {
      success: BoatKeyCheck,
      error: [NotFound, BoatKeyOwnersOnly, BoatUnavailable],
    }),
  )
  .add(
    // New Boat sessions go back to the server's key. Mend first drains the standbys it started in
    // the account; refused while the account still holds a session's VM or an image build.
    HttpApiEndpoint.delete("disconnect", "/organization/boat-key", {
      success: BoatKeyStatus,
      error: [NotFound, BoatKeyOwnersOnly, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }),
  )
  .middleware(AuthMiddleware);

/**
 * The caller's own Boat key in their active organization (SLNT-797): the same reads and changes as
 * the organization's, on the caller's row alone. Connecting and removing it are refused to an
 * access key, which never manages credentials.
 */
export const personBoatKeyGroup = HttpApiGroup.make("personBoatKey")
  .add(
    HttpApiEndpoint.get("status", "/me/boat-key", {
      success: PersonBoatKeyStatus,
      error: NotFound,
    }),
  )
  .add(
    // Connects the person's key, or replaces it when there is one.
    HttpApiEndpoint.put("connect", "/me/boat-key", {
      payload: ConnectBoatKeyRequest,
      success: PersonBoatKeyStatus,
      error: [NotFound, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }).middleware(PersonCredentialOnly),
  )
  .add(
    HttpApiEndpoint.post("check", "/me/boat-key/check", {
      success: BoatKeyCheck,
      error: [NotFound, BoatUnavailable],
    }),
  )
  .add(
    // The person's Boat sessions go back to the organization's key, or the server's. Mend first
    // drains any standby it started in the account; refused while a session's VM holds it.
    HttpApiEndpoint.delete("disconnect", "/me/boat-key", {
      success: PersonBoatKeyStatus,
      error: [NotFound, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }).middleware(PersonCredentialOnly),
  )
  .middleware(AuthMiddleware);
