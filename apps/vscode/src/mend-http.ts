import type { MendConnection } from "./config.js";
import { failureLogLine, failureWords } from "./failure-words.js";

/**
 * Why a request never reached Mend. Node's fetch says only "fetch failed"; the reason that helps on
 * another network (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH, a self-signed certificate) is its cause.
 */
export const transportReason = (cause: unknown): string => {
  if (!(cause instanceof Error)) return "";
  const inner = cause.cause;
  return ` ${inner instanceof Error ? inner.message : cause.message}`;
};

/** An explicit Mend discovery or API failure suitable for display by the extension. */
export class MendApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "MendApiError";
  }
}

/**
 * How long one read may take. A server on another machine can vanish without a word (a Mac mini
 * asleep, a laptop off the network): the read then fails with the reason instead of hanging.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a change may take. Creating or resuming a session waits on the server's own work (a
 * worktree, a workspace image, a predecessor's save) and answers in tens of seconds or more; cut
 * short, it would read as failed while it goes on.
 */
export const MUTATION_TIMEOUT_MS = 10 * 60_000;

/** Execute one authenticated Mend request without translating transport failures into local state. */
export const requestMend = async (
  connection: MendConnection,
  requestPath: string,
  init?: RequestInit,
): Promise<unknown> => {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (connection.token !== null) headers.set("authorization", `Bearer ${connection.token}`);
  const method = (init?.method ?? "GET").toUpperCase();
  const timeoutMs = method === "GET" ? REQUEST_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${connection.url}/api${requestPath}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new MendApiError(
        `Mend at ${connection.url} did not answer within ${timeoutMs / 1000} s.`,
        null,
      );
    }
    throw new MendApiError(
      `Cannot reach Mend at ${connection.url}.${transportReason(cause)}`,
      null,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    console.warn(failureLogLine(`${method} /api${requestPath}`, response.status, body));
    throw new MendApiError(failureWords(response.status, body).words, response.status);
  }
  return body;
};
