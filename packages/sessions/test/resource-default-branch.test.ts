import * as fs from "node:fs";
import * as path from "node:path";

import { ProjectId } from "@mend/domain";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { readDefaultBranchTables } from "../src/resources/worktree-tables.ts";
import {
  WorktreeReads,
  WorktreeReadsColocatedLive,
  WorktreeReadsCapturedLive,
  DefaultBranchUnavailableError,
  WORKTREE_STAMP,
} from "../src/worktree-reads.ts";
import { makeCaptureWorld, sh } from "./capture-world.ts";

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
const declareOnOrigin = (
  world: ReturnType<typeof makeCaptureWorld>,
  file: string,
  text: string,
) => {
  const work = path.join(world.scratch, "work");
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
  sh(work, ["add", file]);
  sh(work, ["commit", "-qm", `declare ${file}`]);
  // What adoption and refresh write: origin's default branch as last fetched.
  sh(world.project.storePath, ["fetch", work, "main:refs/remotes/origin/main"]);
};

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
  for (const mode of ["co-located", "captured"] as const) {
    it(`reads the default branch from the project's store with no worktree (${mode})`, async () => {
      const world = makeCaptureWorld();
      const reads =
        mode === "co-located"
          ? WorktreeReadsColocatedLive.pipe(Layer.provide(world.layer))
          : Layer.mergeAll(world.layer, WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer)));
      const runtime = ManagedRuntime.make(reads);
      const read = () =>
        runtime.runPromise(
          Effect.flatMap(WorktreeReads, (each) => readDefaultBranchTables(each, world.project.id)),
        );
      try {
        expect((await read()).kind).toBe("absent");
        declareOnOrigin(world, "mend.toml", table);
        expect((await read()).kind).toBe("read");
        declareOnOrigin(
          world,
          ".mend/mend.toml",
          '[resource.cache]\npreset = "redis"\nimage = "redis:8"\n',
        );
        const preferred = await read();
        expect(preferred.kind === "read" && preferred.tables.map((def) => def.name)).toEqual([
          "cache",
        ]);
        sh(world.project.storePath, ["update-ref", "-d", "refs/remotes/origin/main"]);
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
  }
});
