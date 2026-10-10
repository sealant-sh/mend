import { describe, expect, it } from "vitest";

import {
  firstPositional,
  captureLineOf,
  isDetachChunk,
  isPasteChunk,
  parseLaunchArgs,
  pasteBytes,
  matchProjectByCwd,
  normalizeRemoteUrl,
  jsonWithoutCredentials,
  redactCredentials,
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
      autoLand: null,
      json: false,
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
      autoLand: null,
      json: false,
      custom: [],
      error: null,
    });
  });

  it("takes --json before the command, and leaves one after it to the command", () => {
    expect(parseLaunchArgs(["--json", "--", "make"]).json).toBe(true);
    const after = parseLaunchArgs(["--", "jq", "--json"]);
    expect(after.json).toBe(false);
    expect(after.custom).toEqual(["jq", "--json"]);
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

  it("takes --land and --no-land as this session's override, refusing both at once", () => {
    expect(parseLaunchArgs(["--land"]).autoLand).toBe(true);
    expect(parseLaunchArgs(["--no-land"]).autoLand).toBe(false);
    expect(parseLaunchArgs(["fix it", "-d"]).autoLand).toBeNull();
    expect(parseLaunchArgs(["--land", "--no-land"]).error).toContain("contradict");
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

describe("captureLineOf", () => {
  it("says what a stop is still saving, what it kept, and nothing for an older server", () => {
    expect(captureLineOf({ capturePending: 3, captureDrain: "stop" })).toBe("saving · 3 left");
    expect(
      captureLineOf({
        capturePending: 3,
        capturePendingBytes: 12_400_000,
        captureDrain: "replacement",
      }),
    ).toBe("saving · 12 MB left");
    expect(
      captureLineOf({
        capturePending: 3,
        captureDrain: "stop",
        captureNotSavedAt: "2026-09-27T10:00:00.000Z",
      }),
    ).toBe("not saved · 3 pending · workspace kept");
    expect(captureLineOf({ capturePending: 0, captureDrain: null })).toBeNull();
    expect(captureLineOf({})).toBeNull();
  });
});

describe("firstPositional", () => {
  it("takes the first word when no valued flag is present (mend stop <id>)", () => {
    expect(firstPositional(["a404034c"], ["--project"])).toBe("a404034c");
    expect(firstPositional(["a404034c", "--all"], ["--project"])).toBe("a404034c");
  });

  it("skips a valued flag's own word, wherever the flag stands", () => {
    expect(firstPositional(["--project", "mend", "a404034c"], ["--project"])).toBe("a404034c");
    expect(firstPositional(["a404034c", "--project", "mend"], ["--project"])).toBe("a404034c");
    expect(firstPositional(["--from", "12", "web"], ["--from"])).toBe("web");
    expect(firstPositional(["--project", "mend"], ["--project"])).toBeUndefined();
  });
});

describe("redactCredentials", () => {
  it("takes the credentials out of every URL in a line, and leaves the rest", () => {
    expect(
      redactCredentials(
        "origin https://oauth2:TOKEN@github.com/a/r.git · and https://TOKEN@h.io/x",
      ),
    ).toBe("origin https://github.com/a/r.git · and https://h.io/x");
    // An ssh user is no secret and stays; only its password goes.
    expect(redactCredentials("ssh://git:pw@host/x and ssh://git@host/y")).toBe(
      "ssh://git@host/x and ssh://git@host/y",
    );
    expect(redactCredentials("git@github.com:a/r.git")).toBe("git@github.com:a/r.git");
  });

  it("takes userinfo up to the last @ of the authority, as a URL parser reads it", () => {
    // Adoption accepts both: a literal `@` in a password left the token after it visible.
    expect(redactCredentials("https://oauth2:p@tok@github.com/acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(redactCredentials("ssh://git:p@tok@[::1]:2222/acme/repo.git")).toBe(
      "ssh://git@[::1]:2222/acme/repo.git",
    );
    expect(redactCredentials("ssh://git:secret@github.com/acme/r.git")).toBe(
      "ssh://git@github.com/acme/r.git",
    );
    // An ssh login stays and only its password goes, the server's rule (the CLI shares it).
    expect(redactCredentials("ssh://a b:pw@host/x")).toBe("ssh://a b@host/x");
    // scp-like has no `//`: nothing to take out, nothing changed.
    expect(redactCredentials("git@github.com:acme/r.git and git@[::1]:acme/r.git")).toBe(
      "git@github.com:acme/r.git and git@[::1]:acme/r.git",
    );
    expect(redactCredentials("ssh://a@tok@host/x")).toBe("ssh://host/x");
    expect(redactCredentials("https://u:p%40ss@h.io/x")).toBe("https://h.io/x");
    expect(redactCredentials("https://u:p@[::1]:8443/x")).toBe("https://[::1]:8443/x");
    expect(redactCredentials("ssh://git@[::1]:22/x")).toBe("ssh://git@[::1]:22/x");
    // Whitespace and control characters do not end the userinfo: a URL parser drops a tab or a
    // newline and encodes a space, so the rest is still the password.
    expect(
      redactCredentials("mend: unknown argument https://oauth2:p\tsecret@github.com/a/r"),
    ).toBe("mend: unknown argument https://github.com/a/r");
    expect(redactCredentials("https://oauth2:p\nsecret@github.com/a")).toBe("https://github.com/a");
    expect(redactCredentials("https://oauth2:p secret@github.com/a")).toBe("https://github.com/a");
    // Quotes are userinfo like any other character (review of mend#640); JSON output is
    // redacted one string at a time, so it stays JSON.
    expect(redactCredentials("http://user:se'cret@127.0.0.1/origin.git")).toBe(
      "http://127.0.0.1/origin.git",
    );
    expect(redactCredentials('https://u:"<x>"@h.io/x')).toBe("https://h.io/x");
    // An `@` past the authority (a query, a fragment) is no userinfo.
    expect(redactCredentials("https://h.io/x?u=a@b and https://h.io#f@x")).toBe(
      "https://h.io/x?u=a@b and https://h.io#f@x",
    );
    expect(redactCredentials("http://127.0.0.1:3105/sessions/1")).toBe(
      "http://127.0.0.1:3105/sessions/1",
    );
  });
});

describe("jsonWithoutCredentials", () => {
  it("redacts each string on its own, so the output is still JSON", () => {
    const printed = jsonWithoutCredentials({
      originUrl: "https://oauth2:TOKEN@github.com/acme/r.git",
      host: "https://h",
      email: "x@y",
      quoted: 'https://u:"TOKEN"@h.io',
      nested: [{ remote: "ssh://git:TOKEN@host/x" }],
      at: new Date("2026-10-10T00:00:00.000Z"),
    });
    expect(printed).not.toContain("TOKEN");
    expect(JSON.parse(printed)).toEqual({
      originUrl: "https://github.com/acme/r.git",
      host: "https://h",
      email: "x@y",
      quoted: "https://h.io",
      nested: [{ remote: "ssh://git@host/x" }],
      at: "2026-10-10T00:00:00.000Z",
    });
  });
});
