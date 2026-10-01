import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { throwawayLoginDir } from "./login-dir.ts";

/**
 * A Codex login of Mend's own (docs/adr/0008-one-refresher-for-provider-logins.md), the Codex half of
 * ADR 0005's grant: `codex login --device-auth` in a throwaway CODEX_HOME, sent to the server and
 * deleted. The laptop keeps no copy. The server is the only refresher of the login from then on, so a
 * copy kept here would soon hold a spent refresh token, and sending it again would replace a good
 * login with a dead one. Every `mend connect codex` is therefore a fresh login.
 */

export interface CodexCli {
  /** The binary to run; `MEND_CODEX_BIN` overrides it, which is also the test seam. */
  readonly bin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const codexCli = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CodexCli => ({
  bin: environment["MEND_CODEX_BIN"] ?? "codex",
  env: environment,
});

/** The machine's own Codex home — the one Mend must not send by default. */
export const personalCodexHome = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configured = environment["CODEX_HOME"];
  return configured === undefined || configured === ""
    ? path.join(os.homedir(), ".codex")
    : configured;
};

/** Run the provider's own device-code login into `codexHome`, which must already exist. */
export const runCodexDeviceLogin = (cli: CodexCli, codexHome: string): boolean => {
  const result = spawnSync(cli.bin, ["login", "--device-auth"], {
    stdio: "inherit",
    env: { ...cli.env, CODEX_HOME: codexHome },
  });
  return result.error === undefined && result.status === 0;
};

const refreshTokenOf = (authJson: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(authJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const tokens: unknown = (parsed as { tokens?: unknown }).tokens;
    if (typeof tokens !== "object" || tokens === null) return null;
    const refreshToken: unknown = (tokens as { refresh_token?: unknown }).refresh_token;
    return typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : null;
  } catch {
    return null;
  }
};

/** Whether two auth.json files are one login (they hold the same refresh token). */
export const sameCodexLogin = (a: string, b: string): boolean => {
  const first = refreshTokenOf(a);
  return first !== null && first === refreshTokenOf(b);
};

export type CodexGrantResult =
  | { readonly kind: "grant"; readonly secret: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Log Codex in for Mend and return the new auth.json. The throwaway home is removed whatever
 * happens. `personalAuthJson` is this machine's own login, if any: a result equal to it means Codex
 * ignored CODEX_HOME, and sending it would share the laptop's login after all.
 */
export const codexGrant = (input: {
  readonly cli: CodexCli;
  readonly personalAuthJson: string | null;
  readonly say: (line: string) => void;
  /**
   * Where the throwaway home is made: Mend's own config directory, not the system temp directory,
   * where Codex refuses to create its helper binaries and says so on every login.
   */
  readonly parent: string;
}): CodexGrantResult => {
  const home = throwawayLoginDir(input.parent, "codex-login-");
  try {
    input.say("  Mend needs its own Codex login; it is sent to your server and not kept here");
    input.say("  your own Codex login stays as it is");
    if (!runCodexDeviceLogin(input.cli, home)) {
      return { kind: "failed", reason: "codex: the login did not complete" };
    }
    const file = path.join(home, "auth.json");
    if (!fs.existsSync(file)) {
      return { kind: "failed", reason: `codex: logged in, but no auth.json appeared in ${home}` };
    }
    const secret = fs.readFileSync(file, "utf8").trim();
    if (refreshTokenOf(secret) === null) {
      return {
        kind: "failed",
        reason:
          "codex: the login wrote no ChatGPT session (an API key login has nothing to refresh)",
      };
    }
    if (input.personalAuthJson !== null && sameCodexLogin(secret, input.personalAuthJson)) {
      return {
        kind: "failed",
        reason:
          "codex: that is the same login this machine's Codex holds, so both sides would race on " +
          "refresh — connect it deliberately with --use-my-login",
      };
    }
    return { kind: "grant", secret };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};
