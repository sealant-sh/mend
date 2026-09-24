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

/** POST /api/cli/auth, as the server describes the opened request. */
export interface OpenedRequest {
  readonly deviceCode: string;
  readonly code: string;
  readonly verifyPath: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

/** One poll's answer: keep waiting, or the approval with the token shown once. */
export type PollAnswer =
  | { readonly status: "pending" }
  | {
      readonly status: "approved";
      readonly token: string;
      readonly user: { readonly id: string; readonly name: string; readonly email: string };
      readonly device: { readonly id: string; readonly name: string };
    };

const stringField = (value: object, key: string): string | null => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
};

/** The opened request, checked field by field: a non-Mend server answering 200 reads as null. */
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
  return { deviceCode, code, verifyPath, expiresAt, intervalSeconds };
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

/** When to stop polling: the request's own expiry, or ten minutes for an unreadable date. */
export const pollDeadline = (expiresAt: string, now: number): number => {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? now + 10 * 60_000 : at;
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
  readonly expiresAt: string;
}

export type OpenResult =
  | { readonly ok: true; readonly view: OpenedView; readonly request: OpenedRequest }
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
): Promise<{ readonly status: number; readonly json: unknown }> => {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, json: null };
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Only the happy path needs JSON, and it always is.
  }
  return { status: response.status, json };
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
    return {
      ok: false,
      reason: `the server at ${base} refused to open an authorize request (${started.status})`,
    };
  }
  const request = parseOpenedRequest(started.json);
  if (request === null) {
    return {
      ok: false,
      reason: `the server at ${base} did not answer like a Mend server — is that the right URL?`,
    };
  }
  return {
    ok: true,
    request,
    view: {
      url: base,
      code: groupCode(request.code),
      authorizeUrl: `${base}${request.verifyPath}`,
      expiresAt: request.expiresAt,
    },
  };
};

/**
 * Poll until the request is approved, denied, expired, or `cancelled()` says to stop. The token
 * is returned, never stored here: the caller saves it with the device id.
 */
export const awaitDeviceApproval = async (
  base: string,
  request: OpenedRequest,
  deps: DeviceLoginDeps,
  cancelled: () => boolean,
): Promise<WaitResult> => {
  const deadline = pollDeadline(request.expiresAt, deps.now());
  const delay = pollDelayMs(request.intervalSeconds);
  while (deps.now() < deadline) {
    await deps.sleep(delay);
    if (cancelled()) return { ok: false, reason: CANCELLED };
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
      return {
        ok: false,
        reason: `the server answered ${poll.status} while waiting — start again`,
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
