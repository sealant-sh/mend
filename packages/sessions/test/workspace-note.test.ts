import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { workspaceNoteExec } from "../src/workspace-note.ts";

describe("the workspace note in a launch's effective home", () => {
  it("honors harness config directories, preserves user text and modes, and creates private files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-resource-note-"));
    const home = path.join(root, "person's home");
    const claude = path.join(root, "conversation", ".claude");
    const codex = path.join(root, "conversation", ".codex");
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, "CLAUDE.md"), "# My instructions\nKeep this.\n", {
      mode: 0o640,
    });
    try {
      for (const level of ["project", "worktree"]) {
        const argv = workspaceNoteExec(`@db · ${level}\n`, {
          HOME: home,
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: codex,
        });
        const result = spawnSync(argv[0] ?? "sh", argv.slice(1), { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        const text = fs.readFileSync(path.join(claude, "CLAUDE.md"), "utf8");
        expect(text).toContain("# My instructions\nKeep this.\n");
        expect(text).toContain(`@db · ${level}`);
        if (level === "worktree") expect(text).not.toContain("@db · project");
      }
      expect(fs.statSync(path.join(claude, "CLAUDE.md")).mode & 0o777).toBe(0o640);
      const created = fs.statSync(path.join(codex, "AGENTS.md"));
      expect(created.mode & 0o777).toBe(0o600);
      expect(created.uid).toBe(process.getuid?.());
      expect(fs.existsSync(path.join(home, ".pi", "agent", "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(false);
    } finally {
      fs.readdirSync(root);
      fs.rmSync(root, { recursive: true });
    }
  });
});
