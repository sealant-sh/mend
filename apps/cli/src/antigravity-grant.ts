import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { throwawayLoginDir } from "./login-dir.ts";

/**
 * An Antigravity login of Mend's own (docs/adr/0008-one-refresher-for-provider-logins.md):
 * `agy acp --login` in a throwaway HOME, sent to the server and deleted. The laptop keeps no copy;
 * the server is the only refresher from then on.
 */

export interface AntigravityCli {
  /** The binary to run; `MEND_AGY_BIN` overrides it, which is also the test seam. */
  readonly bin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const antigravityCli = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AntigravityCli => ({
  bin: environment["MEND_AGY_BIN"] ?? "agy",
  env: environment,
});

/** Path of `antigravity-oauth-token` inside a home directory. */
export const antigravityTokenPath = (homeDir: string = os.homedir()): string =>
  path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");

/** Run `agy acp --login` into a throwaway `HOME`. */
export const runAntigravityLogin = (cli: AntigravityCli, homeDir: string): boolean => {
  const result = spawnSync(cli.bin, ["acp", "--login"], {
    stdio: "inherit",
    env: { ...cli.env, HOME: homeDir },
  });
  return result.error === undefined && result.status === 0;
};

const refreshTokenOf = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const token: unknown = (parsed as { token?: unknown }).token;
    if (typeof token !== "object" || token === null) return null;
    const refreshToken: unknown = (token as { refresh_token?: unknown }).refresh_token;
    return typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : null;
  } catch {
    return null;
  }
};

/** Whether two Antigravity token files hold the same refresh token. */
export const sameAntigravityLogin = (a: string, b: string): boolean => {
  const first = refreshTokenOf(a);
  return first !== null && first === refreshTokenOf(b);
};

export type AntigravityGrantResult =
  | { readonly kind: "grant"; readonly secret: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Sign Antigravity in for Mend inside a throwaway HOME and return the written
 * `antigravity-oauth-token` JSON. The throwaway directory is deleted either way.
 */
export const antigravityGrant = (input: {
  readonly cli: AntigravityCli;
  readonly personalTokenJson: string | null;
  readonly say: (line: string) => void;
  readonly parent: string;
}): AntigravityGrantResult => {
  const home = throwawayLoginDir(input.parent, "antigravity-login-");
  try {
    input.say(
      "  Mend needs its own Antigravity login; it is sent to your server and not kept here",
    );
    input.say("  your own Antigravity login stays as it is");
    if (!runAntigravityLogin(input.cli, home)) {
      return { kind: "failed", reason: "antigravity: the login did not complete" };
    }
    const file = antigravityTokenPath(home);
    if (!fs.existsSync(file)) {
      return {
        kind: "failed",
        reason: `antigravity: logged in, but no antigravity-oauth-token appeared in ${home}`,
      };
    }
    const secret = fs.readFileSync(file, "utf8").trim();
    if (refreshTokenOf(secret) === null) {
      return {
        kind: "failed",
        reason: "antigravity: the login wrote no refresh_token (cannot keep the session fresh)",
      };
    }
    if (input.personalTokenJson !== null && sameAntigravityLogin(secret, input.personalTokenJson)) {
      return {
        kind: "failed",
        reason:
          "antigravity: that is the same login this machine holds, so both sides would race on " +
          "refresh — connect it deliberately with --use-my-login",
      };
    }
    return { kind: "grant", secret };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};
