import type { MendConnection } from "../config.js";
import type { ReviewPlace } from "./kept-reviews.js";

/** Who VS Code is signed in as, read through one exact connection. */
export interface AccountReads {
  connection(): Promise<MendConnection>;
  /** The account `connection`'s token belongs to; null when Mend could not say. */
  accountOf(connection: MendConnection): Promise<string | null>;
}

/**
 * VS Code's connection is not the send's: another server or account (`switched`), or Mend could
 * not say whose sign-in it is (`unknown`), which never counts as hers.
 */
export class Unbound extends Error {
  constructor(readonly why: "switched" | "unknown") {
    super(
      why === "switched"
        ? "VS Code is connected to another Mend server or account than this review's"
        : "Mend could not say which account VS Code is signed in as",
    );
  }
}

/**
 * VS Code's connection now, while it is the server and account `place` belongs to; throws
 * `Unbound` otherwise. A new sign-in of the same account is the same account.
 */
export const boundConnection = async (
  reads: AccountReads,
  place: Pick<ReviewPlace, "url" | "viewer">,
): Promise<MendConnection> => {
  const connection = await reads.connection();
  if (connection.url !== place.url) throw new Unbound("switched");
  const account = await reads.accountOf(connection);
  if (account === null) throw new Unbound("unknown");
  if (account !== place.viewer) throw new Unbound("switched");
  return connection;
};
