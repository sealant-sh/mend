import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { harnessWarmupArgv, isOutputEntry } from "./agent-start.ts";

describe("isOutputEntry", () => {
  it("is an output chunk with bytes in it, and nothing else", () => {
    expect(isOutputEntry({ kind: "ioChunk", data: { byteCount: "312" } })).toBe(true);
    expect(isOutputEntry({ kind: "ioChunk", data: { byteCount: "0" } })).toBe(false);
    expect(isOutputEntry({ kind: "ioChunk", data: { byteCount: 12 } })).toBe(true);
    // A count that does not parse: the chunk exists because something was written.
    expect(isOutputEntry({ kind: "ioChunk", data: { byteCount: "many" } })).toBe(true);
    expect(isOutputEntry({ kind: "ioChunk", data: {} })).toBe(true);
    expect(isOutputEntry({ kind: "runtimeHeartbeat", data: {} })).toBe(false);
    expect(isOutputEntry({ kind: "processStarted", data: {} })).toBe(false);
  });
});

describe("harnessWarmupArgv", () => {
  it("warms the coding-agent harnesses by name, and nothing else", () => {
    for (const harness of ["claude", "codex", "opencode"]) {
      const argv = harnessWarmupArgv(harness);
      expect(argv?.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(argv?.slice(3)).toEqual(["sh", harness]);
    }
    expect(harnessWarmupArgv("shell")).toBeNull();
    expect(harnessWarmupArgv("run")).toBeNull();
    expect(harnessWarmupArgv("aider")).toBeNull();
  });

  /**
   * The script itself, against a stand-in harness that writes everywhere a real one might at start:
   * its HOME, its config roots, the directory it was started in. None of it may land in the user's
   * HOME or worktree, and the throwaway directory goes.
   */
  it.skipIf(process.platform === "win32")(
    "reads the harness and asks its version without writing into the home or the worktree",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-warmup-test-"));
      try {
        const home = path.join(root, "home");
        const worktree = path.join(root, "worktree");
        const bin = path.join(root, "bin");
        const scratch = path.join(root, "tmp");
        for (const dir of [home, worktree, bin, scratch]) fs.mkdirSync(dir);
        const seen = path.join(root, "seen");
        // A harness whose `--version` writes into HOME, its config root and its cwd.
        fs.writeFileSync(
          path.join(bin, "claude"),
          [
            "#!/bin/sh",
            `printf '%s\\n' "$1|$HOME|$PWD|$CLAUDE_CONFIG_DIR" > "${seen}"`,
            'mkdir -p "$HOME/.claude" && echo state > "$HOME/.claude.json"',
            'mkdir -p "$CLAUDE_CONFIG_DIR" && echo config > "$CLAUDE_CONFIG_DIR/settings.json"',
            "echo '2.1.285 (Claude Code)'",
          ].join("\n"),
          { mode: 0o755 },
        );
        const argv = harnessWarmupArgv("claude");
        if (argv === null) throw new Error("claude has a warm-up");
        const [command, ...args] = argv;
        const result = spawnSync(command ?? "sh", args, {
          cwd: worktree,
          env: {
            PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
            HOME: home,
            TMPDIR: scratch,
          },
          encoding: "utf8",
        });
        expect(result.status).toBe(0);
        const [flag, ranHome, ranCwd, configRoot] = fs.readFileSync(seen, "utf8").trim().split("|");
        expect(flag).toBe("--version");
        expect(ranCwd).toBe("/");
        expect(ranHome).not.toBe(home);
        expect(configRoot?.startsWith(ranHome ?? "")).toBe(true);
        // Nothing reached the user's home or worktree, and the throwaway home is gone.
        expect(fs.readdirSync(home)).toEqual([]);
        expect(fs.readdirSync(worktree)).toEqual([]);
        expect(fs.readdirSync(scratch)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "answers at once for a harness that is not installed",
    () => {
      const argv = harnessWarmupArgv("opencode");
      if (argv === null) throw new Error("opencode has a warm-up");
      const [, ...args] = argv;
      const result = spawnSync("/bin/sh", args, {
        env: { PATH: "/nonexistent" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    },
  );
});
