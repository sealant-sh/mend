import type { OrganizationId } from "../ids.ts";

/**
 * Whose Boat key a Boat launch spends. Sealant Core holds the key, sealed, as one of its Boat
 * accounts; Mend keeps only which owner that account belongs to. Today the owner is an
 * organization (SLNT-790). A person's own key (SLNT-797) is the next kind of owner: a launch takes
 * the person's key over the organization's, and the organization's over the server's.
 */
export type BoatKeyOwner = {
  readonly kind: "organization";
  readonly organizationId: OrganizationId;
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
 */
export const boatKeyCreateCommand = (organization: string | null): string =>
  [
    "boat",
    ...(organization === null ? [] : ["--org", organization]),
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
