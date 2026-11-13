import { SessionRuntime } from "@mend/domain";
import {
  BoatKeyProof,
  BoatKeyReport,
  BoatUnreachable,
  ServerBoatKey,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, PersonCredentialOnly } from "./common.ts";

/**
 * Boat keys. The organization's (SLNT-790): new Boat sessions in the organization run in, and are
 * billed to, the Boat account of the key an owner connected. A person's own (SLNT-797): the Boat
 * sessions they start in the organization run in their own Boat account instead. A launch takes
 * the person's key, else the organization's, else the server's. sealant holds each key
 * sealed; Mend keeps which sealant Boat account is whose, and no answer, error or audit entry here
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
     * `wallet`: a wallet the key's Boat account cannot bill was chosen (SLNT-821).
     */
    reason: Schema.Literals(["shape", "refused", "unverified", "missing-permissions", "wallet"]),
  },
  { httpApiStatus: 422 },
) {}

/**
 * sealant refused the change because of what the Boat account holds now. The counts are sealant's:
 * `liveRuns` VMs Boat may still hold, `buildsInFlight` image builds, `unseen` VMs or saved images
 * the new key cannot see. `proof-running`: a full check of the key has not finished removing what
 * it made in Boat; the message names it. `none`: no key is connected to check.
 */
export class BoatKeyConflict extends Schema.TaggedError<BoatKeyConflict>()(
  "BoatKeyConflict",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "in-use",
      "cannot-see",
      "removing",
      "changed",
      "taken",
      "proof-running",
      "none",
      // A wallet was chosen for a Boat organization's key, which bills its organization only.
      "key-organization",
    ]),
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

export { BoatKeyNotObserved, BoatKeyProof, BoatKeyReport } from "@mend/domain/workbench";

/**
 * The key's full check (SLNT-784): the last one Sealant finished, which Sealant keeps on the
 * account, and the one running now, if this server started one.
 */
export class BoatKeyFullCheck extends Schema.Class<BoatKeyFullCheck>("BoatKeyFullCheck")({
  /** Each step of the last finished check, when it ran and what it left; null until one has. */
  last: Schema.NullOr(BoatKeyProof),
  /** When the check running now started; null when none is. Read the status again for its end. */
  runningSince: Schema.NullOr(Schema.Date),
}) {}

const NO_FULL_CHECK = new BoatKeyFullCheck({ last: null, runningSince: null });

/** Who connected the key and when, and when it was last replaced. Owners only. */
export class BoatKeyDetails extends Schema.Class<BoatKeyDetails>("BoatKeyDetails")({
  /** sealant's id for the Boat account that holds the key: what a launch names. */
  sealantBoatAccountId: Schema.String,
  connectedByUserId: Schema.String,
  /** The connecting account's name, null when it is gone. */
  connectedByName: Schema.NullOr(Schema.String),
  connectedAt: Schema.Date,
  keyReplacedAt: Schema.NullOr(Schema.Date),
  /**
   * What Sealant last observed of the key, without asking Boat again; null when Sealant has not
   * checked it, or could not be read. A server from before the report answers without the field.
   */
  report: Schema.NullOr(BoatKeyReport).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The key's full check. A server from before the full check answers without the field. */
  fullCheck: BoatKeyFullCheck.pipe(Schema.withDecodingDefaultKey(Effect.succeed(NO_FULL_CHECK))),
  /**
   * What the key's Boat account made before sealant recorded wallets and Boat now has in no wallet
   * the key can bill (sealant#641): kept, never used or removed by sealant. Null when there is
   * nothing, and from a server before it.
   */
  unreachable: Schema.NullOr(BoatUnreachable).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/** What the removal this request made did first (SLNT-803). */
export class BoatKeyRemoval extends Schema.Class<BoatKeyRemoval>("BoatKeyRemoval")({
  /** Standby workspaces Mend stopped in the organization's Boat account before sealant removed it. */
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
   * sealant picks.
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

/** What sealant said of the organization's Boat account when it was asked, and when. */
export class BoatKeyCheck extends Schema.Class<BoatKeyCheck>("BoatKeyCheck")({
  /**
   * `active`: sealant holds the key and sessions may run in its account. `removing`: its removal was
   * asked. `missing`: sealant no longer lists the account Mend recorded. `none`: no key is connected.
   */
  state: Schema.Literals(["active", "removing", "missing", "none"]),
  observedAt: Schema.Date,
  keyReplacedAt: Schema.NullOr(Schema.Date),
  /**
   * Boat's own report about the key (who it is, the wallet it bills, permissions, expiry, whether
   * it can start a VM), observed by this check, or the last one when Boat did not answer. Null when
   * Sealant has none.
   */
  report: Schema.NullOr(BoatKeyReport),
  /**
   * Why this check observed nothing new, as a sentence: Boat did not answer, or asked to wait.
   * `report` is then the last one Sealant observed. Null when Boat answered.
   */
  unanswered: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/**
 * The wallet a personal key bills from now on (SLNT-821): an id from the report's `wallets`, a
 * Boat organization's id or `personal`. It takes effect at once; what the key's account made stays
 * in the wallet it was made in.
 */
export const ChooseBoatWalletRequest = Schema.Struct({ wallet: Schema.NonEmptyString });

export const ConnectBoatKeyRequest = Schema.Struct({
  /** The Boat key, exactly as Boat showed it. Checked by Boat before sealant keeps it. */
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
    // A full check of the key: Sealant starts a throwaway VM in its Boat account, uses it as a
    // session would and deletes it. Answers within a few seconds: finished, or running since.
    HttpApiEndpoint.post("fullCheck", "/organization/boat-key/full-check", {
      success: BoatKeyFullCheck,
      error: [NotFound, BoatKeyOwnersOnly, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }),
  )
  .add(
    // Points the organization's personal key at another wallet its Boat account can bill, without
    // the key. Owners only.
    HttpApiEndpoint.put("chooseWallet", "/organization/boat-key/wallet", {
      payload: ChooseBoatWalletRequest,
      success: BoatKeyStatus,
      error: [NotFound, BoatKeyOwnersOnly, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
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
    // A full check of the person's own key (SLNT-784): a throwaway VM in their Boat account.
    HttpApiEndpoint.post("fullCheck", "/me/boat-key/full-check", {
      success: BoatKeyFullCheck,
      error: [NotFound, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
    }),
  )
  .add(
    // Points the person's own key at another wallet their Boat account can bill, without the key.
    HttpApiEndpoint.put("chooseWallet", "/me/boat-key/wallet", {
      payload: ChooseBoatWalletRequest,
      success: PersonBoatKeyStatus,
      error: [NotFound, BoatKeyRefused, BoatKeyConflict, BoatUnavailable],
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

/**
 * The server's own Boat key, checked on demand by its operator (SLNT-822): sealant asks Boat now
 * (read-only), and the machine view reads the answer afterwards. Anyone but an operator gets a 404.
 */
export const serverBoatKeyGroup = HttpApiGroup.make("serverBoatKey")
  .add(
    HttpApiEndpoint.post("check", "/machine/boat-key/check", {
      success: ServerBoatKey,
      error: [NotFound, BoatUnavailable],
    }),
  )
  .middleware(AuthMiddleware);
