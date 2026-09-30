/**
 * Why a call to the Mend server produced no answer, told apart because the words differ. Only a
 * connection that never opened means the server cannot be reached. A request the server accepted
 * and has not answered yet (fetch gives up on the headers after five minutes) is still being worked
 * on there, and a connection that closed mid-request says nothing about the server either: an edge
 * may have cut a long request while Mend kept going.
 */
export type NoAnswer = "unreachable" | "timeout" | "dropped";

/** A server call that ended without a usable answer, or with a refusal (`http`, with its status). */
export class MendRequestError extends Error {
  readonly kind: NoAnswer | "http";
  readonly status: number | null;
  constructor(kind: NoAnswer | "http", message: string, status: number | null = null) {
    super(message);
    this.name = "MendRequestError";
    this.kind = kind;
    this.status = status;
  }
}

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const DROPPED_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ECONNRESET",
  "EPIPE",
]);

const codeOf = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof value.code === "string" ? value.code : null;
};

const nameOf = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("name" in value)) return null;
  return typeof value.name === "string" ? value.name : null;
};

/** What a thrown `fetch` means: undici puts the reason on `cause`, an abort names itself. */
export const noAnswerOf = (error: unknown): NoAnswer => {
  const name = nameOf(error);
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : null;
  const code = codeOf(cause) ?? codeOf(error);
  if (code !== null && TIMEOUT_CODES.has(code)) return "timeout";
  if (code !== null && DROPPED_CODES.has(code)) return "dropped";
  return "unreachable";
};

/** Seconds as the CLI says them elsewhere: `42s`, `5 min`. */
export const spoken = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
};

/** The sentence for a call that got no answer. Only `unreachable` says the server cannot be reached. */
export const noAnswerMessage = (
  kind: NoAnswer,
  serverUrl: string,
  call: string,
  waitedMs: number,
): string => {
  if (kind === "unreachable")
    return `cannot reach the Mend server at ${serverUrl} — is it running?`;
  if (kind === "timeout") {
    return `${call} has had no answer from ${serverUrl} after ${spoken(waitedMs)} — the server accepted it and may still be working on it`;
  }
  return `the connection to ${serverUrl} closed before ${call} answered — the server may still be working on it`;
};

/** The same classification, as the error the CLI throws. */
export const noAnswerError = (
  error: unknown,
  serverUrl: string,
  call: string,
  waitedMs: number,
): MendRequestError => {
  const kind = noAnswerOf(error);
  return new MendRequestError(kind, noAnswerMessage(kind, serverUrl, call, waitedMs));
};

/**
 * Statuses an edge in front of Mend answers with when it gives up on a long request (Cloudflare's
 * 52x included). They say nothing about what Mend is doing, so they are not Mend's refusal.
 */
export const GATEWAY_STATUSES: ReadonlySet<number> = new Set([
  502, 503, 504, 520, 521, 522, 523, 524,
]);

/**
 * A call the server may still be working on: it timed out, the connection closed under it, or an
 * edge gave up on it. The work it started is not known to have failed.
 */
export const mayStillBeWorking = (error: unknown): boolean =>
  error instanceof MendRequestError &&
  (error.kind === "timeout" ||
    error.kind === "dropped" ||
    (error.kind === "http" && error.status !== null && GATEWAY_STATUSES.has(error.status)));
