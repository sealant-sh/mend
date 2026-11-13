import { SessionRuntime } from "@mend/domain";
import { BoatKeyProof, BoatKeyReport } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * The organization's Boat key (SLNT-790): new Boat sessions in the organization run in, and are
 * billed to, the Boat account of the key an owner connected; without one they use the server's.
 * Sealant Core holds the key sealed. Mend keeps which Core Boat account is the organization's, and
 * no answer, error or audit entry here ever carries the key. Members read whether there is one;
 * only owners read the details, connect, replace, check or remove it.
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
  /** Core's id for the Boat account that holds the key: what a launch names. */
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
}) {}

/** What the removal this request made did first (SLNT-803). */
export class BoatKeyRemoval extends Schema.Class<BoatKeyRemoval>("BoatKeyRemoval")({
  /** Standby workspaces Mend stopped in the organization's Boat account before Core removed it. */
  standbysDrained: Schema.Number,
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
   * Only on the answer to a removal this request made. Absent when there was no key to remove,
   * including when another request removed it at the same moment.
   */
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
    // A full check of the key: Sealant starts a throwaway VM in its Boat account, uses it as a
    // session would and deletes it. Answers within a few seconds: finished, or running since.
    HttpApiEndpoint.post("fullCheck", "/organization/boat-key/full-check", {
      success: BoatKeyFullCheck,
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
