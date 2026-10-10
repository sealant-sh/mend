import { createHmac } from "node:crypto";

/**
 * The id `/api/health` reports for this install: an HMAC of its Better Auth secret under a fixed
 * label. `mend server setup` derives it from the same secret (apps/cli `instanceIdOf`) to tell the
 * server it started from another Mend answering on the same port; the shared test vector keeps the
 * two derivations equal.
 */
export const instanceIdOf = (betterAuthSecret: string): string =>
  createHmac("sha256", betterAuthSecret).update("mend instance id").digest("hex").slice(0, 32);
