import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * The ssh-agent bridge, client half (docs/GIT-ACCESS.md decision 2): relay
 * the LOCAL ssh-agent to the Mend server over one standing WebSocket, so
 * bridge-mode git ops sign with a key that never leaves this machine — a
 * hardware key blinks here, not on the server. Agent-protocol messages are
 * relayed verbatim (length-prefixed frames, base64 over JSON); the only
 * inspection is each message's type byte, to say what is being asked.
 *
 * `mend keys share` runs this in the foreground and prints; the dashboard
 * runs it in the background and shows the facts in its chrome. Both get the
 * same events.
 */
export type ShareEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected"; readonly retryMs: number }
  | { readonly kind: "sign-requested"; readonly context: string }
  | { readonly kind: "identities-requested"; readonly context: string }
  | { readonly kind: "signed"; readonly context: string; readonly seconds: number }
  | { readonly kind: "not-signed"; readonly context: string; readonly message: string };

export type ShareState = "connecting" | "connected";

export interface ShareOptions {
  /**
   * The bridge websocket for the next connection. Asked before every connect and reconnect: the
   * credential in it is a single-use upgrade ticket (`upgrade-url.ts`).
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

/**
 * One complete agent exchange against the local agent: fresh connection,
 * write the framed request verbatim, read one framed response. A hardware
 * key blocks here until the touch — hence the generous timeout.
 */
const askLocalAgent = (agentSock: string, payload: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const connection = net.connect(agentSock, () => {
      connection.write(payload);
    });
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the agent did not answer within 60s — touch missed?"));
    }, 60_000);
    let pending: Buffer = Buffer.alloc(0);
    connection.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        clearTimeout(timer);
        connection.end();
        resolve(pending.subarray(0, 4 + pending.readUInt32BE(0)));
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/** An abortable wait; an abort simply ends it early. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, { signal }).then(
    () => undefined,
    () => undefined,
  );

/** Share until the signal aborts; every connect, drop, and signature is an event. */
export const shareAgent = async (options: ShareOptions): Promise<void> => {
  const { url, agentSock, signal, onEvent } = options;
  // Requests are answered one at a time: the agent protocol has one in flight.
  let chain: Promise<unknown> = Promise.resolve();
  let attempt = 0;
  while (!signal.aborted) {
    let target: URL;
    try {
      target = await url();
    } catch {
      // The server is unreachable or refused the ticket; the backoff below applies either way.
      attempt += 1;
      const retryMs = retryDelayMs(attempt);
      onEvent({ kind: "disconnected", retryMs });
      await sleep(retryMs, signal);
      continue;
    }
    const ws = new WebSocket(target);
    const onAbort = () => ws.close();
    signal.addEventListener("abort", onAbort, { once: true });
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true), { once: true });
      ws.addEventListener("error", () => resolve(false), { once: true });
    });
    if (opened) {
      attempt = 0;
      onEvent({ kind: "connected" });
      ws.addEventListener("message", (event) => {
        const text =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        let frame: { t?: string; id?: number; context?: string; payload?: string };
        try {
          frame = JSON.parse(text) as typeof frame;
        } catch {
          return;
        }
        if (
          frame.t !== "req" ||
          typeof frame.id !== "number" ||
          typeof frame.payload !== "string"
        ) {
          return;
        }
        const id = frame.id;
        const payload = Buffer.from(frame.payload, "base64");
        const type = payload[4];
        const context = typeof frame.context === "string" ? frame.context : "mend";
        chain = chain.then(async () => {
          const started = Date.now();
          if (type === SSH_AGENTC_SIGN_REQUEST) onEvent({ kind: "sign-requested", context });
          else if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
            onEvent({ kind: "identities-requested", context });
          }
          try {
            const response = await askLocalAgent(agentSock, payload);
            if (ws.readyState !== WebSocket.OPEN) return null;
            ws.send(JSON.stringify({ t: "res", id, payload: response.toString("base64") }));
            if (type === SSH_AGENTC_SIGN_REQUEST) {
              onEvent({ kind: "signed", context, seconds: (Date.now() - started) / 1000 });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ t: "err", id, message }));
            }
            if (type === SSH_AGENTC_SIGN_REQUEST) onEvent({ kind: "not-signed", context, message });
          }
          return null;
        });
      });
    }
    await closed;
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) return;
    attempt += 1;
    const retryMs = retryDelayMs(attempt);
    onEvent({ kind: "disconnected", retryMs });
    await sleep(retryMs, signal);
  }
};

/**
 * A running share the dashboard can watch: the current state for the chrome,
 * every event for the status line.
 */
export interface AgentShareHandle {
  readonly snapshot: () => ShareState;
  readonly subscribe: (listener: (event: ShareEvent | null) => void) => () => void;
  readonly stop: () => void;
}

/** Start sharing in the background; `stop` ends it. */
export const startAgentShare = (
  options: Omit<ShareOptions, "signal" | "onEvent">,
): AgentShareHandle => {
  const controller = new AbortController();
  const listeners = new Set<(event: ShareEvent | null) => void>();
  let state: ShareState = "connecting";
  void shareAgent({
    ...options,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.kind === "connected") state = "connected";
      else if (event.kind === "disconnected") state = "connecting";
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
    stop: () => controller.abort(),
  };
};
