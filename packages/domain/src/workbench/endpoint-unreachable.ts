import { Schema } from "effect";

/**
 * Why a harness could not connect, as its adapter read the harness's own report (ADR 0018,
 * decision 11). Codex says only that the connection failed, so it is `connection-failed`.
 */
export const UnreachableCause = Schema.Literals([
  "connection-refused",
  "host-not-found",
  "timed-out",
  "connection-failed",
]);
export type UnreachableCause = typeof UnreachableCause.Type;

const CAUSE_WORDS: Readonly<Record<UnreachableCause, string>> = {
  "connection-refused": "connection refused",
  "host-not-found": "host not found",
  "timed-out": "timed out",
  "connection-failed": "connection failed",
};

/**
 * What Mend observed when a turn on a login with an endpoint could not connect. `host` is the
 * endpoint's host for the person who added the login, null for everyone else; `observedAt` is the
 * time the turn ended, as the reader's clock writes it (`21:40`). It says where the connection was
 * tried from and never judges the endpoint.
 */
export const endpointUnreachableWords = (
  cause: UnreachableCause,
  host: string | null,
  observedAt: string,
): string =>
  host === null
    ? `Could not reach this login's endpoint from the session's workspace (${CAUSE_WORDS[cause]}) · observed ${observedAt}`
    : `Could not reach ${host} from this session's workspace (${CAUSE_WORDS[cause]}) · observed ${observedAt}`;
