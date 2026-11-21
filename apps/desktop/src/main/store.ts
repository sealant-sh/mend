import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MIN_WINDOW_SIZE, type WindowBounds } from "./bounds.ts";
import { normalizeServerUrl } from "./urls.ts";

/**
 * Persistent desktop shell preferences stored in `userData/desktop-state.json`.
 *
 * Holds only UI/shell state (active server URL, recent server list, window bounds). Never stores
 * credentials: sign-in stays on the Mend server via Chromium's persistent session cookies.
 */

export interface DesktopStoreState {
  readonly serverUrl: string | null;
  readonly recentServers: ReadonlyArray<string>;
  readonly bounds: WindowBounds | null;
  readonly maximized: boolean;
}

const MAX_RECENT_SERVERS = 6;

export const EMPTY_STORE_STATE: DesktopStoreState = {
  serverUrl: null,
  recentServers: [],
  bounds: null,
  maximized: false,
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseBounds = (value: unknown): WindowBounds | null => {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  if (width < MIN_WINDOW_SIZE.width || height < MIN_WINDOW_SIZE.height) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
};

const parseServerUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeServerUrl(value);
  return normalized.ok ? normalized.url : null;
};

export const parseDesktopState = (raw: unknown): DesktopStoreState => {
  if (!isRecord(raw)) return EMPTY_STORE_STATE;
  const serverUrl = parseServerUrl(raw["serverUrl"]);
  const rawRecent = Array.isArray(raw["recentServers"]) ? raw["recentServers"] : [];
  const seen = new Set<string>();
  const recentServers: Array<string> = [];
  for (const item of rawRecent) {
    const parsed = parseServerUrl(item);
    if (parsed !== null && !seen.has(parsed)) {
      seen.add(parsed);
      recentServers.push(parsed);
      if (recentServers.length >= MAX_RECENT_SERVERS) break;
    }
  }
  if (serverUrl !== null && !seen.has(serverUrl)) {
    recentServers.unshift(serverUrl);
    if (recentServers.length > MAX_RECENT_SERVERS) recentServers.pop();
  }
  return {
    serverUrl,
    recentServers,
    bounds: parseBounds(raw["bounds"]),
    maximized: raw["maximized"] === true,
  };
};

export const recordRecentServer = (
  recent: ReadonlyArray<string>,
  url: string,
): ReadonlyArray<string> =>
  [url, ...recent.filter((item) => item !== url)].slice(0, MAX_RECENT_SERVERS);

export const removeRecentServer = (
  recent: ReadonlyArray<string>,
  url: string,
): ReadonlyArray<string> => recent.filter((item) => item !== url);

/**
 * Read the URL from the CLI's config (`$XDG_CONFIG_HOME/mend/cli.json` or `~/.mend/cli.json`)
 * purely as a read-only suggestion to pre-fill the Connect form on first launch. Never reads the
 * token and never writes to the CLI's file.
 */
export const readCliDefaultUrl = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null => {
  const envUrl = env["MEND_URL"];
  if (envUrl !== undefined && envUrl.trim() !== "") {
    const parsed = normalizeServerUrl(envUrl);
    if (parsed.ok) return parsed.url;
  }

  const xdg = env["XDG_CONFIG_HOME"];
  const preferred = path.join(
    xdg === undefined || xdg === "" ? path.join(homeDir, ".config") : xdg,
    "mend",
  );
  const legacy = path.join(homeDir, ".mend");
  const configDir = !fs.existsSync(preferred) && fs.existsSync(legacy) ? legacy : preferred;
  const file = path.join(configDir, "cli.json");
  if (!fs.existsSync(file)) return null;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed)) return null;
    return parseServerUrl(parsed["url"]);
  } catch {
    return null;
  }
};

export interface DesktopStore {
  readonly load: () => DesktopStoreState;
  readonly save: (next: DesktopStoreState) => void;
}

export const createDesktopStore = (userDataDir: string): DesktopStore => {
  const filePath = path.join(userDataDir, "desktop-state.json");

  const load = (): DesktopStoreState => {
    if (!fs.existsSync(filePath)) return EMPTY_STORE_STATE;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parseDesktopState(parsed);
    } catch {
      return EMPTY_STORE_STATE;
    }
  };

  const save = (next: DesktopStoreState): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on filesystems without POSIX mode bits.
    }
  };

  return { load, save };
};
