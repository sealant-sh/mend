import { BOAT_KEY_PROOF_STEPS } from "@sealant/api-contracts";
import { Effect, Schema } from "effect";

import type { OrganizationId } from "../ids.ts";
import { BoatFailure } from "./boat-failure.ts";

/**
 * Whose Boat key a Boat launch spends. sealant holds the key, sealed, as one of its Boat
 * accounts; Mend keeps only which owner that account belongs to: an organization (SLNT-790), or
 * one person in one organization (SLNT-797). A launch takes the person's key over the
 * organization's, and the organization's over the server's.
 */
export type BoatKeyOwner =
  | { readonly kind: "organization"; readonly organizationId: OrganizationId }
  | {
      readonly kind: "person";
      readonly organizationId: OrganizationId;
      readonly userId: string;
    };

/**
 * Which key a Boat workspace was created on: its session owner's own key in the organization, the
 * organization's, or the server's. Recorded with the workspace and never rewritten.
 */
export const BoatKeyChoice = Schema.Literals(["person", "organization", "server"]);
export type BoatKeyChoice = typeof BoatKeyChoice.Type;

/** What a Boat launch names: the sealant account of the key that decided, null for the server's. */
export type BoatLaunchKey =
  | {
      readonly decidedBy: "person" | "organization";
      readonly sealantBoatAccountId: string;
    }
  | { readonly decidedBy: "server"; readonly sealantBoatAccountId: null };

/**
 * Which key a Boat session runs on, in the few words every client shows beside it. `ownersKey`
 * names whose own key a person's is from where the reader stands: "your", "Carol's".
 */
export const boatKeyLine = (choice: BoatKeyChoice, ownersKey = "its owner's"): string => {
  switch (choice) {
    case "person":
      return `Boat · ${ownersKey} own Boat key`;
    case "organization":
      return "Boat · the organization's Boat key";
    case "server":
      return "Boat · the server's Boat key";
  }
};

/** What sealant takes as a Boat key (`BoatSecret`): checked before anything is sent. */
const BOAT_KEY_SHAPE = /^[A-Za-z0-9._~-]{16,4096}$/;

/**
 * Why a pasted Boat key cannot be one, or null when it can. The key is trimmed first, since a
 * copied key often carries a newline. The words never repeat the key.
 */
export const boatKeyShapeProblem = (key: string): string | null =>
  BOAT_KEY_SHAPE.test(key.trim())
    ? null
    : "That is not a Boat key. A Boat key is the boat_… value Boat shows once when you create the key: at least 16 letters, digits and . _ ~ - with no spaces. Nothing was sent.";

/**
 * The Boat permissions sealant needs of every key it runs sessions on, from the Boat calls it
 * makes: the one list the create-key command on the page and in the CLI asks for, the
 * missing-permissions comparison reads and the guide prints. Boat's `ci` preset is not enough: its
 * `sandbox.delete-own` does not satisfy `sandbox.delete`. `account.read` lets sealant read which
 * wallet the key bills, the wallets its Boat account can bill, its limits and the key's own
 * permissions and expiry; without it sealant cannot pin the key to a wallet, so nothing new starts
 * with it (sealant#641).
 */
export const BOAT_KEY_REQUIRED_PERMISSIONS = [
  "exec",
  "file.write",
  "host",
  "sandbox.create",
  "sandbox.delete",
  "sandbox.read",
  "sandbox.resume",
  "sandbox.stop",
  "snapshot.read",
  "snapshot.write",
  "account.read",
] as const;

/** The longest a Boat key may live; Boat's default is ninety days. */
export const BOAT_KEY_LIFETIME = "365d";

/**
 * The Boat CLI command that creates a key Mend can use. `organization`: the Boat organization the
 * key is for (its name, or a placeholder to replace); null makes a key for the personal account.
 * The personal form names `--org personal` too: without it the Boat CLI makes the key for its
 * active wallet, which is an organization once `boat org switch` chose one.
 */
export const boatKeyCreateCommand = (organization: string | null): string =>
  [
    "boat",
    "--org",
    organization ?? "personal",
    "api-key create mend",
    `--ttl ${BOAT_KEY_LIFETIME}`,
    `--actions ${BOAT_KEY_REQUIRED_PERMISSIONS.join(",")}`,
  ].join(" ");

/**
 * The required permissions a key does not hold. `required` is what sealant needs (its report's
 * `requiredPermissions`); Mend's own list is always added, so the page never judges a key by less
 * than the command asks for. `*` holds every one.
 */
export const missingBoatKeyPermissions = (
  held: ReadonlyArray<string>,
  required: ReadonlyArray<string> = BOAT_KEY_REQUIRED_PERMISSIONS,
): ReadonlyArray<string> => {
  if (held.includes("*")) return [];
  const needed = [...new Set([...BOAT_KEY_REQUIRED_PERMISSIONS, ...required])];
  return needed.filter((permission) => !held.includes(permission));
};

const COMMAND_PERMISSIONS: ReadonlySet<string> = new Set(BOAT_KEY_REQUIRED_PERMISSIONS);

/** Permissions sealant needs that the command on the page does not ask for: empty while they agree. */
export const permissionsTheCommandLacks = (
  required: ReadonlyArray<string>,
): ReadonlyArray<string> => required.filter((permission) => !COMMAND_PERMISSIONS.has(permission));

/**
 * A fact about the key Boat did not let Sealant observe, and why. `refused`: Boat refused the
 * read (an organization key is refused Boat's key list). `no-answer`: Boat did not answer.
 * `not-listed`: Boat's key list did not include this key, or included more than one that could be
 * it. `unreadable`: Boat answered with something Sealant could not read. Never shown as fine.
 */
export const BoatKeyNotObserved = Schema.Struct({
  observed: Schema.Literal(false),
  reason: Schema.Literals(["refused", "no-answer", "not-listed", "unreadable"]),
  /** What Boat itself said, when it answered: its reason, code, status and message. */
  boat: Schema.NullOr(BoatFailure),
});
export type BoatKeyNotObserved = typeof BoatKeyNotObserved.Type;

const observedOr = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([Schema.Struct({ observed: Schema.Literal(true), ...fields }), BoatKeyNotObserved]);

/** A Boat wallet: a person's own Boat account, or one of their Boat organizations. */
export const BoatWallet = Schema.Struct({
  kind: Schema.Literals(["personal", "organization"]),
  organizationId: Schema.NullOr(Schema.String),
  organizationName: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
});
export type BoatWallet = typeof BoatWallet.Type;

/**
 * One wallet a personal key's Boat account can bill (Boat's `GET /orgs`): its own (`personal`),
 * or a Boat organization it belongs to, with its role there. `id` is what a pin names: the
 * organization's id, or `personal`. `active`: the Boat account's active wallet now, which Boat
 * switches with `boat org switch`.
 */
export const BoatWalletChoice = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["personal", "organization"]),
  name: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
});
export type BoatWalletChoice = typeof BoatWalletChoice.Type;

/**
 * Whether the key's account names the wallet it bills (sealant#641). `pinned`: every request names
 * `organization` (a Boat organization's id, or `personal`), so the bill never follows the Boat
 * account's active wallet. `key-organization`: a Boat organization's key, which bills that
 * organization and nothing else. `active-wallet`: a personal key sealant has not pinned yet (one
 * connected before the upgrade that pins accounts), which bills whichever wallet its Boat account
 * has active; `walletChanged` says the wallet moved from `from`, first seen at `observedAt`.
 */
export const BoatKeyBilling = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("pinned"), organization: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("key-organization") }),
  Schema.Struct({
    mode: Schema.Literal("active-wallet"),
    walletChanged: Schema.NullOr(Schema.Struct({ from: BoatWallet, observedAt: Schema.Date })),
  }),
]);
export type BoatKeyBilling = typeof BoatKeyBilling.Type;

/**
 * What a key's account made in Boat before sealant recorded wallets, and that Boat now has in no
 * wallet the key can bill: deleted in Boat since, or in a Boat organization the account has left.
 * sealant keeps it recorded, never uses or removes it, and waits on it for nothing. Saved images
 * are named as Boat's Saved snapshots list shows them; runs and builds by sealant's ids.
 */
export const BoatUnreachable = Schema.Struct({
  savedImages: Schema.Array(Schema.String),
  runs: Schema.Array(Schema.String),
  builds: Schema.Array(Schema.String),
});
export type BoatUnreachable = typeof BoatUnreachable.Type;

/**
 * What Sealant last observed of a Boat key, from Boat's own answers, at `observedAt`: sealant's
 * `BoatKeyReport` (SLNT-781) field for field, with Mend's dates and nulls. Each fact is observed
 * with its value, or not observed with why. Missing permissions are sealant's `required` the key does
 * not hold, never fewer than `BOAT_KEY_REQUIRED_PERMISSIONS`, the list the create-key command shows.
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
  /**
   * The wallets the key's Boat account can bill, the active one marked (sealant#641). Null in a
   * report made before sealant read them, and from a server before it.
   */
  wallets: Schema.NullOr(observedOr({ choices: Schema.Array(BoatWalletChoice) })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Whether the wallet the key bills is fixed (`BoatKeyBilling`); null when sealant did not say. */
  billing: Schema.NullOr(BoatKeyBilling).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The permissions sealant needs of every key, as sealant lists them. */
  requiredPermissions: Schema.Array(Schema.String),
  /** The key's permissions (`GET /api-keys`), and which of sealant's required ones it lacks. */
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

/** The steps of a full check of a Boat key, in the order sealant takes them. */
export { BOAT_KEY_PROOF_STEPS };

/**
 * A full check of a Boat key (SLNT-784, sealant's `boatAccounts.prove`): sealant started the smallest VM
 * in the key's Boat account, ran a command, published a port and saved a snapshot, then deleted the
 * snapshot and the VM, and says how far it got. sealant keeps the last one on the account.
 */
export const BoatKeyProofStep = Schema.Struct({
  step: Schema.Literals(BOAT_KEY_PROOF_STEPS),
  /** `no-answer`: Boat did not answer, so the step may have happened. */
  outcome: Schema.Literals(["passed", "refused", "no-answer", "not-reached"]),
  /** Why Boat refused the step, or did not answer it, when sealant said. */
  boat: Schema.NullOr(BoatFailure),
});
export type BoatKeyProofStep = typeof BoatKeyProofStep.Type;

export const BoatKeyProof = Schema.Struct({
  proofId: Schema.String,
  startedAt: Schema.Date,
  finishedAt: Schema.Date,
  /** `interrupted`: the check stopped before it finished, and sealant's sweep removed what it made. */
  outcome: Schema.Literals(["passed", "refused", "interrupted"]),
  steps: Schema.Array(BoatKeyProofStep),
  /** VM starts it asked Boat for: 0 or 1. */
  starts: Schema.Number,
  /**
   * What Boat may still hold of it. `removalConfirmed` false: sealant's sweep keeps deleting `vm` (an
   * id; null when Boat never answered one) and `snapshot`, and the key is neither replaced nor
   * removed until it is done.
   */
  leftBehind: Schema.Struct({
    vm: Schema.NullOr(Schema.String),
    snapshot: Schema.NullOr(Schema.String),
    removalConfirmed: Schema.Boolean,
  }),
});
export type BoatKeyProof = typeof BoatKeyProof.Type;
