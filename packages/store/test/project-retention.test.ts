import { execFile } from "node:child_process";
import {
  chmodSync,
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
  it("counts a store as purged only once a lookup finds it gone, never when the lookup is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "mend-retention-refused-"));
    const repo = join(root, "p1", "repo.git");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "HEAD"), "kept");
    const run = <A, E>(work: Effect.Effect<A, E, Store>) =>
      Effect.runPromise(
        work.pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
      );
    try {
      // The store root loses traversal permission: its project directory is still there.
      chmodSync(root, 0o600);
      const refused = await run(Effect.flatMap(Store, (store) => store.removeProjectStore(repo)));
      chmodSync(root, 0o700);
      expect({ refused, kept: existsSync(join(repo, "HEAD")) }).toEqual({
        refused: { leftover: join(root, "p1") },
        kept: true,
      });
      expect(await run(Effect.flatMap(Store, (store) => store.removeProjectStore(repo)))).toEqual({
        leftover: null,
      });
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a kept store outside the root Mend runs with, and touches none of it", async () => {
    const root = mkdtempSync(join(tmpdir(), "mend-retention-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "mend-retention-elsewhere-"));
    const repo = join(elsewhere, "p1", "repo.git");
    mkdirSync(repo, { recursive: true });
    const run = <A, E>(work: Effect.Effect<A, E, Store>) =>
      Effect.runPromise(
        work.pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
      );
    try {
      expect(await run(Effect.flatMap(Store, (store) => store.removeProjectStore(repo)))).toEqual({
        leftover: join(elsewhere, "p1"),
        outsideRoot: root,
      });
      expect(
        await run(Effect.flatMap(Store, (store) => store.retainedStoreProblem(repo, []))),
      ).toContain(`outside the store root ${root}`);
      expect(existsSync(repo)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

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

  it("restores, measures and purges a store whose configured root is reached through a symbolic link", async () => {
    const real = mkdtempSync(join(tmpdir(), "mend-retention-real-"));
    const links = mkdtempSync(join(tmpdir(), "mend-retention-link-"));
    try {
      const root = join(links, "store");
      symlinkSync(real, root);
      const repo = join(root, "p1", "repo.git");
      mkdirSync(join(root, "p1"));
      await promisify(execFile)("git", ["-c", "init.templateDir=", "init", "--bare", repo]);
      mkdirSync(join(root, "p1", "worktrees", "fix"), { recursive: true });
      writeFileSync(join(root, "p1", "worktrees", "fix", "notes.txt"), "kept bytes");
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
      expect(await run(Effect.flatMap(Store, (store) => store.removeProjectStore(repo)))).toEqual({
        leftover: null,
      });
      expect(existsSync(join(real, "p1"))).toBe(false);
    } finally {
      rmSync(links, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
