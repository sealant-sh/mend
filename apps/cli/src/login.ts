import { spawn } from "node:child_process";
import * as os from "node:os";

import { failureWords } from "./failure-words.ts";
import { groupCode } from "./pair.ts";
import { redactCredentials } from "./shared.ts";

/**
 * `mend login`: sign this terminal in through the browser. The CLI opens an
 * authorize request against the server (holding only a secret device code),
 * points the browser at `<server>/authorize?code=…`, and polls until someone
 * signed in there presses Authorize. What comes back is a device token — the
 * same revocable kind a paired phone holds (Settings → Devices ends it). No
 * password ever touches the terminal.
 */

/** POST /cli/auth — the opened request as the server described it. */
export interface CliAuthStartDto {
  readonly deviceCode: string;
  readonly code: string;
  readonly verifyPath: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

/** POST /cli/auth/token — pending until a human decides; approved exactly once. */
export interface CliAuthApprovedDto {
  readonly status: "approved";
  readonly token: string;
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly device: { readonly id: string; readonly name: string };
}

/** One poll's answer: keep waiting, or the approval with the token shown once. */
export type CliAuthPollDto = { readonly status: "pending" } | CliAuthApprovedDto;

/**
 * The opened request as the server's JSON, checked field by field before the
 * CLI acts on it — a captive portal or a non-Mend server answering 200 must
 * read as "not a Mend server", never as a crash. Null follows the CLI's
 * absence idiom (chooseUrl, minutesUntil); the one caller turns it into the
 * exit message.
 */
const parseCliAuthStart = (json: unknown): CliAuthStartDto | null => {
  if (typeof json !== "object" || json === null) return null;
  if (
    !(
      "deviceCode" in json &&
      "code" in json &&
      "verifyPath" in json &&
      "expiresAt" in json &&
      "intervalSeconds" in json
    )
  ) {
    return null;
  }
  const { deviceCode, code, verifyPath, expiresAt, intervalSeconds } = json;
  if (
    typeof deviceCode !== "string" ||
    typeof code !== "string" ||
    typeof verifyPath !== "string" ||
    typeof expiresAt !== "string" ||
    typeof intervalSeconds !== "number"
  ) {
    return null;
  }
  return { deviceCode, code, verifyPath, expiresAt, intervalSeconds };
};

/** A poll answer's JSON, checked the same way; anything off-shape answers null. */
const parseCliAuthPoll = (json: unknown): CliAuthPollDto | null => {
  if (typeof json !== "object" || json === null || !("status" in json)) return null;
  if (json.status === "pending") return { status: "pending" };
  if (json.status !== "approved") return null;
  if (!("token" in json && "user" in json && "device" in json)) return null;
  const { token, user, device } = json;
  if (typeof token !== "string") return null;
  if (typeof user !== "object" || user === null) return null;
  if (!("id" in user && "name" in user && "email" in user)) return null;
  if (
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.email !== "string"
  ) {
    return null;
  }
  if (typeof device !== "object" || device === null) return null;
  if (!("id" in device && "name" in device)) return null;
  if (typeof device.id !== "string" || typeof device.name !== "string") return null;
  return {
    status: "approved",
    token,
    user: { id: user.id, name: user.name, email: user.email },
    device: { id: device.id, name: device.name },
  };
};

/** What the command needs from main.ts: where config points today, and how to keep the result. */
export interface LoginDeps {
  /** MEND_URL or the config file's url — null when this machine was never pointed anywhere. */
  readonly configuredUrl: string | null;
  /** What the first-login prompt offers; Enter accepts it. */
  readonly defaultUrl: string;
  readonly save: (next: {
    readonly url: string;
    readonly token: string;
    readonly deviceId: string;
  }) => void;
}

const paint = (code: string) => (text: string) =>
  process.stdout.isTTY === true ? `[${code}m${text}[0m` : text;
const dim = paint("2");
const green = paint("32");
const cobalt = paint("34");
const say = (line: string) => process.stdout.write(`${redactCredentials(line)}\n`);
const fail = (message: string): never => {
  process.stderr.write(`mend: ${redactCredentials(message)}\n`);
  process.exit(1);
};

const takeFlagValue = (args: ReadonlyArray<string>, flag: string): string | null => {
  const at = args.indexOf(flag);
  return at !== -1 && args[at + 1] !== undefined ? String(args[at + 1]) : null;
};

/**
 * The server URL as a human types it: a bare `host:port` gets http://, a
 * trailing slash goes, anything the URL parser rejects answers null so the
 * caller can say so. The path is kept — an instance can live under one.
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

/** The page a human approves on — the verify path resolved against the URL the CLI dialed. */
export const authorizeUrl = (base: string, verifyPath: string): string => `${base}${verifyPath}`;

/** How the browser opens on this platform; null means print the URL and let the human click. */
export const browserCommand = (
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } | null => {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "linux") return { command: "xdg-open", args: [] };
  return null;
};

/** Polling cadence: what the server asked for, held to a sane band. */
export const pollDelayMs = (intervalSeconds: number): number =>
  Math.min(Math.max(Math.round(intervalSeconds), 1), 10) * 1000;

/** When to stop polling: the request's own expiry, or ten minutes for an unreadable date. */
export const pollDeadline = (expiresAt: string, now: number = Date.now()): number => {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? now + 10 * 60_000 : at;
};

/** Fire-and-forget: a browser that fails to open must never take the login down. */
const openBrowser = (url: string) => {
  const opener = browserCommand(process.platform);
  if (opener === null || process.stdout.isTTY !== true) return;
  try {
    const child = spawn(opener.command, [...opener.args, url], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is already printed; clicking it is the fallback.
  }
};

/** One unauthenticated POST to the authorize surface; anything but 2xx surfaces as a status. */
const post = async (
  url: string,
  body: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return fail(`cannot reach the Mend server at ${new URL(url).origin} — is it running?`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A non-JSON body only matters for the happy path, which always is JSON.
  }
  return { status: response.status, json };
};

const retryAfterSecondsOf = (json: unknown): number => {
  if (typeof json === "object" && json !== null && "retryAfterSeconds" in json) {
    const seconds = Number(json.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return 5;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Where this login points: `--url` wins, then whatever is already configured
 * (MEND_URL or the config file) — a set URL is never asked about again;
 * `--url` is how you point somewhere else. Only a fresh machine prompts, and
 * only on a terminal; a piped stdin takes the default silently.
 */
const resolveServerUrl = async (args: ReadonlyArray<string>, deps: LoginDeps): Promise<string> => {
  const given = takeFlagValue(args, "--url") ?? deps.configuredUrl;
  if (given !== null) {
    return normalizeServerUrl(given) ?? fail(`"${given}" is not a URL the CLI can dial`);
  }
  if (process.stdin.isTTY !== true) {
    return (
      normalizeServerUrl(deps.defaultUrl) ??
      fail(`"${deps.defaultUrl}" is not a URL the CLI can dial`)
    );
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`mend server url ${dim(`[${deps.defaultUrl}]`)}: `)).trim();
  rl.close();
  const chosen = typed === "" ? deps.defaultUrl : typed;
  return normalizeServerUrl(chosen) ?? fail(`"${chosen}" is not a URL the CLI can dial`);
};

/**
 * `mend login [--url <server>]` — open, show, wait, save. The token lands in
 * the CLI config (0600) together with the device id, so `mend logout` can
 * revoke the token server-side instead of merely forgetting it.
 */
export const loginCommand = async (args: ReadonlyArray<string>, deps: LoginDeps): Promise<void> => {
  const base = await resolveServerUrl(args, deps);

  const started = await post(`${base}/api/cli/auth`, { name: os.hostname() });
  if (started.status === 429) {
    return fail(
      `the server asked for a pause — try again in ${retryAfterSecondsOf(started.json)}s`,
    );
  }
  if (started.status < 200 || started.status >= 300) {
    return fail(
      failureWords(started.status, started.json).serverWords ??
        `the server at ${base} did not open an authorize request — try again; its log has the detail`,
    );
  }
  const opened =
    parseCliAuthStart(started.json) ??
    fail(`the server at ${base} did not answer like a Mend server — is that the right URL?`);

  const url = authorizeUrl(base, opened.verifyPath);
  say(`${green("✓")} authorize request open at ${base}`);
  say(
    `  ${dim("code")}    ${groupCode(opened.code)} ${dim("· approve only if the browser shows the same code")}`,
  );
  say(`  ${dim("browser")} ${cobalt(url)}`);
  say("");
  say(dim("  waiting for approval… Ctrl-C stops; nothing is granted until someone approves"));
  openBrowser(url);

  const deadline = pollDeadline(opened.expiresAt);
  const delay = pollDelayMs(opened.intervalSeconds);
  while (Date.now() < deadline) {
    await sleep(delay);
    const poll = await post(`${base}/api/cli/auth/token`, { deviceCode: opened.deviceCode });
    if (poll.status === 429) {
      await sleep(retryAfterSecondsOf(poll.json) * 1000);
      continue;
    }
    if (poll.status === 403) return fail("denied in the browser; nothing was granted");
    if (poll.status === 404 || poll.status === 410) {
      return fail("the authorize request is no longer open — run mend login again");
    }
    if (poll.status < 200 || poll.status >= 300) {
      return fail(
        failureWords(poll.status, poll.json).serverWords ??
          "the server refused while waiting — run mend login again; its log has the detail",
      );
    }
    const result = parseCliAuthPoll(poll.json);
    if (result === null) {
      return fail("the server's answer stopped making sense while waiting — run mend login again");
    }
    if (result.status === "pending") continue;
    deps.save({ url: base, token: result.token, deviceId: result.device.id });
    say(`${green("✓")} signed in as ${result.user.email}`);
    say(
      `  ${dim("this terminal is the device")} ${result.device.name} ${dim("· revoke it any time under Settings → Devices")}`,
    );
    return;
  }
  return fail("the authorize request expired before anyone approved — run mend login again");
};
