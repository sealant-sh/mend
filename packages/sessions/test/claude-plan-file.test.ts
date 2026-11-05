import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { claudePlanFileArgv } from "../src/claude-plan-file.ts";

const nativeSession = "87dac613-2a01-43da-8cee-28d119513ead";

/** Real managed directory aliases and native transcript, with no provider login or API server. */
const withPlan = (
  kind: "person" | "shared" | "neutral",
  run: (plan: ReturnType<typeof prepare>) => void,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-claude-plan-test-"));
  try {
    run(prepare(root, kind));
  } finally {
    // List the exact owned directory before removing it; never clean another task's scratch.
    console.info("Removing owned plan fixture", root, fs.readdirSync(root));
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const prepare = (root: string, kind: "person" | "shared" | "neutral") => {
  const home = path.join(root, "personal-home");
  const config = path.join(
    kind === "neutral" ? path.join(root, "conversation-home") : home,
    ".claude",
  );
  const saved = path.join(root, "saved", ".claude");
  const cwd = path.join(root, "repo");
  const project = path.join(saved, "projects", cwd.replaceAll(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(saved, "plans"));
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  if (kind === "shared") fs.symlinkSync(saved, config);
  else {
    fs.mkdirSync(config, { recursive: true });
    fs.symlinkSync(path.join(saved, "plans"), path.join(config, "plans"));
    fs.symlinkSync(path.join(saved, "projects"), path.join(config, "projects"));
  }
  const requested = path.join(config, "plans", "mellow-tumbling-planet.md");
  const blocked = path.join(saved, "plans", path.basename(requested));
  const transcript = path.join(project, `${nativeSession}.jsonl`);
  const attachment = {
    type: "attachment",
    sessionId: nativeSession,
    cwd,
    isSidechain: false,
    attachment: { type: "plan_mode", isSubAgent: false, planFilePath: requested },
  };
  const record = (entry: unknown) => fs.writeFileSync(transcript, `${JSON.stringify(entry)}\n`);
  record(attachment);
  const scope = {
    savedClaudeDirectory: saved,
    cwd,
    providerSessionId: nativeSession,
    configDirectory: kind === "shared" ? undefined : config,
  };
  const check = (file = requested, landing = blocked) => {
    const [command, ...args] = claudePlanFileArgv(scope, file, landing);
    if (command === undefined) throw new Error("missing executable");
    return (
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: 5_000,
        // A neutral conversation's personal HOME is deliberately not its Claude config directory.
        env: { PATH: process.env["PATH"], HOME: home, CLAUDE_CONFIG_DIR: "" },
      }) === "true"
    );
  };
  return {
    root,
    saved,
    config,
    requested,
    blocked,
    project,
    transcript,
    attachment,
    scope,
    record,
    check,
  };
};

describe("executor-owned native Claude plan identity", () => {
  it("recognizes native metadata recorded under the workspace link's physical directory", () => {
    withPlan("person", (p) => {
      const alias = path.join(p.root, "workspace-repo");
      fs.symlinkSync(p.scope.cwd, alias);
      const [command, ...args] = claudePlanFileArgv(
        { ...p.scope, cwd: alias },
        p.requested,
        p.blocked,
      );
      if (command === undefined) throw new Error("missing executable");
      expect(
        execFileSync(command, args, {
          encoding: "utf8",
          timeout: 5_000,
          env: { PATH: process.env["PATH"] },
        }),
      ).toBe("true");
    });
  });

  for (const kind of ["person", "shared", "neutral"] as const)
    it(`recognizes the first Write and a regular refinement in a ${kind} home`, () => {
      withPlan(kind, (p) => {
        expect(fs.existsSync(p.blocked)).toBe(false);
        expect(p.check()).toBe(true);
        fs.writeFileSync(p.blocked, "# Plan");
        expect(p.check()).toBe(true);
      });
    });

  it("rejects paths the native transcript did not select, including equivalent spellings", () => {
    withPlan("person", (p) => {
      for (const file of [
        p.requested.replace("planet.md", "planet-extra.md"),
        p.requested.replace("plans/", "plans/../plans/"),
        p.requested.replace("plans/", "plans/./"),
        p.requested.replace("plans/", "plans//"),
        p.requested.replace("personal-home", "other-home"),
        path.join(p.root, "repo", ".claude", "plans", path.basename(p.requested)),
      ])
        expect(p.check(file)).toBe(false);
      expect(p.check(p.requested, p.blocked.replace("planet.md", "planet2.md"))).toBe(false);
      expect(p.check(p.requested, p.requested)).toBe(false);
    });
  });

  it("needs this native session's root attachment and its latest selected path", () => {
    withPlan("person", (p) => {
      for (const changes of [
        { sessionId: "foreign-session" },
        { cwd: "/foreign" },
        { isSidechain: true },
        { attachment: { ...p.attachment.attachment, isSubAgent: true } },
        { attachment: { ...p.attachment.attachment, planFilePath: p.blocked } },
      ]) {
        p.record({ ...p.attachment, ...changes });
        expect(p.check()).toBe(false);
      }
      p.record(p.attachment);
      fs.appendFileSync(
        p.transcript,
        `${JSON.stringify({
          ...p.attachment,
          attachment: { type: "plan_mode_exit" },
        })}\n`,
      );
      expect(p.check()).toBe(false);
      fs.unlinkSync(p.transcript);
      expect(p.check()).toBe(false);
    });
  }, 15_000);

  it("waits for Claude's delayed native transcript flush before the first Write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-claude-plan-flush-test-"));
    try {
      const p = prepare(root, "person");
      fs.unlinkSync(p.transcript);
      const [command, ...args] = claudePlanFileArgv(
        {
          savedClaudeDirectory: p.saved,
          cwd: p.attachment.cwd,
          configDirectory: p.config,
          providerSessionId: nativeSession,
        },
        p.requested,
        p.blocked,
      );
      if (command === undefined) throw new Error("missing executable");
      const result = new Promise<string>((resolve, reject) => {
        execFile(
          command,
          args,
          { encoding: "utf8", timeout: 5_000, env: { PATH: process.env["PATH"] } },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      p.record(p.attachment);
      expect(await result).toBe("true");
    } finally {
      console.info("Removing owned plan fixture", root, fs.readdirSync(root));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not exempt a leaf symlink, hardlink, directory or changed managed target", () => {
    withPlan("person", (p) => {
      const other = path.join(p.root, "other.md");
      fs.writeFileSync(other, "private");
      fs.symlinkSync(other, p.blocked);
      expect(p.check()).toBe(false);
      fs.unlinkSync(p.blocked);
      fs.linkSync(other, p.blocked);
      expect(p.check()).toBe(false);
      fs.unlinkSync(p.blocked);
      fs.mkdirSync(p.blocked);
      expect(p.check()).toBe(false);
      fs.rmdirSync(p.blocked);
      fs.unlinkSync(path.join(p.config, "plans"));
      fs.symlinkSync(p.root, path.join(p.config, "plans"));
      expect(p.check()).toBe(false);
    });
  });

  it("does not trust a linked transcript or a linked saved project", () => {
    withPlan("person", (p) => {
      const other = path.join(p.root, "other.jsonl");
      fs.renameSync(p.transcript, other);
      fs.symlinkSync(other, p.transcript);
      expect(p.check()).toBe(false);
      fs.unlinkSync(p.transcript);
      fs.linkSync(other, p.transcript);
      expect(p.check()).toBe(false);
      fs.unlinkSync(p.transcript);
      fs.renameSync(other, p.transcript);
      const moved = path.join(p.root, "moved-project");
      fs.renameSync(p.project, moved);
      fs.symlinkSync(moved, p.project);
      expect(p.check()).toBe(false);
    });
  });
});
