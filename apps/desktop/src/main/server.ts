import os from "node:os";

import type {
  ApiRequest,
  ApiResponse,
  AuthorizeOpened,
  AuthorizeResult,
  EventsState,
  SignOutResult,
  TtyTarget,
  WorkbenchEvent,
} from "../shared/bridge";
import { loadConfig, saveConfig } from "./config";
import {
  awaitDeviceApproval,
  openDeviceRequest,
  revokeDevice,
  type DeviceLoginDeps,
  type OpenedRequest,
} from "./device-login";

/**
 * Main's side of the wire: plain fetch with the bearer, the same shapes the
 * CLI sends. Nothing here knows what a session is — the renderer owns the
 * product model; this module owns the credential.
 */

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

export const request = async (input: ApiRequest): Promise<ApiResponse> => {
  const config = loadConfig();
  if (config.token === null) return { status: 401, ok: false, body: null };
  const headers: Record<string, string> = { authorization: `Bearer ${config.token}` };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${normalizeUrl(config.url)}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    // Status 0: the server did not answer at all — distinct from it saying no.
    return {
      status: 0,
      ok: false,
      body: error instanceof Error ? error.message : String(error),
    };
  }
  const text = await response.text();
  let body: unknown = text === "" ? null : text;
  const contentType = response.headers.get("content-type") ?? "";
  if (text !== "" && contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, ok: response.ok, body };
};

// ─── sign-in: the CLI's authorize walk (./device-login) ─────────────────────

const deviceDeps = (): DeviceLoginDeps => ({
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  name: `${os.hostname()} · desktop`,
});

/** The one open authorize request; opening another abandons it. */
let pending: {
  readonly base: string;
  readonly request: OpenedRequest;
  cancelled: boolean;
} | null = null;

/** Open an authorize request; the caller sends the human to `authorizeUrl`. */
export const startAuthorize = async (url: string): Promise<AuthorizeOpened> => {
  if (pending !== null) pending.cancelled = true;
  pending = null;
  const opened = await openDeviceRequest(url, deviceDeps());
  if (!opened.ok) return opened;
  pending = { base: opened.view.url, request: opened.request, cancelled: false };
  return { ok: true, ...opened.view };
};

/**
 * Wait for the open request's decision. An approval is saved to the shared credential file with
 * its device id, exactly as `mend login` saves it, so `mend logout` can revoke it too.
 */
export const awaitAuthorize = async (): Promise<AuthorizeResult> => {
  const flow = pending;
  if (flow === null) return { ok: false, reason: "no authorize request is open" };
  const result = await awaitDeviceApproval(
    flow.base,
    flow.request,
    deviceDeps(),
    () => flow.cancelled,
  );
  if (pending === flow) pending = null;
  if (!result.ok) return result;
  saveConfig({ url: result.url, token: result.token, deviceId: result.deviceId });
  return { ok: true, url: result.url, email: result.email, deviceName: result.deviceName };
};

export const cancelAuthorize = (): void => {
  if (pending !== null) pending.cancelled = true;
  pending = null;
};

/** A pasted token: kept as given, with no device id (it may not be a device at all). */
export const setToken = (input: { readonly url: string; readonly token: string }): void => {
  saveConfig({ url: normalizeUrl(input.url), token: input.token.trim(), deviceId: null });
};

/**
 * Signing out revokes the device on the server when the saved token is one (`mend logout` does
 * the same): merely forgetting a live token would leave it valid until someone found it under
 * Settings → Devices. The local copy goes either way.
 */
export const signOut = async (): Promise<SignOutResult> => {
  const config = loadConfig();
  let revoke: SignOutResult["revoke"] = "no-device";
  if (config.token !== null && config.deviceId !== null) {
    const revoked = await revokeDevice(
      { fetch },
      normalizeUrl(config.url),
      config.deviceId,
      config.token,
    );
    revoke = revoked ? "revoked" : "not-revoked";
  }
  saveConfig({ url: config.url, token: null, deviceId: null });
  return { revoke };
};

/** Whether `/health` says this server mints upgrade tickets (absent on a server older than them). */
const serverMintsTickets = async (base: string): Promise<boolean> => {
  try {
    const response = await fetch(`${base}/api/health`);
    if (!response.ok) return false;
    const health: unknown = await response.json();
    return (
      typeof health === "object" &&
      health !== null &&
      "upgradeTickets" in health &&
      health.upgradeTickets === true
    );
  } catch {
    return false;
  }
};

/**
 * The `/api/tty` address for one connection. The renderer's WebSocket cannot set a header, so the
 * credential in the URL is an upgrade ticket (docs/adr/0004, "Upgrade tickets"): single use, thirty
 * seconds, good for this terminal only. The saved bearer goes to the server in a header, from this
 * process, and never reaches the renderer or a URL. A server older than tickets answers the mint
 * with 404; only then does the bearer ride the URL, as it always did with that server.
 */
export const ttyUrl = async (target: TtyTarget, from: string): Promise<string> => {
  const config = loadConfig();
  const base = normalizeUrl(config.url);
  const url = new URL(`${base}/api/tty`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(target.kind, target.id);
  url.searchParams.set("from", from);
  if (config.token === null) return url.toString();
  const response = await fetch(`${base}/api/upgrade-tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ target: "tty", [target.kind]: target.id }),
  });
  if (response.status === 404) {
    // Only a server older than tickets gets the bearer in a URL. One that mints them says so on
    // /health, and then this 404 came from something in between: the bearer stays out of URLs.
    if (await serverMintsTickets(base)) {
      throw new Error(
        "upgrade tickets answered 404 on a server that mints them: something between this app and Mend is refusing POST /api/upgrade-tickets",
      );
    }
    console.warn("this server predates upgrade tickets: the saved token rides the terminal URL");
    url.searchParams.set("token", config.token);
    return url.toString();
  }
  if (!response.ok) throw new Error(`upgrade ticket refused (${response.status})`);
  const minted: unknown = await response.json();
  if (
    typeof minted !== "object" ||
    minted === null ||
    !("ticket" in minted) ||
    typeof minted.ticket !== "string"
  ) {
    throw new Error("upgrade ticket missing from the answer");
  }
  url.searchParams.set("ticket", minted.ticket);
  return url.toString();
};

// ─── /api/events — one held SSE read, relayed to the window ─────────────────

const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_AFTER_MS = 30_000;

export interface EventsSink {
  readonly onEvent: (event: WorkbenchEvent) => void;
  readonly onState: (state: EventsState) => void;
}

/**
 * Reads the server's event stream with the bearer (EventSource cannot carry a
 * header) and parses SSE by hand: `data:` lines per event, blank line ends it,
 * `:` lines are heartbeats. Reconnects on the CLI's ladder; a 401 stops and
 * reports `unauthorized` — the credential changed, not the network.
 */
export const subscribeEvents = (sink: EventsSink): (() => void) => {
  let disposed = false;
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempt = 0;

  const schedule = () => {
    if (disposed) return;
    const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
    attempt += 1;
    sink.onState("reconnecting");
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    if (disposed) return;
    const config = loadConfig();
    if (config.token === null) {
      sink.onState("off");
      return;
    }
    sink.onState(attempt === 0 ? "connecting" : "reconnecting");
    const abort = new AbortController();
    controller = abort;
    const openedAt = Date.now();
    try {
      const response = await fetch(`${normalizeUrl(config.url)}/api/events`, {
        headers: { authorization: `Bearer ${config.token}`, accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (response.status === 401) {
        sink.onState("unauthorized");
        return;
      }
      if (!response.ok || response.body === null) {
        schedule();
        return;
      }
      sink.onState("live");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: Array<string> = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            if (data.length > 0) {
              try {
                const parsed: unknown = JSON.parse(data.join("\n"));
                if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
                  sink.onEvent(parsed as WorkbenchEvent);
                }
              } catch {
                // A malformed line is dropped; the next event is independent.
              }
              data = [];
            }
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      // Aborted (dispose/restart) or the link dropped — both fall through.
    }
    if (disposed || controller !== abort) return;
    if (Date.now() - openedAt >= STABLE_AFTER_MS) attempt = 0;
    schedule();
  };

  void connect();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    controller?.abort();
  };
};
