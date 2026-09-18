import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A Claude login that belongs to Mend, not to this machine's own Claude
 * (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
 *
 * Claude Code rotates its refresh token: a refresh answers with a new one and the old one dies. So
 * two copies of one grant race, and the copy that refreshes second is logged out. Mend refreshes
 * on a schedule and a laptop refreshes when someone uses it, which makes the laptop the loser. The
 * way out is not a cleverer copy; it is a second grant.
 *
 * `CLAUDE_CONFIG_DIR` is what makes that possible, and it isolates completely — verified against
 * Claude Code 2.1.275: `claude auth status --json` against an empty directory answers
 * `loggedIn: false`, `authMethod: "none"`, and echoes the `configDirectory` it read. Mend logs in
 * once against a directory of its own and reads the grant from there.
 */

/** Where Mend keeps its own Claude login. `$XDG_CONFIG_HOME/mend`, as the CLI's own config does. */
export const claudeGrantDir = (home: string): string => path.join(home, "claude-grant");

/** The machine's own Claude configuration — the one Mend must not touch. */
export const personalClaudeDir = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configured = environment["CLAUDE_CONFIG_DIR"];
  return configured === undefined || configured === ""
    ? path.join(os.homedir(), ".claude")
    : configured;
};

/**
 * The Keychain item a login into `configDir` writes on macOS. Claude Code 2.1.275 builds the
 * service name as `Claude Code-credentials`, plus `-` and the first eight characters of
 * `sha256(configDir)` when `CLAUDE_CONFIG_DIR` is set — so Mend's own directory has its own item
 * and Mend never reads the person's. Decompiled from the shipped bundle and **unverified on a
 * Mac**: if a Mac writes the file instead, the file is found first and this is never used.
 */
export const keychainService = (configDir: string): string => {
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
};

/** What `claude auth status --json` says. Absent fields read as unknown, never as false. */
export interface GrantStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
  /** The directory Claude reported reading — proof the isolation took effect. */
  readonly configDirectory: string | null;
  readonly email: string | null;
  readonly subscriptionType: string | null;
}

export interface ClaudeCli {
  /** The binary to run; `MEND_CLAUDE_BIN` overrides it, which is also the test seam. */
  readonly bin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const claudeCli = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeCli => ({
  bin: environment["MEND_CLAUDE_BIN"] ?? "claude",
  env: environment,
});

/**
 * Ask Claude about the grant in `configDir`. Null means the question could not be asked — Claude
 * Code is not installed, or it failed to answer as JSON — which is different from "not logged in"
 * and must be reported differently.
 */
export const grantStatus = (cli: ClaudeCli, configDir: string): GrantStatus | null => {
  const result = spawnSync(cli.bin, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: { ...cli.env, CLAUDE_CONFIG_DIR: configDir },
    timeout: 60_000,
  });
  if (result.error !== undefined || typeof result.stdout !== "string") return null;
  const start = result.stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout.slice(start));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record: Record<string, unknown> = { ...parsed };
    const text = (key: string) =>
      typeof record[key] === "string" ? (record[key] as string) : null;
    return {
      loggedIn: record["loggedIn"] === true,
      authMethod: text("authMethod"),
      configDirectory: text("configDirectory"),
      email: text("email"),
      subscriptionType: text("subscriptionType"),
    };
  } catch {
    return null;
  }
};

/** Run the browser login for `configDir`, with the terminal attached. True when Claude exited 0. */
export const runClaudeLogin = (cli: ClaudeCli, configDir: string): boolean => {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const result = spawnSync(cli.bin, ["auth", "login", "--claudeai"], {
    stdio: "inherit",
    env: { ...cli.env, CLAUDE_CONFIG_DIR: configDir },
  });
  return result.error === undefined && result.status === 0;
};

/** Where a grant was found, so a failure can say where Mend looked. */
export type GrantRead =
  | { readonly kind: "file"; readonly secret: string; readonly path: string }
  | { readonly kind: "keychain"; readonly secret: string; readonly service: string }
  | { readonly kind: "missing"; readonly triedPath: string; readonly triedService: string | null };

/**
 * Read the grant a login wrote into `configDir`: the file first, then — on macOS only — the
 * Keychain item for that directory.
 */
export const readGrant = (configDir: string, platform: string = process.platform): GrantRead => {
  const file = path.join(configDir, ".credentials.json");
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, "utf8").trim();
    if (secret !== "") return { kind: "file", secret, path: file };
  }
  if (platform !== "darwin") return { kind: "missing", triedPath: file, triedService: null };
  const service = keychainService(configDir);
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", os.userInfo().username, "-w", "-s", service],
    { encoding: "utf8", timeout: 60_000 },
  );
  const secret = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && secret !== ""
    ? { kind: "keychain", secret, service }
    : { kind: "missing", triedPath: file, triedService: service };
};
