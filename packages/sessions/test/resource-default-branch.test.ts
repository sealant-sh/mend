import * as fs from "node:fs";
import * as path from "node:path";

import { StoreRefsRepo } from "@mend/db";
import { ProjectId, Sha } from "@mend/domain";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { readDefaultBranchTables } from "../src/resources/worktree-tables.ts";
import { SessionRepositoryCapturedLive } from "../src/session-repository-captured.ts";
import { SessionRepository } from "../src/session-repository.ts";
import {
  WorktreeReads,
  WorktreeReadsColocatedLive,
  WorktreeReadsCapturedLive,
  DefaultBranchUnavailableError,
  WORKTREE_STAMP,
} from "../src/worktree-reads.ts";
import { makeCaptureWorld, newWorktreeId, sh, worktreeRowFor } from "./capture-world.ts";

const table = '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n';
const stamp = (text: string | null) => ({
  value:
    text === null
      ? null
      : {
          bytes: new TextEncoder().encode(text),
          size: text.length,
          truncated: false,
          binary: false,
        },
  stamp: WORKTREE_STAMP,
});
describe("default branch resource tables", () => {
  it("uses the preferred file and never combines it with the root fallback", async () => {
    const paths: string[] = [];
    const read = await Effect.runPromise(
      readDefaultBranchTables(
        {
          readDefaultBranchFile: (_, name) => {
            paths.push(name);
            return Effect.succeed(stamp(table));
          },
        },
        ProjectId.make("p"),
      ),
    );
    expect(paths).toEqual([".mend/mend.toml"]);
    expect(read.kind === "read" && read.tables.map((def) => def.name)).toEqual(["db"]);
  });
  it("uses the root fallback, distinguishes an absent file from an unavailable ref", async () => {
    const read = (text: string | null) =>
      Effect.runPromise(
        readDefaultBranchTables(
          {
            readDefaultBranchFile: (_, name) =>
              Effect.succeed(stamp(name === "mend.toml" ? text : null)),
          },
          ProjectId.make("p"),
        ),
      );
    expect((await read(table)).kind).toBe("read");
    expect((await read(null)).kind).toBe("absent");
    const unavailable = await Effect.runPromise(
      readDefaultBranchTables(
        {
          readDefaultBranchFile: () =>
            Effect.fail(new DefaultBranchUnavailableError({ message: "missing" })),
        },
        ProjectId.make("p"),
      ),
    );
    expect(unavailable).toEqual({
      kind: "unavailable",
      message: "the default branch is not available on this server",
    });
  });
  it("reads a co-located default branch with no worktrees, including root fallback and absent/unavailable refs", async () => {
    const world = makeCaptureWorld();
    const runtime = ManagedRuntime.make(
      WorktreeReadsColocatedLive.pipe(Layer.provide(world.layer)),
    );
    const read = () =>
      runtime.runPromise(
        Effect.flatMap(WorktreeReads, (reads) => readDefaultBranchTables(reads, world.project.id)),
      );
    try {
      expect((await read()).kind).toBe("absent");
      const work = path.join(world.scratch, "work");
      fs.writeFileSync(path.join(work, "mend.toml"), table);
      sh(work, ["add", "mend.toml"]);
      sh(work, ["commit", "-qm", "declare db"]);
      sh(world.project.storePath, ["fetch", work, "main:refs/heads/main"]);
      expect((await read()).kind).toBe("read");
      fs.mkdirSync(path.join(work, ".mend"));
      fs.writeFileSync(
        path.join(work, ".mend/mend.toml"),
        '[resource.cache]\npreset = "redis"\nimage = "redis:8"\n',
      );
      sh(work, ["add", ".mend"]);
      sh(work, ["commit", "-qm", "preferred"]);
      sh(world.project.storePath, ["fetch", work, "main:refs/heads/main"]);
      const preferred = await read();
      expect(preferred.kind === "read" && preferred.tables.map((def) => def.name)).toEqual([
        "cache",
      ]);
      sh(world.project.storePath, ["update-ref", "-d", "refs/heads/main"]);
      expect(await read()).toEqual({
        kind: "unavailable",
        message: "the default branch is not available on this server",
      });
    } finally {
      await runtime.dispose();
      fs.rmSync(world.scratch, { recursive: true, force: true });
    }
  });
  it("a captured project reports unavailable before a capture, and reads the default ref from restored objects", async () => {
    const world = makeCaptureWorld();
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        world.layer,
        WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)),
        SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
      ),
    );
    const read = () =>
      runtime.runPromise(
        Effect.flatMap(WorktreeReads, (reads) => readDefaultBranchTables(reads, world.project.id)),
      );
    try {
      expect((await read()).kind).toBe("unavailable");
      const id = newWorktreeId();
      const made = await runtime.runPromise(
        Effect.flatMap(SessionRepository, (repo) =>
          repo.createWorktree(
            world.project.id,
            { id, directory: id, branch: `mend/${id}` },
            { kind: "base", base: null },
            null,
          ),
        ),
      );
      world.worktrees.set(id, worktreeRowFor(world, id, made.branch));
      await runtime.runPromise(
        Effect.flatMap(
          SessionRepository,
          (repo) => repo.attachWorktree?.(world.project.id, id) ?? Effect.void,
        ),
      );
      // Capture 0 has the worktree's branch but does not invent a default-branch ref.
      expect((await read()).kind).toBe("unavailable");
      await runtime.runPromise(
        Effect.flatMap(StoreRefsRepo, (refs) =>
          refs.set(world.project.id, "refs/heads/main", Sha.make(world.baseSha), null),
        ),
      );
      expect((await read()).kind).toBe("absent");
      const present = await runtime.runPromise(
        Effect.flatMap(WorktreeReads, (reads) =>
          reads.readDefaultBranchFile(world.project.id, "a.txt", 1024),
        ),
      );
      expect(new TextDecoder().decode(present.value?.bytes)).toBe("one\ntwo\n");
    } finally {
      await runtime.dispose();
      fs.rmSync(world.scratch, { recursive: true, force: true });
    }
  });
});
