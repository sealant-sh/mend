import { randomUUID } from "node:crypto";
import { lstat, stat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { needsInput, type CommandResult } from "./command-result.ts";

const MANAGED = "<!-- mend-managed-skill:v1 -->";
const HOMES = [
  { agent: "claude", home: ".claude", skills: "skills" },
  { agent: "codex", home: ".codex", skills: "skills" },
  { agent: "pi", home: ".pi/agent", skills: "skills" },
];

const existing = async (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });

export const installAgentSkill = async (
  args: ReadonlyArray<string>,
  home = homedir(),
): Promise<CommandResult<unknown>> => {
  if (args.some((arg) => arg !== "--json"))
    return needsInput(
      "Agent install takes no positional arguments.",
      "Run mend agent install --json.",
    );
  try {
    const text = await readFile(new URL("./agent-skill.md", import.meta.url), "utf8");
    const plans: Array<{
      agent: string;
      path: string;
      state: "installed" | "updated" | "unchanged";
    }> = [];
    for (const agent of HOMES) {
      const root = join(home, agent.home);
      const rootInfo = await stat(root).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (!rootInfo?.isDirectory()) continue;
      const path = join(root, agent.skills, "mend", "SKILL.md");
      const found = await existing(path);
      if (found !== null && (!found.isFile() || found.isSymbolicLink()))
        return needsInput(
          "A non-file occupies a skill destination.",
          `Preserve ${path} at another path, then retry mend agent install --json.`,
        );
      const previous = found === null ? null : await readFile(path, "utf8");
      if (previous !== null && previous !== text && !previous.includes(MANAGED))
        return needsInput(
          "A custom Mend skill already occupies a destination.",
          `Preserve ${path} at another path, then retry mend agent install --json.`,
        );
      plans.push({
        agent: agent.agent,
        path,
        state: previous === text ? "unchanged" : previous === null ? "installed" : "updated",
      });
    }
    if (plans.length === 0)
      return needsInput(
        "No supported agent home was found.",
        "Start Claude Code, Codex or pi once to create its home, then retry mend agent install --json.",
      );
    for (const plan of plans) {
      if (plan.state === "unchanged") continue;
      await mkdir(dirname(plan.path), { recursive: true });
      const temporary = join(dirname(plan.path), `.SKILL-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        await rename(temporary, plan.path);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
      }
    }
    return {
      status: "done",
      data: { installs: plans, next: "Read an installed SKILL.md and follow its workflow." },
    };
  } catch {
    return {
      status: "failed",
      error: {
        code: "skill_install_failed",
        message: "The bundled skill could not be installed completely.",
        fix: "Check permissions on the reported agent homes and reinstall @sealant/mend if its bundled skill is missing, then retry mend agent install --json.",
      },
    };
  }
};
