import { isIP } from "node:net";

import { failureLogLine, failureWords } from "./failure-words.js";
import { transportReason } from "./mend-http.js";

/**
 * Sign the editor in through the browser, the same walk `mend login` takes (apps/cli/src/login.ts):
 * open an authorize request holding only a secret device code, send the browser to
 * `<server>/authorize?code=…`, and poll until someone signed in there presses Authorize. What comes
 * back is a device token, revocable under Settings → Devices. No password reaches the editor, and a
 * MacBook with no Mend CLI signs in to a Mac mini's server without pasting a token.
 */

/** The opened request as the server describes it (`POST /api/cli/auth`). */
export interface AuthorizeRequest {
  readonly deviceCode: string;
  readonly code: string;
  readonly verifyPath: string;
  readonly expiresAt: string;
  /** Seconds left when the server answered; absent from an older server. */
  readonly expiresIn?: number;
  readonly intervalSeconds: number;
}

/** What an approval hands over, shown once. */
export interface SignedIn {
  readonly url: string;
  readonly token: string;
  readonly deviceId: string;
  readonly email: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The server URL as a person types it: a bare `host:port` gets http://, a trailing slash goes, and
 * anything that is not an http(s) URL answers null. The path is kept: an instance can live under one.
 */
export const normalizeServerUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
};

/**
 * This machine, by name or by literal address. 127/8 counts only as a literal IPv4 address: a DNS
 * name that begins with `127.` can point anywhere.
 */
const isLoopbackHost = (hostname: string): boolean => {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1";
  return bare === "localhost";
};

const ipv4Octets = (address: string): ReadonlyArray<number> | null =>
  isIP(address) === 4 ? address.split(".").map(Number) : null;

/**
 * A tailnet address or name: Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48, or a MagicDNS
 * name. Tailscale encrypts every connection between its devices, so plain http there is not
 * plain on the wire.
 */
const isTailnetHost = (hostname: string): boolean => {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = ipv4Octets(bare);
  if (octets !== null) return octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) < 128;
  if (isIP(bare) === 6) return bare.startsWith("fd7a:115c:a1e0:");
  return bare.endsWith(".ts.net");
};

/**
 * Said in Connect's URL input before anything is sent, for a plain-http server another machine
 * serves. Null for https, for this machine, and for a tailnet, which encrypts the connection itself.
 */
export const plainHttpWarning = (url: string): string | null => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || isLoopbackHost(parsed.hostname)) return null;
  if (isTailnetHost(parsed.hostname)) return null;
  return "Plain http: the token travels unencrypted";
};

/**
 * What Connect's URL input says under what she typed: an error for what is not a server URL (it
 * cannot be accepted), a warning for plain http (it can be), else nothing.
 */
export const urlNotice = (
  typed: string,
): { readonly severity: "error" | "warning"; readonly message: string } | null => {
  const url = normalizeServerUrl(typed);
  if (url === null) {
    return { severity: "error", message: "Enter an http or https URL, or host:port." };
  }
  const warning = plainHttpWarning(url);
  return warning === null ? null : { severity: "warning", message: warning };
};

/** The code as both screens show it: `ABCD-EFGH`. */
export const groupCode = (code: string): string => {
  const bare = code.replace(/[^0-9a-z]/gi, "").toUpperCase();
  return bare.length <= 4 ? bare : `${bare.slice(0, 4)}-${bare.slice(4)}`;
};

export const parseAuthorizeRequest = (value: unknown): AuthorizeRequest | null => {
  if (!isRecord(value)) return null;
  const { deviceCode, code, verifyPath, expiresAt, expiresIn, intervalSeconds } = value;
  return typeof deviceCode === "string" &&
    typeof code === "string" &&
    typeof verifyPath === "string" &&
    verifyPath.startsWith("/") &&
    typeof expiresAt === "string" &&
    typeof intervalSeconds === "number"
    ? {
        deviceCode,
        code,
        verifyPath,
        expiresAt,
        intervalSeconds,
        ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) ? { expiresIn } : {}),
      }
    : null;
};

/** One poll's answer: still pending, the approval, or null for an answer that is not Mend's. */
export const parsePoll = (value: unknown): "pending" | Omit<SignedIn, "url"> | null => {
  if (!isRecord(value)) return null;
  if (value["status"] === "pending") return "pending";
  if (value["status"] !== "approved") return null;
  const { token, user, device } = value;
  if (typeof token !== "string" || !isRecord(user) || !isRecord(device)) return null;
  const email = user["email"];
  const deviceId = device["id"];
  return typeof email === "string" && typeof deviceId === "string"
    ? { token, deviceId, email }
    : null;
};

/**
 * When to stop polling, on this machine's clock, counted from when the server's answer arrived.
 * The two clocks can disagree by hours (a Mac's VM after sleep), so the server's `expiresAt` is
 * never read against this clock alone: its `expiresIn` when it sends one; else `expiresAt` less
 * the time on its own Date header (an older server); else ten minutes. The server judges expiry
 * by its own clock either way; this only stops a poll that could no longer succeed.
 */
export const pollDeadline = (
  request: Pick<AuthorizeRequest, "expiresAt" | "expiresIn">,
  receivedAt: number,
  serverDate: string | null,
): number => {
  if (request.expiresIn !== undefined) return receivedAt + Math.max(0, request.expiresIn) * 1000;
  const at = Date.parse(request.expiresAt);
  const serverNow = serverDate === null ? Number.NaN : Date.parse(serverDate);
  if (Number.isNaN(at) || Number.isNaN(serverNow)) return receivedAt + 10 * 60_000;
  return receivedAt + Math.max(0, at - serverNow);
};

/** Polling cadence: what the server asked for, held between one and ten seconds. */
export const pollDelayMs = (intervalSeconds: number): number =>
  Math.min(Math.max(Math.round(intervalSeconds), 1), 10) * 1000;

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

/** Nothing answered: a poll retries once, so one dropped request does not end the sign-in. */
class Unanswered extends SignInError {}

export interface SignInDeps {
  readonly fetch: typeof fetch;
  /**
   * Open the approve page; false when no browser could be asked to. Not awaited: VS Code may ask
   * "open the external website?" first, and that dialog can sit behind other windows.
   */
  readonly openExternal: (url: string) => Promise<boolean>;
  /** Shown while waiting: the code to compare with the browser's, and the page. */
  readonly onCode: (code: string, url: string) => void;
  /** Explain an unrevoked late approval with safe local words after the browser flow is cancelled. */
  readonly onWarning: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** This machine's name as Settings → Devices lists it. */
  readonly deviceName: string;
  readonly cancelled: () => boolean;
  readonly now?: () => number;
}

const post = async (
  deps: SignInDeps,
  url: string,
  body: unknown,
): Promise<{
  readonly status: number;
  readonly json: unknown;
  /** The server's own Date header, when it sent one. */
  readonly date: string | null;
  /** This machine's clock when the answer arrived. */
  readonly receivedAt: number;
}> => {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new Unanswered(`Cannot reach Mend at ${new URL(url).origin}.${transportReason(cause)}`);
  }
  const receivedAt = (deps.now ?? Date.now)();
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Only the happy path needs a body, and it is always JSON.
  }
  return { status: response.status, json, date: response.headers.get("date"), receivedAt };
};

const retryAfterMs = (json: unknown): number => {
  const seconds = isRecord(json) ? Number(json["retryAfterSeconds"]) : Number.NaN;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
};

/** Revoke a late approval with its own token; refusal and transport failure leave revocation unconfirmed. */
const revokeLateApproval = async (
  base: string,
  approval: Omit<SignedIn, "url">,
  deps: Pick<SignInDeps, "fetch">,
): Promise<boolean> => {
  try {
    const response = await deps.fetch(
      `${base}/api/me/devices/${encodeURIComponent(approval.deviceId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${approval.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
};

/** Check cancellation again when a host hands the browser result back to its persistence caller. */
export const finishBrowserSignIn = async (
  signedIn: SignedIn | null,
  deps: Pick<SignInDeps, "fetch" | "cancelled" | "deviceName" | "onWarning">,
): Promise<SignedIn | null> => {
  if (signedIn === null || !deps.cancelled()) return signedIn;
  if (!(await revokeLateApproval(signedIn.url, signedIn, deps))) {
    deps.onWarning(
      `Sign-in was cancelled, but Mend did not confirm revocation of the device approved meanwhile. Revoke ${deps.deviceName} under Settings → Devices.`,
    );
  }
  return null;
};

/**
 * Open, show, wait. Cancellation returns null after revoking any observed late approval, with a
 * warning if revocation failed. Other sign-in failures reject with SignInError.
 */
export const browserSignIn = async (base: string, deps: SignInDeps): Promise<SignedIn | null> => {
  const now = deps.now ?? Date.now;
  const started = await post(deps, `${base}/api/cli/auth`, {
    name: deps.deviceName,
    client: "vscode",
  });
  if (started.status === 429) {
    throw new SignInError(
      `Mend asked for a pause: try again in ${retryAfterMs(started.json) / 1000}s.`,
    );
  }
  if (started.status < 200 || started.status >= 300) {
    console.warn(failureLogLine("POST /api/cli/auth", started.status, started.json));
    throw new SignInError(
      failureWords(started.status, started.json).serverWords ??
        `Mend at ${base} did not open a sign-in request; the server log has the detail.`,
    );
  }
  const request = parseAuthorizeRequest(started.json);
  if (request === null) {
    throw new SignInError(`${base} did not answer like a Mend server. Check the URL.`);
  }
  const page = `${base}${request.verifyPath}`;
  deps.onCode(groupCode(request.code), page);
  // Polling starts at once: an approval made from the printed link counts while VS Code's own
  // "open the external website?" dialog still waits for an answer.
  void deps.openExternal(page).catch(() => false);
  const deadline = pollDeadline(request, started.receivedAt, started.date);
  let unanswered = false;
  while (now() < deadline) {
    await deps.sleep(pollDelayMs(request.intervalSeconds));
    if (deps.cancelled()) return null;
    let poll: Awaited<ReturnType<typeof post>>;
    try {
      poll = await post(deps, `${base}/api/cli/auth/token`, { deviceCode: request.deviceCode });
    } catch (cause) {
      if (!(cause instanceof Unanswered) || unanswered) throw cause;
      unanswered = true;
      continue;
    }
    unanswered = false;
    const result = poll.status >= 200 && poll.status < 300 ? parsePoll(poll.json) : null;
    if (deps.cancelled()) {
      return finishBrowserSignIn(
        result === null || result === "pending" ? null : { url: base, ...result },
        deps,
      );
    }
    if (poll.status === 429) {
      await deps.sleep(retryAfterMs(poll.json));
      continue;
    }
    if (poll.status === 403) throw new SignInError("Sign-in denied in the browser.");
    if (poll.status === 404 || poll.status === 410) {
      throw new SignInError("The sign-in request is no longer open.");
    }
    if (poll.status < 200 || poll.status >= 300) {
      console.warn(failureLogLine("POST /api/cli/auth/token", poll.status, poll.json));
      throw new SignInError(
        failureWords(poll.status, poll.json).serverWords ??
          "Mend refused while waiting; the server log has the detail.",
      );
    }
    if (result === null) throw new SignInError("Mend's answer stopped making sense.");
    if (result === "pending") continue;
    return { url: base, ...result };
  }
  throw new SignInError("The sign-in request expired before anyone approved it.");
};
