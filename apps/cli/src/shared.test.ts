import { describe, expect, it } from "vitest";

import {
  isDetachChunk,
  isPasteChunk,
  parseLaunchArgs,
  pasteBytes,
  matchProjectByCwd,
  normalizeRemoteUrl,
  trackBracketedPaste,
} from "./shared.ts";

describe("isDetachChunk", () => {
  it("matches Ctrl+] in both wire encodings", () => {
    expect(isDetachChunk(Buffer.from([0x1d]))).toBe(true);
    expect(isDetachChunk(Buffer.from("ab\x1dcd", "latin1"))).toBe(true);
    // The kitty keyboard protocol (pushed by the claude TUI through the PTY)
    // re-encodes Ctrl+] as CSI-u; press and repeat count, release does not.
    expect(isDetachChunk(Buffer.from("\x1b[93;5u"))).toBe(true);
    expect(isDetachChunk(Buffer.from("\x1b[93;5:1u"))).toBe(true);
    expect(isDetachChunk(Buffer.from("\x1b[93;5:2u"))).toBe(true);
    expect(isDetachChunk(Buffer.from("\x1b[93;5:3u"))).toBe(false);
    // Lock modifiers reported alongside ctrl still detach.
    expect(isDetachChunk(Buffer.from("\x1b[93;133u"))).toBe(true);
    expect(isDetachChunk(Buffer.from("\x1b[93;133:2u"))).toBe(true);
    expect(isDetachChunk(Buffer.from("]"))).toBe(false);
    expect(isDetachChunk(Buffer.from("\x1b[93;1u"))).toBe(false);
    expect(isDetachChunk(Buffer.from("hello"))).toBe(false);
  });
});

describe("isPasteChunk", () => {
  it("matches exactly Ctrl+V in both wire encodings", () => {
    expect(isPasteChunk(Buffer.from([0x16]))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;5u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;5:1u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;5:2u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;5:3u"))).toBe(false);
    // A terminal asked to report all keys adds the lock modifiers: Num Lock (128), Caps (64).
    expect(isPasteChunk(Buffer.from("\x1b[118;133u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;69u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;197:1u"))).toBe(true);
    // Alternate key codes and the text field ride along without changing the key.
    expect(isPasteChunk(Buffer.from("\x1b[118:86;5u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;5;22u"))).toBe(true);
    // Shift+Ctrl+V is still a paste; Ctrl+Alt+V is another chord.
    expect(isPasteChunk(Buffer.from("\x1b[86;6u"))).toBe(true);
    expect(isPasteChunk(Buffer.from("\x1b[118;7u"))).toBe(false);
    // Two reports in one chunk are typing, not a request.
    expect(isPasteChunk(Buffer.from("\x1b[118;5u\x1b[118;5u"))).toBe(false);
    // A pasted blob that happens to carry 0x16 is not a paste request.
    expect(isPasteChunk(Buffer.from("ab\x16cd", "latin1"))).toBe(false);
    expect(isPasteChunk(Buffer.from("v"))).toBe(false);
    expect(isPasteChunk(Buffer.from([]))).toBe(false);
  });
});

describe("trackBracketedPaste", () => {
  it("follows the last mode change in a chunk and keeps state otherwise", () => {
    expect(trackBracketedPaste(Buffer.from("\x1b[?2004h"), false)).toBe(true);
    expect(trackBracketedPaste(Buffer.from("\x1b[?2004l"), true)).toBe(false);
    expect(trackBracketedPaste(Buffer.from("\x1b[?2004h..\x1b[?2004l"), true)).toBe(false);
    expect(trackBracketedPaste(Buffer.from("\x1b[?2004l..\x1b[?2004h"), false)).toBe(true);
    expect(trackBracketedPaste(Buffer.from("plain output"), true)).toBe(true);
    expect(trackBracketedPaste(Buffer.from("plain output"), false)).toBe(false);
  });

  it("wraps a paste only when the app asked", () => {
    expect(pasteBytes("/workspace/harness-home/paste/a.png", true).toString()).toBe(
      "\x1b[200~/workspace/harness-home/paste/a.png\x1b[201~",
    );
    expect(pasteBytes("/a.png", false).toString()).toBe("/a.png");
  });
});

describe("parseLaunchArgs", () => {
  it("parses a bare invocation to all-null", () => {
    expect(parseLaunchArgs([])).toEqual({
      project: null,
      prompt: null,
      model: null,
      effort: null,
      base: null,
      name: null,
      worktree: null,
      ask: false,
      fast: false,
      detach: false,
      foreground: false,
      noTunnel: false,
      custom: [],
      error: null,
    });
  });

  it("takes the first positional as the prompt and every flag by name", () => {
    const parsed = parseLaunchArgs([
      "fix the auth test",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--base",
      "release/1.2",
      "--ask",
      "--fast",
      "--project",
      "mend",
    ]);
    expect(parsed).toEqual({
      project: "mend",
      prompt: "fix the auth test",
      model: "sonnet",
      effort: "high",
      base: "release/1.2",
      name: null,
      worktree: null,
      ask: true,
      fast: true,
      detach: false,
      foreground: false,
      noTunnel: false,
      custom: [],
      error: null,
    });
  });

  it("takes --detach (and -d) and --foreground, refusing the contradiction", () => {
    expect(parseLaunchArgs(["--detach"]).detach).toBe(true);
    expect(parseLaunchArgs(["-d"]).detach).toBe(true);
    expect(parseLaunchArgs(["--foreground"]).foreground).toBe(true);
    expect(parseLaunchArgs(["-d", "--foreground"]).error).toContain("contradict");
  });

  it("takes --no-tunnel as the opt-out from attach tunnels", () => {
    expect(parseLaunchArgs([]).noTunnel).toBe(false);
    expect(parseLaunchArgs(["--no-tunnel", "fix it"])).toMatchObject({
      noTunnel: true,
      prompt: "fix it",
      error: null,
    });
  });

  it("rejects a second positional so a forgotten quote fails loudly", () => {
    expect(parseLaunchArgs(["fix", "the auth test"]).error).toContain("quote it");
  });

  it("rejects an unknown flag and a prompt starting with a dash", () => {
    expect(parseLaunchArgs(["--nope"]).error).toContain("unknown flag");
    expect(parseLaunchArgs(["-rf everything"]).error).toContain("unknown flag");
  });

  it("rejects a flag without a value and a bad effort level", () => {
    expect(parseLaunchArgs(["--model"]).error).toContain("needs a value");
    expect(parseLaunchArgs(["--effort", "extreme"]).error).toContain("--effort must be one of");
  });

  it("keeps everything after -- verbatim for mend run", () => {
    const parsed = parseLaunchArgs(["--project", "mend", "--", "npm", "test", "--force"]);
    expect(parsed.project).toBe("mend");
    expect(parsed.custom).toEqual(["npm", "test", "--force"]);
    expect(parsed.error).toBeNull();
  });
});

describe("normalizeRemoteUrl", () => {
  it("reduces every spelling of a remote to host/owner/name", () => {
    for (const raw of [
      "https://github.com/sealant-sh/mend",
      "https://github.com/sealant-sh/mend.git",
      "git@github.com:sealant-sh/mend.git",
      "ssh://git@github.com/sealant-sh/mend.git",
      "ssh://git@github.com:22/Sealant-sh/Mend/",
    ]) {
      expect(normalizeRemoteUrl(raw)).toBe("github.com/sealant-sh/mend");
    }
  });

  it("leaves local paths and nothing alone", () => {
    expect(normalizeRemoteUrl("/home/yiannis/dots")).toBeNull();
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl("  ")).toBeNull();
  });
});

describe("matchProjectByCwd", () => {
  const projects = [
    { name: "mend", originUrl: "https://github.com/sealant-sh/mend" },
    { name: "dots", originUrl: "/home/yiannis/dots" },
    { name: "mend-fork", originUrl: "git@github.com:someone/mend.git" },
  ];

  it("matches a GitHub-adopted project from any clone of the same remote", () => {
    expect(
      matchProjectByCwd(projects, {
        cwd: "/home/yiannis/Developer/OSS/Sealant/Mend/apps/cli",
        repoRoot: "/home/yiannis/Developer/OSS/Sealant/Mend",
        originUrl: "git@github.com:sealant-sh/mend.git",
      })?.name,
    ).toBe("mend");
  });

  it("prefers the path it was adopted from, including subdirectories", () => {
    expect(
      matchProjectByCwd(projects, {
        cwd: "/home/yiannis/dots/zsh",
        repoRoot: "/home/yiannis/dots",
        originUrl: "git@github.com:ypanagidis/dots.git",
      })?.name,
    ).toBe("dots");
    expect(
      matchProjectByCwd(projects, {
        cwd: "/home/yiannis/dotsfiles",
        repoRoot: null,
        originUrl: null,
      }),
    ).toBeUndefined();
  });

  it("falls back to the repository root's normalized name, case-insensitively", () => {
    expect(
      matchProjectByCwd(projects, {
        cwd: "/tmp/Mend/packages/api",
        repoRoot: "/tmp/Mend",
        originUrl: null,
      })?.name,
    ).toBe("mend");
    expect(
      matchProjectByCwd(projects, { cwd: "/tmp/Other", repoRoot: null, originUrl: null }),
    ).toBeUndefined();
  });
});
