import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  antigravityGrant,
  sameAntigravityLogin,
  type AntigravityCli,
} from "./antigravity-grant.ts";

const tokenJson = (refreshToken: string) =>
  JSON.stringify({
    token: {
      access_token: "ya29.test",
      refresh_token: refreshToken,
      token_type: "Bearer",
      expiry: "2026-11-22T12:00:00Z",
    },
  });

const made: Array<string> = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `agy` that writes `content` into $HOME/.gemini/antigravity-cli/antigravity-oauth-token. */
const fakeAgy = (
  content: string | null,
  seen: { home?: string; args?: string } = {},
): AntigravityCli => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-"));
  made.push(dir);
  const bin = path.join(dir, "agy");
  const homeRecord = path.join(dir, "home");
  const argsRecord = path.join(dir, "args");
  fs.writeFileSync(
    bin,
    content === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh
printf '%s' "$HOME" > '${homeRecord}'
printf '%s' "$*" > '${argsRecord}'
mkdir -p "$HOME/.gemini/antigravity-cli"
printf '%s' '${content}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
`,
    { mode: 0o755 },
  );
  Object.defineProperty(seen, "home", { get: () => fs.readFileSync(homeRecord, "utf8") });
  Object.defineProperty(seen, "args", { get: () => fs.readFileSync(argsRecord, "utf8") });
  return { bin, env: { PATH: process.env["PATH"] } };
};

const mendHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-home-"));
  made.push(dir);
  return dir;
};

describe("antigravityGrant", () => {
  it("logs in to a throwaway HOME under Mend's directory, returns that login, and keeps no copy", () => {
    const seen: { home?: string; args?: string } = {};
    const parent = mendHome();
    const result = antigravityGrant({
      cli: fakeAgy(tokenJson("1//rt-mend"), seen),
      personalTokenJson: null,
      say: () => {},
      parent,
    });
    expect(result).toEqual({ kind: "grant", secret: tokenJson("1//rt-mend") });
    expect(seen.args).toBe("acp --login");
    expect(path.dirname(seen.home ?? "")).toBe(parent);
    expect(fs.existsSync(seen.home ?? "")).toBe(false);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it("refuses the machine's own login rather than sending a shared one", () => {
    const result = antigravityGrant({
      cli: fakeAgy(tokenJson("1//rt-laptop")),
      personalTokenJson: tokenJson("1//rt-laptop"),
      say: () => {},
      parent: mendHome(),
    });
    expect(result.kind).toBe("failed");
  });

  it("says so when the login does not complete, or wrote no OAuth refresh token", () => {
    expect(
      antigravityGrant({
        cli: fakeAgy(null),
        personalTokenJson: null,
        say: () => {},
        parent: mendHome(),
      }).kind,
    ).toBe("failed");
    expect(
      antigravityGrant({
        cli: fakeAgy(JSON.stringify({ access_token: "ya29.only" })),
        personalTokenJson: null,
        say: () => {},
        parent: mendHome(),
      }).kind,
    ).toBe("failed");
  });
});

describe("sameAntigravityLogin", () => {
  it("compares refresh tokens", () => {
    expect(sameAntigravityLogin(tokenJson("1//a"), tokenJson("1//a"))).toBe(true);
    expect(sameAntigravityLogin(tokenJson("1//a"), tokenJson("1//b"))).toBe(false);
    expect(sameAntigravityLogin("{}", "{}")).toBe(false);
  });
});
