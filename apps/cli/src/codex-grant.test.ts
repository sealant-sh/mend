import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { codexGrant, sameCodexLogin, type CodexCli } from "./codex-grant.ts";

const authJson = (refreshToken: string) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "at", refresh_token: refreshToken },
  });

const made: Array<string> = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `codex` that writes `content` into $CODEX_HOME/auth.json, or fails. */
const fakeCodex = (content: string | null, seen: { home?: string } = {}): CodexCli => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  made.push(dir);
  const bin = path.join(dir, "codex");
  const record = path.join(dir, "home");
  fs.writeFileSync(
    bin,
    content === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > '${record}'\nprintf '%s' '${content}' > "$CODEX_HOME/auth.json"\n`,
    { mode: 0o755 },
  );
  Object.defineProperty(seen, "home", { get: () => fs.readFileSync(record, "utf8") });
  return { bin, env: { PATH: process.env["PATH"] } };
};

describe("codexGrant", () => {
  it("logs in to a throwaway home, returns that login, and keeps no copy", () => {
    const seen: { home?: string } = {};
    const result = codexGrant({
      cli: fakeCodex(authJson("rt-mend"), seen),
      personalAuthJson: null,
      say: () => {},
    });
    expect(result).toEqual({ kind: "grant", secret: authJson("rt-mend") });
    expect(seen.home).toBeDefined();
    expect(fs.existsSync(seen.home ?? "")).toBe(false);
  });

  it("refuses the machine's own login rather than sending a shared one", () => {
    const result = codexGrant({
      cli: fakeCodex(authJson("rt-laptop")),
      personalAuthJson: authJson("rt-laptop"),
      say: () => {},
    });
    expect(result.kind).toBe("failed");
  });

  it("says so when the login does not complete, or wrote no ChatGPT session", () => {
    expect(codexGrant({ cli: fakeCodex(null), personalAuthJson: null, say: () => {} }).kind).toBe(
      "failed",
    );
    expect(
      codexGrant({
        cli: fakeCodex(JSON.stringify({ OPENAI_API_KEY: "sk" })),
        personalAuthJson: null,
        say: () => {},
      }).kind,
    ).toBe("failed");
  });
});

describe("sameCodexLogin", () => {
  it("compares refresh tokens", () => {
    expect(sameCodexLogin(authJson("a"), authJson("a"))).toBe(true);
    expect(sameCodexLogin(authJson("a"), authJson("b"))).toBe(false);
    expect(sameCodexLogin("{}", "{}")).toBe(false);
  });
});
