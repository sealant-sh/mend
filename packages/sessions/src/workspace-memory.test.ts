import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { agentNameOf, parseWorkspaceMemory, WORKSPACE_MEMORY_SCRIPT } from "./workspace-memory.ts";

/** The script run against a fake cgroup tree, as a workspace would run it. */
const runAgainst = (files: Readonly<Record<string, string>>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cgroup-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    const script = WORKSPACE_MEMORY_SCRIPT.replaceAll("/sys/fs/cgroup", root);
    return spawnSync("sh", ["-c", script], { encoding: "utf8" }).stdout;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("the workspace memory reading", () => {
  it("reads a cgroup v2 workspace's limit and its kills", () => {
    const stdout = runAgainst({
      "memory.max": "4294967296\n",
      "memory.events": "low 0\nhigh 0\nmax 12\noom 2\noom_kill 2\noom_group_kill 0\n",
    });
    expect(parseWorkspaceMemory(stdout)).toEqual({ limitBytes: 4294967296, kills: 2 });
  });

  it("reads a cgroup v2 workspace with no limit as none", () => {
    const stdout = runAgainst({ "memory.max": "max\n", "memory.events": "oom_kill 0\n" });
    expect(parseWorkspaceMemory(stdout)).toEqual({ limitBytes: null, kills: 0 });
  });

  it("reads cgroup v1, whose no limit is the largest page-aligned number", () => {
    const stdout = runAgainst({
      "memory/memory.limit_in_bytes": "9223372036854771712\n",
      "memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 3\n",
    });
    expect(parseWorkspaceMemory(stdout)).toEqual({ limitBytes: null, kills: 3 });
  });

  it("says nothing for a workspace that is not a cgroup of its own", () => {
    expect(parseWorkspaceMemory(runAgainst({}))).toBeNull();
    expect(parseWorkspaceMemory("")).toBeNull();
    expect(parseWorkspaceMemory("limit 1024\n")).toBeNull();
  });

  it("names the agent as a person reads it", () => {
    expect(agentNameOf("claude")).toBe("Claude Code");
    expect(agentNameOf("codex")).toBe("Codex");
    expect(agentNameOf("shell")).toBe("the agent");
    expect(agentNameOf(null)).toBe("the agent");
  });
});
