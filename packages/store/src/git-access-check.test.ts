import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { checkGitAccess } from "./git-access-check.ts";

describe("Git access observations against real repositories", () => {
  it("reads and dry-runs without publishing refs, and observes a refused push separately", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-git-access-"));
    const env = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
    };
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@mend.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        {
          cwd,
          env: { ...process.env, ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    try {
      run(root, ["init", "--bare", "--initial-branch=main", "origin.git"]);
      run(root, ["init", "--initial-branch=main", "checkout"]);
      const checkout = path.join(root, "checkout");
      run(checkout, ["commit", "--allow-empty", "-m", "initial"]);
      run(checkout, ["remote", "add", "origin", path.join(root, "origin.git")]);
      run(checkout, ["push", "origin", "HEAD:refs/heads/main"]);
      const before = run(root, ["--git-dir=origin.git", "show-ref"]);
      const report = await Effect.runPromise(checkGitAccess(checkout, env));
      expect(report).toMatchObject({
        read: { state: "ok", method: "ls-remote" },
        push: { state: "ok", method: "push-dry-run" },
        observedAt: expect.any(String),
      });
      expect(run(root, ["--git-dir=origin.git", "show-ref"])).toBe(before);
      run(checkout, ["config", "remote.origin.receivepack", "false"]);
      const refused = await Effect.runPromise(checkGitAccess(checkout, env));
      expect(refused).toMatchObject({ read: { state: "ok" }, push: { state: "failed" } });
      expect(run(root, ["--git-dir=origin.git", "show-ref"])).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
