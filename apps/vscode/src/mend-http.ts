import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { finished as streamFinished } from "node:stream/promises";

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
    /** The refusal's `_tag`, for code that branches on what the server said. */
    readonly tag: string | null = null,
    /** The base a session create named that the store does not know (`StoreFailure.unknownBase`). */
    readonly unknownBase: string | null = null,
    readonly body: unknown = null,
    readonly retryAfterSeconds: number | null = null,
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
  options: { readonly logFailure?: boolean } = {},
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
    if (options.logFailure !== false)
      console.warn(failureLogLine(`${method} /api${requestPath}`, response.status, body));
    const failure = failureWords(response.status, body);
    const unknownBase: unknown =
      typeof body === "object" && body !== null ? Reflect.get(body, "unknownBase") : null;
    throw new MendApiError(
      failure.words,
      response.status,
      failure.tag,
      typeof unknownBase === "string" ? unknownBase : null,
      body,
      response.headers.has("retry-after") ? Number(response.headers.get("retry-after")) : null,
    );
  }
  return body;
};

export interface BundleAnswer {
  readonly status: number | null;
  readonly body: unknown;
  readonly retryAfterSeconds: number | null;
}

export const uploadMendBundle = async (
  connection: MendConnection,
  requestPath: string,
  bundle: import("./handoff-worker.js").HandoffBundle,
  finished: () => void,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<BundleAnswer> => {
  const url = new URL(`${connection.url}/api${requestPath}`);
  const outcome = Promise.withResolvers<BundleAnswer>();
  const input = bundle.open();
  const released = streamFinished(input, { cleanup: true }).catch(() => undefined);
  let settled = false;
  const end = (answer: BundleAnswer) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    input.destroy();
    request.destroy();
    void released.then(() => outcome.resolve(answer));
  };
  const noAnswer = () => end({ status: null, body: null, retryAfterSeconds: null });
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-git-bundle",
        "content-length": bundle.bytes,
        ...(connection.token === null ? {} : { authorization: `Bearer ${connection.token}` }),
      },
    },
    (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          response.destroy();
          noAnswer();
        } else chunks.push(chunk);
      });
      response.on("error", noAnswer);
      response.on("aborted", noAnswer);
      response.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        const retry = Number(response.headers["retry-after"]);
        end({
          status: response.statusCode ?? null,
          body,
          retryAfterSeconds: Number.isFinite(retry) && retry >= 0 ? retry : null,
        });
      });
    },
  );
  const timer = setTimeout(noAnswer, timeoutMs);
  request.once("error", noAnswer);
  request.once("finish", finished);
  input.once("error", noAnswer);
  input.pipe(request);
  return outcome.promise;
};
