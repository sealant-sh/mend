import { failureLogLine, failureWords, NO_ANSWER } from "@/data/failure-words";
import type { Connection } from "@/data/pairing-config";
import { pairingKeyOf, serverUrlOf, type PairingKey } from "@/data/pairing-key";
import { heard, Unreachable } from "@/data/reachability";

/**
 * The server answered and said no (or did not answer: status 0). `message` is what a person reads
 * (`failureWords`): the server's own sentence when it gave one, else words for its tag or status.
 * The call and the status stay in the log.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The refusal's `_tag`, when the body carried one: for code that branches on it. */
    readonly tag: string | null = null,
    /** True when `message` is the server's own sentence; false for words Mend chose. */
    readonly serverWords: boolean = false,
  ) {
    super(message);
  }
}

export class PairingEnded extends Error {
  constructor() {
    super("The phone is no longer paired with the machine this was for.");
  }
}

/** A refusal as an `ApiError` in words, its call, status and tag logged. */
const refusal = (method: string, route: string, status: number, body: unknown): ApiError => {
  console.warn(failureLogLine(`${method} ${route}`, status, body));
  const failure = failureWords(status, body);
  return new ApiError(failure.words, status, failure.tag, failure.serverWords !== null);
};

type WriteMethod = "POST" | "PUT" | "DELETE";

/** An upload in flight: its answer, and a way to call it off. */
export interface Upload<T> {
  readonly result: Promise<T>;
  readonly abort: () => void;
}

export interface Machine {
  readonly key: PairingKey;
  readonly connection: { readonly url: string; readonly token: string };
  readonly read: <T>(route: string) => Promise<T>;
  /**
   * With `deadlineMs`, a write not answered in time is called off as one with no answer, and one
   * in flight when the pairing ends is called off with `PairingEnded`.
   */
  readonly write: <T>(
    method: WriteMethod,
    route: string,
    body?: unknown,
    deadlineMs?: number,
  ) => Promise<T>;
  readonly writeNoContent: (method: WriteMethod, route: string, body?: unknown) => Promise<void>;
  /**
   * POSTs over XMLHttpRequest, so a caller can show how much has gone up: fetch reports no upload
   * progress.
   */
  readonly upload: (
    route: string,
    body: unknown,
    onProgress?: (fraction: number) => void,
  ) => Upload<unknown>;
}

const parsedOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const openMachine = (
  pairing: Pick<Connection, "url" | "token">,
): { readonly machine: Machine; readonly end: () => void } => {
  const connection = { url: serverUrlOf(pairing.url), token: pairing.token.trim() };
  const key = pairingKeyOf(connection);
  const lifetime = new AbortController();
  const ended = lifetime.signal;
  const heardWhilePaired = (yes: boolean) => {
    if (!ended.aborted) heard(key, yes);
  };
  const address = (route: string) => `${connection.url}/api${route}`;
  const bearer = `Bearer ${connection.token}`;
  const noAddress = () => new ApiError("Set the server URL in Settings first.", 0);

  const send = async (
    method: "GET" | WriteMethod,
    route: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    if (connection.url === "") throw noAddress();
    const response = await fetch(address(route), {
      method,
      headers: { "content-type": "application/json", authorization: bearer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    }).catch((cause: unknown) => {
      heardWhilePaired(false);
      throw new Unreachable(NO_ANSWER, { cause });
    });
    heardWhilePaired(true);
    if (!response.ok) {
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        // Not JSON — words for the status stand.
      }
      throw refusal(method, route, response.status, parsed);
    }
    return response;
  };

  const write = async <T>(
    method: WriteMethod,
    route: string,
    body?: unknown,
    deadlineMs?: number,
  ): Promise<T> => {
    if (deadlineMs === undefined) return (await send(method, route, body, undefined)).json();
    if (ended.aborted) throw new PairingEnded();
    const call = new AbortController();
    const callOff = () => call.abort();
    const timer = setTimeout(callOff, deadlineMs);
    ended.addEventListener("abort", callOff);
    try {
      return await (await send(method, route, body, call.signal)).json();
    } catch (error) {
      throw ended.aborted ? new PairingEnded() : error;
    } finally {
      clearTimeout(timer);
      ended.removeEventListener("abort", callOff);
    }
  };

  const read = async <T>(route: string): Promise<T> => {
    if (ended.aborted) throw new PairingEnded();
    try {
      return await (await send("GET", route, undefined, ended)).json();
    } catch (error) {
      throw ended.aborted ? new PairingEnded() : error;
    }
  };

  const upload = (
    route: string,
    body: unknown,
    onProgress?: (fraction: number) => void,
  ): Upload<unknown> => {
    const request = new XMLHttpRequest();
    const callOff = () => request.abort();
    const result = new Promise<unknown>((resolve, reject) => {
      if (connection.url === "") {
        reject(noAddress());
        return;
      }
      if (ended.aborted) {
        reject(new PairingEnded());
        return;
      }
      request.open("POST", address(route));
      request.setRequestHeader("content-type", "application/json");
      request.setRequestHeader("authorization", bearer);
      request.timeout = 120_000;
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      });
      const settled = (then: () => void) => () => {
        ended.removeEventListener("abort", callOff);
        then();
      };
      request.addEventListener(
        "load",
        settled(() => {
          heardWhilePaired(true);
          const answer = parsedOrNull(request.responseText);
          if (request.status >= 200 && request.status < 300) resolve(answer);
          else reject(refusal("POST", route, request.status, answer));
        }),
      );
      request.addEventListener(
        "error",
        settled(() => {
          heardWhilePaired(false);
          reject(new ApiError("The upload did not reach the machine.", 0));
        }),
      );
      request.addEventListener(
        "timeout",
        settled(() => reject(new ApiError("The machine did not answer the upload in time.", 0))),
      );
      request.addEventListener(
        "abort",
        settled(() =>
          reject(ended.aborted ? new PairingEnded() : new ApiError("The upload was cancelled.", 0)),
        ),
      );
      ended.addEventListener("abort", callOff);
      request.send(JSON.stringify(body));
    });
    return { result, abort: callOff };
  };

  return {
    machine: {
      key,
      connection,
      read,
      write,
      writeNoContent: async (method, route, body) => {
        await send(method, route, body, undefined);
      },
      upload,
    },
    end: () => lifetime.abort(),
  };
};
