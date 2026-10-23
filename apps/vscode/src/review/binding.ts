import type { HeldConnection, MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import type { SessionDetail } from "../types.js";
import type { ReviewPlace } from "./kept-reviews.js";

/** Who VS Code is signed in as, read through one exact connection. */
export interface AccountReads {
  connection(): Promise<MendConnection>;
  held(): Promise<HeldConnection>;
  /**
   * The account `connection`'s token belongs to; null when Mend could not say. Throws Mend's
   * refusal (401) when it refused the token: VS Code is signed out.
   */
  accountOf(connection: MendConnection): Promise<string | null>;
}

/** The session reads a send's drive makes, the paste's among them. */
export interface SessionReads {
  sessionDetail(sessionId: string): Promise<SessionDetail>;
}

/** What a send's drive reads of Mend beside the review: each read can be bound to the send. */
export interface DriverReads extends AccountReads, SessionReads {
  /** The same reads, each made on the connection `connect` gives, or refused when it throws. */
  pinned(connect: () => Promise<MendConnection>): SessionReads;
}

/**
 * VS Code's connection is not the send's: another server or account (`switched`), no sign-in Mend
 * takes (`signed-out`), or Mend could not say whose sign-in it is (`unknown`), which never counts
 * as hers.
 */
export class Unbound extends Error {
  constructor(readonly why: "switched" | "signed-out" | "unknown") {
    super(
      why === "switched"
        ? "VS Code is connected to another Mend server or account than this review's"
        : why === "signed-out"
          ? "VS Code is signed out of Mend"
          : "Mend could not say which account VS Code is signed in as",
    );
  }
}

export type Bound = HeldConnection;

/**
 * VS Code's connection now, while it is the server and account `place` belongs to; throws
 * `Unbound` otherwise. A new sign-in of the same account is the same account.
 */
export const boundConnection = async (
  reads: AccountReads,
  place: Pick<ReviewPlace, "url" | "viewer">,
): Promise<Bound> => {
  const bound = await reads.held();
  const { connection } = bound;
  if (connection.url !== place.url) throw new Unbound("switched");
  const account = await reads.accountOf(connection).catch((cause: unknown) => {
    throw cause instanceof MendApiError && cause.status === 401 ? new Unbound("signed-out") : cause;
  });
  if (account === null) throw new Unbound("unknown");
  if (account !== place.viewer) throw new Unbound("switched");
  return bound;
};

export const unboundSince = async (bind: () => Promise<Bound>): Promise<Unbound> => {
  try {
    await bind();
  } catch (cause) {
    if (cause instanceof Unbound) return cause;
    throw cause;
  }
  return new Unbound("switched");
};
