import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The machine's Mend credential: `$XDG_CONFIG_HOME/mend/cli.json` (default
 * `~/.config/mend`), the file `mend login` writes. The desktop reads and
 * writes the same file, so signing in once — from either side — serves both.
 * A pre-XDG `~/.mend` stays authoritative when it is the only one present
 * (mirrors the CLI's resolver; neither side depends on @mend/store).
 *
 * `MEND_URL` / `MEND_TOKEN` override the file, as they do for the CLI.
 */

export interface StoredConfig {
  readonly url: string;
  readonly token: string | null;
  /**
   * The device row the saved token belongs to (`mend login`, or the desktop's authorize), so
   * signing out can revoke it on the server. Null for a pasted token, or when MEND_TOKEN replaces
   * the file's token: the file's device is not the one in use then.
   */
  readonly deviceId: string | null;
}

const DEFAULT_URL = "http://localhost:3105";

const mendHome = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const preferred = path.join(
    xdg === undefined || xdg === "" ? path.join(os.homedir(), ".config") : xdg,
    "mend",
  );
  const legacy = path.join(os.homedir(), ".mend");
  return !fs.existsSync(preferred) && fs.existsSync(legacy) ? legacy : preferred;
};

export const configPath = (): string => path.join(mendHome(), "cli.json");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file as JSON, whatever else it holds; empty when absent or unreadable. */
const readRecord = (): Readonly<Record<string, unknown>> => {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const loadConfig = (): StoredConfig => {
  const file = readRecord();
  const envToken = process.env["MEND_TOKEN"];
  const fromEnv = envToken !== undefined && envToken !== "";
  return {
    url: process.env["MEND_URL"] ?? stringOrNull(file["url"]) ?? DEFAULT_URL,
    token: fromEnv ? envToken : stringOrNull(file["token"]),
    deviceId: fromEnv ? null : stringOrNull(file["deviceId"]),
  };
};

/**
 * The next file contents: the fields this app owns replaced, every other field the CLI (or a
 * later CLI) keeps there carried over untouched.
 */
export const mergeConfig = (
  existing: Readonly<Record<string, unknown>>,
  next: StoredConfig,
): Record<string, unknown> => ({
  ...existing,
  url: next.url,
  token: next.token,
  deviceId: next.deviceId,
});

/** 0600, like the CLI: the token is the only credential this machine holds. */
export const saveConfig = (next: StoredConfig): void => {
  const file = configPath();
  const merged = mergeConfig(readRecord(), next);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

/**
 * Watch the credential file so `mend login` / `mend logout` in a terminal
 * reach the running desktop without a restart. The directory is watched
 * (editors and the CLI replace the file rather than rewrite it in place).
 */
export const watchConfig = (onChange: () => void): (() => void) => {
  const file = configPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return () => {};
  let timer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(dir, (_event, name) => {
    if (name !== null && name !== path.basename(file)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
    watcher.close();
  };
};
