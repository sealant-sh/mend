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
