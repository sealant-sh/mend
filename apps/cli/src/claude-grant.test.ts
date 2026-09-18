import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeCli,
  claudeGrantDir,
  grantStatus,
  keychainService,
  personalClaudeDir,
  readGrant,
  runClaudeLogin,
} from "./claude-grant.ts";

const scratch: Array<string> = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-grant-"));
  scratch.push(dir);
  return dir;
};

/**
 * A stub `claude`: it answers `auth status --json` from a file the test controls, and records the
 * `CLAUDE_CONFIG_DIR` it was handed, which is the whole point of the isolation.
 */
const stubClaude = (
  answers: Record<string, unknown>,
  options: { readonly loginExit?: number } = {},
) => {
  const dir = tempDir();
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$CLAUDE_CONFIG_DIR $*" >> ${JSON.stringify(log)}
case "$2" in
  status) cat ${JSON.stringify(path.join(dir, "status.json"))} ;;
  login) exit ${String(options.loginExit ?? 0)} ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(answers));
  return {
    // The real `claudeCli()` inherits the environment; a stub needs PATH for `cat` and `echo`.
    cli: claudeCli({ ...process.env, MEND_CLAUDE_BIN: bin }),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []),
    setStatus: (next: Record<string, unknown>) =>
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(next)),
  };
};

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("where Mend keeps its own grant", () => {
  it("sits beside the CLI's own configuration, not in the person's Claude directory", () => {
    expect(claudeGrantDir("/home/x/.config/mend")).toBe("/home/x/.config/mend/claude-grant");
    expect(personalClaudeDir({})).toBe(path.join(os.homedir(), ".claude"));
    expect(personalClaudeDir({ CLAUDE_CONFIG_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(personalClaudeDir({ CLAUDE_CONFIG_DIR: "" })).toBe(path.join(os.homedir(), ".claude"));
  });

  /**
   * Decompiled from Claude Code 2.1.275 and unverified on a Mac, so the shape is pinned here: the
   * item name must depend on the directory, or Mend would read the person's grant.
   */
  it("names a Keychain item per config directory", () => {
    const dir = "/home/x/.config/mend/claude-grant";
    const expected = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(keychainService(dir)).toBe(`Claude Code-credentials-${expected}`);
    expect(keychainService(dir)).not.toBe(keychainService("/home/x/.claude"));
  });
});

describe("asking Claude about a grant", () => {
  it("reads the answer and the directory Claude says it used", () => {
    const stub = stubClaude({
      loggedIn: true,
      authMethod: "claude.ai",
      configDirectory: "/tmp/grant",
      email: "person@example.test",
      subscriptionType: "max",
    });
    expect(grantStatus(stub.cli, "/tmp/grant")).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      configDirectory: "/tmp/grant",
      email: "person@example.test",
      subscriptionType: "max",
    });
    // The directory travels as CLAUDE_CONFIG_DIR, which is what isolates the two grants.
    expect(stub.calls()[0]).toBe("/tmp/grant auth status --json");
  });

  it("reports a directory with no grant as not logged in, not as a failure", () => {
    const stub = stubClaude({ loggedIn: false, authMethod: "none", configDirectory: "/tmp/empty" });
    expect(grantStatus(stub.cli, "/tmp/empty")?.loggedIn).toBe(false);
  });

  /** "Could not ask" must not read as "not logged in": one is a missing tool, the other a fact. */
  it("answers null when Claude cannot be run or does not answer as JSON", () => {
    expect(
      grantStatus(claudeCli({ ...process.env, MEND_CLAUDE_BIN: "/nonexistent/claude" }), "/tmp/x"),
    ).toBeNull();
    const stub = stubClaude({});
    fs.writeFileSync(path.join(path.dirname(stub.cli.bin), "status.json"), "not json at all");
    expect(grantStatus(stub.cli, "/tmp/x")).toBeNull();
  });

  it("creates the grant directory before the login, and reports the login's exit", () => {
    const stub = stubClaude({ loggedIn: false }, { loginExit: 1 });
    const dir = path.join(tempDir(), "claude-grant");
    expect(runClaudeLogin(stub.cli, dir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const ok = stubClaude({ loggedIn: true });
    expect(runClaudeLogin(ok.cli, dir)).toBe(true);
    expect(ok.calls()[0]).toBe(`${dir} auth login --claudeai`);
  });
});

describe("reading the grant a login wrote", () => {
  it("prefers the file", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".credentials.json"), '{"claudeAiOauth":{}}\n');
    const read = readGrant(dir, "linux");
    expect(read.kind).toBe("file");
    expect(read.kind === "file" ? read.secret : "").toBe('{"claudeAiOauth":{}}');
  });

  it("says where it looked when there is nothing to read", () => {
    const dir = tempDir();
    const onLinux = readGrant(dir, "linux");
    expect(onLinux).toEqual({
      kind: "missing",
      triedPath: path.join(dir, ".credentials.json"),
      triedService: null,
    });
    // On a Mac the Keychain is the second place, so a failure names the item too.
    const onMac = readGrant(dir, "darwin");
    expect(onMac.kind).toBe("missing");
    expect(onMac.kind === "missing" ? onMac.triedService : null).toBe(keychainService(dir));
  });

  it("treats an empty file as nothing, so a half-written login is not sent", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".credentials.json"), "   \n");
    expect(readGrant(dir, "linux").kind).toBe("missing");
  });
});
