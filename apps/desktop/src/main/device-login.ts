import type { CliAuthPollView, CliAuthStartView } from "@mend/api-contracts";

import { failureLogLine, failureWords } from "../shared/failure-words";

/**
 * The desktop signs in the way `mend login` does (apps/cli/src/login.ts, the `cliAuth` contract
 * in packages/api-contracts/src/devices.ts): open an authorize request that holds a secret device
 * code, send the human to `<server>/authorize?code=…` in their browser, and poll until someone
 * signed in there approves it. What comes back is a device token, listed under Settings → Devices
 * and revocable there or by signing out here. No password reaches the app.
 *
 * The device code never leaves main: the renderer sees the short code to compare and the page to
 * approve on, nothing it could collect a token with.
 */

/** POST /api/cli/auth, as the server describes the opened request (the contract's own shape). */
export type OpenedRequest = typeof CliAuthStartView.Encoded;

/** One poll's answer: keep waiting, or the approval with the token shown once. */
export type PollAnswer = typeof CliAuthPollView.Encoded;

const stringField = (value: object, key: string): string | null => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
};

/**
 * The opened request, checked field by field: a non-Mend server answering 200 reads as null. Main
 * keeps this check by hand rather than loading the contract's schemas at runtime (main's
 * dependencies stay external, and the contract ships as TypeScript source); the return type is
 * the contract's, so a field the contract adds fails the build here.
 */
export const parseOpenedRequest = (json: unknown): OpenedRequest | null => {
  if (typeof json !== "object" || json === null) return null;
  const deviceCode = stringField(json, "deviceCode");
  const code = stringField(json, "code");
  const verifyPath = stringField(json, "verifyPath");
  const expiresAt = stringField(json, "expiresAt");
  const intervalSeconds: unknown = Reflect.get(json, "intervalSeconds");
  if (
    deviceCode === null ||
    code === null ||
    verifyPath === null ||
    expiresAt === null ||
    typeof intervalSeconds !== "number"
  ) {
    return null;
  }
  const expiresIn: unknown = Reflect.get(json, "expiresIn");
  return {
    deviceCode,
    code,
    verifyPath,
    expiresAt,
    intervalSeconds,
    ...(typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn >= 0
      ? { expiresIn }
      : {}),
  };
};

/** A poll answer, checked the same way; anything off-shape is null. */
export const parsePollAnswer = (json: unknown): PollAnswer | null => {
  if (typeof json !== "object" || json === null) return null;
  const status = stringField(json, "status");
  if (status === "pending") return { status: "pending" };
  if (status !== "approved") return null;
  const token = stringField(json, "token");
  const user: unknown = Reflect.get(json, "user");
  const device: unknown = Reflect.get(json, "device");
  if (token === null || typeof user !== "object" || user === null) return null;
  if (typeof device !== "object" || device === null) return null;
  const userId = stringField(user, "id");
  const userName = stringField(user, "name");
  const email = stringField(user, "email");
  const deviceId = stringField(device, "id");
  const deviceName = stringField(device, "name");
  if (
    userId === null ||
    userName === null ||
    email === null ||
    deviceId === null ||
    deviceName === null
  ) {
    return null;
  }
  return {
    status: "approved",
    token,
    user: { id: userId, name: userName, email },
    device: { id: deviceId, name: deviceName },
  };
};

/**
 * The server URL as a human types it: a bare `host:port` gets http://, a trailing slash goes, a
 * path is kept (an instance can live under one). Null for anything that is not http(s).
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
 * The short code as the CLI prints it (apps/cli/src/pair.ts): upper case, a dash after four. The
 * server compares without dashes and case, so the dash is only for the eye.
 */
export const groupCode = (code: string): string => {
  const bare = code.replace(/[^0-9a-z]/gi, "").toUpperCase();
  return bare.length <= 4 ? bare : `${bare.slice(0, 4)}-${bare.slice(4)}`;
};

/** Polling cadence: what the server asked for, held to one to ten seconds. */
export const pollDelayMs = (intervalSeconds: number): number =>
  Math.min(Math.max(Math.round(intervalSeconds), 1), 10) * 1000;

/**
 * Local deadline from response-header receipt, using relative expiry first. Legacy expiry is
 * read against the server's Date, never this machine's clock alone; absent/unreadable evidence
 * allows ten minutes, matching the CLI. The server remains authoritative about approval.
 */
export const pollDeadline = (
  request: Pick<OpenedRequest, "expiresAt" | "expiresIn">,
  receivedAt: number,
  serverDate: string | null,
): number => {
  if (
    request.expiresIn !== undefined &&
    Number.isSafeInteger(request.expiresIn) &&
    request.expiresIn >= 0
  ) {
    const relative = receivedAt + request.expiresIn * 1000;
    if (Number.isFinite(new Date(relative).getTime())) return relative;
  }
  const expires = Date.parse(request.expiresAt);
  const serverNow = serverDate === null ? Number.NaN : Date.parse(serverDate);
  if (Number.isFinite(expires) && Number.isFinite(serverNow)) {
    const legacy = receivedAt + Math.max(0, expires - serverNow);
    if (Number.isFinite(new Date(legacy).getTime())) return legacy;
  }
  return receivedAt + 10 * 60_000;
};

const retryAfterSecondsOf = (json: unknown): number => {
  if (typeof json === "object" && json !== null) {
    const seconds = Number(Reflect.get(json, "retryAfterSeconds"));
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return 5;
};

export interface DeviceLoginDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** What the device is called in Settings → Devices. */
  readonly name: string;
}

/** What the renderer is shown while a request is open. */
export interface OpenedView {
  readonly url: string;
  readonly code: string;
  readonly authorizeUrl: string;
  /** Estimated expiry on this machine's clock, for display; the server judges approval. */
  readonly expiresAt: string;
}

export type OpenResult =
  | {
      readonly ok: true;
      readonly view: OpenedView;
      readonly request: OpenedRequest;
      /** Local millisecond deadline established at receipt; waiting must retain it. */
      readonly deadline: number;
    }
  | { readonly ok: false; readonly reason: string };

export type WaitResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly token: string;
      readonly deviceId: string;
      readonly deviceName: string;
      readonly email: string;
    }
  | { readonly ok: false; readonly reason: string };

/** One unauthenticated JSON POST; status 0 means nothing answered. */
const post = async (
  deps: DeviceLoginDeps,
  url: string,
  body: unknown,
): Promise<{
  readonly status: number;
  readonly json: unknown;
  readonly receivedAt: number;
  readonly date: string | null;
}> => {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, json: null, receivedAt: deps.now(), date: null };
  }
  const receivedAt = deps.now();
  const date = response.headers.get("date");
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Only the happy path needs JSON, and it always is.
  }
  return { status: response.status, json, receivedAt, date };
};

/**
 * Revoke one device with its own token (`DELETE /api/me/devices/:id`, what `mend logout` sends).
 * True only when the server said it did.
 */
export const revokeDevice = async (
  deps: Pick<DeviceLoginDeps, "fetch">,
  base: string,
  deviceId: string,
  token: string,
): Promise<boolean> => {
  try {
    const response = await deps.fetch(`${base}/api/me/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
};

const CANCELLED = "cancelled; nothing was granted";

/** Open an authorize request at `input`. */
export const openDeviceRequest = async (
  input: string,
  deps: DeviceLoginDeps,
): Promise<OpenResult> => {
  const base = normalizeServerUrl(input);
  if (base === null) return { ok: false, reason: `"${input}" is not a URL the app can dial` };
  const started = await post(deps, `${base}/api/cli/auth`, { name: deps.name });
  if (started.status === 0) {
    return { ok: false, reason: `cannot reach the Mend server at ${base} — is it running?` };
  }
  if (started.status === 429) {
    return {
      ok: false,
      reason: `the server asked for a pause — try again in ${retryAfterSecondsOf(started.json)}s`,
    };
  }
  if (started.status < 200 || started.status >= 300) {
    console.warn(failureLogLine("POST /api/cli/auth", started.status, started.json));
    return {
      ok: false,
      reason:
        failureWords(started.status, started.json).serverWords ??
        `the server at ${base} did not open an authorize request — try again; its log has the detail`,
    };
  }
  const request = parseOpenedRequest(started.json);
  if (request === null) {
    return {
      ok: false,
      reason: `the server at ${base} did not answer like a Mend server — is that the right URL?`,
    };
  }
  const deadline = pollDeadline(request, started.receivedAt, started.date);
  return {
    ok: true,
    request,
    deadline,
    view: {
      url: base,
      code: groupCode(request.code),
      authorizeUrl: `${base}${request.verifyPath}`,
      expiresAt: new Date(deadline).toISOString(),
    },
  };
};

/**
 * Poll until the request is approved, denied, expired, or `cancelled()` says to stop. The token
 * is returned, never stored here: the caller saves it with the device id. The deadline is the
 * one established when opening the request, so a delayed wait cannot renew its lifetime.
 */
export const awaitDeviceApproval = async (
  base: string,
  request: OpenedRequest,
  deps: DeviceLoginDeps,
  cancelled: () => boolean,
  deadline: number,
): Promise<WaitResult> => {
  const delay = pollDelayMs(request.intervalSeconds);
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(delay, Math.max(0, deadline - deps.now())));
    if (cancelled()) return { ok: false, reason: CANCELLED };
    if (deps.now() >= deadline) break;
    const poll = await post(deps, `${base}/api/cli/auth/token`, {
      deviceCode: request.deviceCode,
    });
    if (cancelled()) {
      // The approval can land on the very poll the walk was abandoned during. The server made a
      // device for it and showed its token this once; dropping the token would leave a live
      // device nobody holds, so it is revoked with its own token first.
      const late = poll.status >= 200 && poll.status < 300 ? parsePollAnswer(poll.json) : null;
      if (late?.status !== "approved") return { ok: false, reason: CANCELLED };
      return (await revokeDevice(deps, base, late.device.id, late.token))
        ? { ok: false, reason: "cancelled; the approval that arrived meanwhile was revoked" }
        : {
            ok: false,
            reason: `cancelled, but the device ${late.device.name} was approved meanwhile and could not be revoked; end it under Settings → Devices`,
          };
    }
    // Nothing answered: the network, not the request. Keep waiting until the deadline.
    if (poll.status === 0) continue;
    if (poll.status === 429) {
      await deps.sleep(retryAfterSecondsOf(poll.json) * 1000);
      continue;
    }
    if (poll.status === 403)
      return { ok: false, reason: "denied in the browser; nothing was granted" };
    if (poll.status === 404 || poll.status === 410) {
      return { ok: false, reason: "the authorize request is no longer open — start again" };
    }
    if (poll.status < 200 || poll.status >= 300) {
      console.warn(failureLogLine("POST /api/cli/auth/token", poll.status, poll.json));
      return {
        ok: false,
        reason:
          failureWords(poll.status, poll.json).serverWords ??
          "the server refused while waiting — start again; its log has the detail",
      };
    }
    const answer = parsePollAnswer(poll.json);
    if (answer === null) {
      return { ok: false, reason: "the server's answer stopped making sense — start again" };
    }
    if (answer.status === "pending") continue;
    return {
      ok: true,
      url: base,
      token: answer.token,
      deviceId: answer.device.id,
      deviceName: answer.device.name,
      email: answer.user.email,
    };
  }
  return { ok: false, reason: "the authorize request expired before anyone approved it" };
};
