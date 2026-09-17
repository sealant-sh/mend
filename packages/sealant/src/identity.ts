import type { Effect } from "effect";
import * as Context from "effect/Context";

/** A Mend account as the identity mapping needs it. */
export interface MendUserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * The Mend user ↔ Sealant user mapping (docs/SEALANT-IDENTITY.md). The live
 * implementation is the database (`user_sealant_identities`); this contract
 * keeps the platform package free of the schema.
 */
export class SealantIdentityStore extends Context.Service<
  SealantIdentityStore,
  {
    /** The Mend account, or null when the id no longer exists. */
    readonly user: (userId: string) => Effect.Effect<MendUserRecord | null>;
    /** The recorded Sealant user id for a Mend user, or null before first use. */
    readonly sealantUserId: (userId: string) => Effect.Effect<string | null>;
    /** Record the mapping once Sealant has provisioned the user (idempotent). */
    readonly record: (userId: string, sealantUserId: string) => Effect.Effect<void>;
  }
>()("@mend/sealant/SealantIdentityStore") {}
