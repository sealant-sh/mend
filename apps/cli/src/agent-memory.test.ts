import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeMemoryDirFor, scanClaudeMemory } from "./agent-memory.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading this machine's Claude memory for a repository", () => {
  it("finds the directory Claude keeps for the checkout and reads it at a session's paths", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-claude-home-"));
    dirs.push(home);
    const memory = path.join(home, "projects", "-home-you-code-my-app", "memory");
    fs.mkdirSync(path.join(memory, "topics"), { recursive: true });
    fs.writeFileSync(path.join(memory, "MEMORY.md"), "- [build](topics/build.md)\n");
    fs.writeFileSync(path.join(memory, "topics", "build.md"), "pnpm, not npm\n");
    fs.mkdirSync(path.join(home, "projects", "-home-you-code-other", "memory"), {
      recursive: true,
    });

    // `my_app` and `my.app` both key to `my-app`.
    expect(claudeMemoryDirFor("/home/you/code/my_app", home)).toBe(memory);
    expect(claudeMemoryDirFor("/home/you/code/my.app", home)).toBe(memory);
    expect(claudeMemoryDirFor("/home/you/code/absent", home)).toBeNull();

    expect(scanClaudeMemory(memory).files).toEqual([
      {
        path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
        encoding: "utf8",
        contents: "- [build](topics/build.md)\n",
      },
      {
        path: ".claude/projects/-workspace-repo/memory/topics/build.md",
        encoding: "utf8",
        contents: "pnpm, not npm\n",
      },
    ]);
  });
});
