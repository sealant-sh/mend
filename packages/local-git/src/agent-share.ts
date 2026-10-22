import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { Option, Schema } from "effect";

/**
 * The ssh-agent bridge, client half (docs/GIT-ACCESS.md decision 2): relay
 * the LOCAL ssh-agent to the Mend server over one standing WebSocket, so
 * bridge-mode git ops sign with a key that never leaves this machine — a
 * hardware key blinks here, not on the server. Agent-protocol messages are
 * relayed verbatim (length-prefixed frames, base64 over JSON); the only
 * inspection is each message's type byte, to say what is being asked.
 */
export type ShareEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected"; readonly retryMs: number }
  | { readonly kind: "sign-requested"; readonly context: string }
  | { readonly kind: "identities-requested"; readonly context: string }
  | { readonly kind: "signed"; readonly context: string; readonly seconds: number }
  | { readonly kind: "not-signed"; readonly context: string; readonly message: string };

export type ShareState = "connecting" | "connected" | "closed";

export type ReadyOutcome = "connected" | "timeout" | "closed";

export interface ShareOptions {
  /**
   * The bridge websocket for the next connection. Asked before every connect and reconnect: the
   * credential in it is a single-use upgrade ticket.
   */
  readonly url: () => Promise<URL>;
  /** The local agent's socket (SSH_AUTH_SOCK). */
  readonly agentSock: string;
  /** Aborting closes the socket and ends the loop. */
  readonly signal: AbortSignal;
  readonly onEvent: (event: ShareEvent) => void;
}

/** Reconnect backoff: 1s, 2s, … capped at 30s. */
export const retryDelayMs = (attempt: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5));

const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENTC_SIGN_REQUEST = 13;

const MAX_AGENT_MESSAGE_BYTES = 256 * 1024;

const MAX_REQUEST_ENVELOPE_CHARS = 4096;

const MAX_SERVER_FRAME_CHARS =
  Math.ceil((4 + MAX_AGENT_MESSAGE_BYTES) / 3) * 4 + MAX_REQUEST_ENVELOPE_CHARS;

const CLOSE_WITHIN_MS = 1000;

const ServerRequest = Schema.Struct({
  t: Schema.Literal("req"),
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  context: Schema.optional(Schema.String),
  payload: Schema.String.check(Schema.isBase64()),
});

const decodeServerRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ServerRequest));

/** Effect's base64 check can overflow the stack on a huge payload and throws a defect for it. */
const decodeServerFrame = (text: string): Option.Option<typeof ServerRequest.Type> => {
  try {
    return decodeServerRequest(text);
  } catch {
    return Option.none();
  }
};

interface AgentRequest {
  readonly id: number;
  readonly context: string;
  readonly framed: Buffer;
}

const parseServerFrame = (data: unknown): AgentRequest | null => {
  if (typeof data !== "string" || data.length > MAX_SERVER_FRAME_CHARS) return null;
  const frame = decodeServerFrame(data);
  if (Option.isNone(frame)) return null;
  const framed = Buffer.from(frame.value.payload, "base64");
  if (framed.length < 5 || framed.readUInt32BE(0) !== framed.length - 4) return null;
  return { id: frame.value.id, context: frame.value.context ?? "mend", framed };
};

type AgentAnswer =
  | { readonly kind: "partial" }
  | { readonly kind: "complete"; readonly framed: Buffer }
  | { readonly kind: "invalid"; readonly declared: number };

const readAgentAnswer = (pending: Buffer): AgentAnswer => {
  if (pending.length < 4) return { kind: "partial" };
  const declared = pending.readUInt32BE(0);
  if (declared === 0 || declared > MAX_AGENT_MESSAGE_BYTES) return { kind: "invalid", declared };
  if (pending.length < 4 + declared) return { kind: "partial" };
  return { kind: "complete", framed: pending.subarray(0, 4 + declared) };
};

/**
 * One complete agent exchange against the local agent: fresh connection,
 * write the framed request verbatim, read one framed response. A hardware
 * key blocks here until the touch — hence the generous timeout.
 */
const askLocalAgent = (agentSock: string, framed: Buffer, signal: AbortSignal): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const connection = net.connect(agentSock, () => {
      connection.write(framed);
    });
    const settle = (outcome: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      connection.destroy();
      outcome();
    };
    const onAbort = () => {
      settle(() => reject(new Error("the connection to mend closed")));
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error("the agent did not answer within 60s — touch missed?")));
    }, 60_000);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    connection.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const answer = readAgentAnswer(pending);
      if (answer.kind === "complete") settle(() => resolve(answer.framed));
      else if (answer.kind === "invalid") {
        settle(() =>
          reject(
            new Error(
              `the agent's answer declared ${answer.declared} bytes, not 1 to ${MAX_AGENT_MESSAGE_BYTES}`,
            ),
          ),
        );
      }
    });
    connection.on("end", () => {
      settle(() => reject(new Error("the agent closed the connection without answering")));
    });
    connection.on("error", (error) => {
      settle(() => reject(error));
    });
  });

const answerRequest = async (
  request: AgentRequest,
  ws: WebSocket,
  live: AbortSignal,
  agentSock: string,
  onEvent: (event: ShareEvent) => void,
): Promise<void> => {
  if (live.aborted) return;
  const { id, context, framed } = request;
  const signs = framed[4] === SSH_AGENTC_SIGN_REQUEST;
  const started = Date.now();
  if (signs) onEvent({ kind: "sign-requested", context });
  else if (framed[4] === SSH_AGENTC_REQUEST_IDENTITIES) {
    onEvent({ kind: "identities-requested", context });
  }
  try {
    const response = await askLocalAgent(agentSock, framed, live);
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "res", id, payload: response.toString("base64") }));
    if (signs) onEvent({ kind: "signed", context, seconds: (Date.now() - started) / 1000 });
  } catch (error) {
    if (live.aborted) return;
    const reason = error instanceof Error ? error.message : String(error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "err", id, message: reason }));
    }
    if (signs) onEvent({ kind: "not-signed", context, message: reason });
  }
};

const relayOnce = (
  target: URL,
  options: ShareOptions,
  oneAtATime: (task: () => Promise<void>) => void,
): Promise<"opened" | "never-opened"> =>
  new Promise((resolve) => {
    const { agentSock, signal, onEvent } = options;
    const ws = new WebSocket(target);
    const live = new AbortController();
    let opened = false;
    const onAbort = () => {
      live.abort();
      ws.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      opened = true;
      onEvent({ kind: "connected" });
    });
    ws.addEventListener("message", (event) => {
      const request = parseServerFrame(event.data);
      if (request !== null) {
        oneAtATime(() => answerRequest(request, ws, live.signal, agentSock, onEvent));
      }
    });
    ws.addEventListener(
      "close",
      () => {
        live.abort();
        signal.removeEventListener("abort", onAbort);
        resolve(opened ? "opened" : "never-opened");
      },
      { once: true },
    );
  });

/** An abortable wait; an abort simply ends it early. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal }).then(
    () => undefined,
    () => undefined,
  );

/** Share until the signal aborts; every connect, drop, and signature is an event. */
export const shareAgent = async (options: ShareOptions): Promise<void> => {
  const { url, signal, onEvent } = options;
  let tail: Promise<void> = Promise.resolve();
  const oneAtATime = (task: () => Promise<void>) => {
    tail = tail.then(task).catch(() => undefined);
  };
  let attempt = 0;
  const nextUrl = async (): Promise<URL | null> => {
    try {
      return await url();
    } catch {
      return null;
    }
  };
  while (!signal.aborted) {
    const target = await nextUrl();
    if (signal.aborted) return;
    const outcome =
      target === null
        ? "never-opened"
        : await relayOnce(target, options, oneAtATime).catch((): "never-opened" => "never-opened");
    if (signal.aborted) return;
    attempt = outcome === "opened" ? 1 : attempt + 1;
    const retryMs = retryDelayMs(attempt);
    onEvent({ kind: "disconnected", retryMs });
    await sleep(retryMs, signal);
  }
};

export interface AgentShareHandle {
  readonly snapshot: () => ShareState;
  readonly subscribe: (listener: (event: ShareEvent | null) => void) => () => void;
  /** Connected now or within the bound; never rejects. */
  readonly ready: (withinMs: number) => Promise<ReadyOutcome>;
  /** Stop reconnecting and close the socket; resolves once it closed or the bound passed. */
  readonly close: (withinMs?: number) => Promise<void>;
}

const within = <A>(withinMs: number, late: A, work: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(late), withinMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

export const startAgentShare = (
  options: Omit<ShareOptions, "signal" | "onEvent">,
): AgentShareHandle => {
  const controller = new AbortController();
  const listeners = new Set<(event: ShareEvent | null) => void>();
  const waiters = new Set<(outcome: ReadyOutcome) => void>();
  let state: ShareState = "connecting";
  const moveTo = (next: ShareState) => {
    if (state === "closed" || state === next) return;
    state = next;
    if (next === "connecting") return;
    for (const wake of waiters) wake(next);
    if (next === "closed") for (const listener of listeners) listener(null);
  };
  const ended = shareAgent({
    ...options,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.kind === "connected") moveTo("connected");
      else if (event.kind === "disconnected") moveTo("connecting");
      for (const listener of listeners) listener(event);
    },
  });
  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: (withinMs) => {
      if (state !== "connecting") return Promise.resolve(state);
      const woken = Promise.withResolvers<ReadyOutcome>();
      waiters.add(woken.resolve);
      return within(withinMs, "timeout", woken.promise).finally(() =>
        waiters.delete(woken.resolve),
      );
    },
    close: (withinMs = CLOSE_WITHIN_MS) => {
      controller.abort();
      moveTo("closed");
      return within(
        withinMs,
        undefined,
        ended.catch(() => undefined),
      );
    },
  };
};
