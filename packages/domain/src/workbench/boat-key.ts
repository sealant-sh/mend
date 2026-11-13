import { Schema } from "effect";

import type { OrganizationId } from "../ids.ts";

/**
 * Whose Boat key a Boat launch spends. Sealant Core holds the key, sealed, as one of its Boat
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

/** What a Boat launch names: the Core account of the key that decided, null for the server's. */
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

/** What Core takes as a Boat key (`BoatSecret`): checked before anything is sent. */
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
 * The Boat permissions Sealant Core needs of every key it runs sessions on, from the Boat calls it
 * makes. Boat's `ci` preset is not enough: its `sandbox.delete-own` does not satisfy
 * `sandbox.delete`. The one list the page's command and its missing-permissions comparison read.
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
] as const;

/**
 * What the key Mend asks people to create holds: the required permissions, and `account.read`,
 * which lets Mend read the wallet the key bills, its limits and the key's own permissions and
 * expiry.
 */
export const BOAT_KEY_COMMAND_PERMISSIONS = [
  ...BOAT_KEY_REQUIRED_PERMISSIONS,
  "account.read",
] as const;

/** The longest a Boat key may live; Boat's default is ninety days. */
export const BOAT_KEY_LIFETIME = "365d";

/**
 * The Boat CLI command that creates a key Mend can use. `organization`: the Boat organization the
 * key is for (its name, or a placeholder to replace); null makes a key for a personal account.
 * That form names `personal` too: without `--org`, Boat makes an organization's key whenever the
 * person's Boat CLI has an organization as its active wallet.
 */
export const boatKeyCreateCommand = (organization: string | null): string =>
  [
    "boat",
    "--org",
    organization ?? "personal",
    "api-key create mend",
    `--ttl ${BOAT_KEY_LIFETIME}`,
    `--actions ${BOAT_KEY_COMMAND_PERMISSIONS.join(",")}`,
  ].join(" ");

/** The required permissions a key does not hold, in the list's order. `*` holds every one. */
export const missingBoatKeyPermissions = (
  held: ReadonlyArray<string>,
): ReadonlyArray<(typeof BOAT_KEY_REQUIRED_PERMISSIONS)[number]> =>
  held.includes("*")
    ? []
    : BOAT_KEY_REQUIRED_PERMISSIONS.filter((permission) => !held.includes(permission));
