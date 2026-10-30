import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Store, StoreConfig } from "../src/store.ts";

describe("retained project files", () => {
  it("checks the kept repository without rewriting files, reports disk, and refuses missing worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "mend-retention-store-"));
    try {
      const repo = join(root, "p1", "repo.git");
      mkdirSync(join(root, "p1"));
      await promisify(execFile)("git", ["-c", "init.templateDir=", "init", "--bare", repo]);
      mkdirSync(join(root, "p1", "worktrees", "fix"), { recursive: true });
      const file = join(root, "p1", "worktrees", "fix", "ignored.secret");
      writeFileSync(file, "kept bytes");
      const run = <A, E>(work: Effect.Effect<A, E, Store>) =>
        Effect.runPromise(
          work.pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
        );
      expect(
        await run(Effect.flatMap(Store, (store) => store.retainedStoreProblem(repo, ["fix"]))),
      ).toBeNull();
      expect(
        await run(Effect.flatMap(Store, (store) => store.projectDiskUsage(repo))),
      ).toBeGreaterThan(0);
      expect(readFileSync(file, "utf8")).toBe("kept bytes");
      expect(
        await run(Effect.flatMap(Store, (store) => store.retainedStoreProblem(repo, ["missing"]))),
      ).toContain("missing");
      const link = join(root, "alias");
      symlinkSync(join(root, "p1"), link);
      expect(
        await run(
          Effect.flatMap(Store, (store) => store.retainedStoreProblem(join(link, "repo.git"), [])),
        ),
      ).toContain("symbolic link");
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
