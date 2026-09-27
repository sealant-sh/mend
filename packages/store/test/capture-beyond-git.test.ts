import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { type BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  captureKeys,
  type DirEntry,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  pathsBeyondGit,
  pathsBeyondGitWords,
  sha256Hex,
  type WorkspaceSection,
} from "../src/captures.ts";
import { buildManifest, uploadObjects, writeCdcPack } from "./capture-fixture.ts";

/**
 * A path too long for git (sealantd `GitRepo::beyond_reach`: a file of PATH_MAX bytes or more
 * below the worktree root, or anything under a directory git cannot open) is carried by the
 * workspace class under `tree/`, saved and restored — and absent from every diff git computes
 * (e2e run 4, 2026-09-27). The change view counts them from the capture, so it can say so.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-beyond-git-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const runWith = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(BlobStoreFsLive(fs.mkdtempSync(path.join(scratch, "blobs-"))))),
  );

const file = (name: string): DirEntry => ({
  name,
  kind: "file",
  mode: 0o100644,
  size: 0,
  mtime: 1,
  chunks: [],
});

/** A format-2 workspace class from dir objects built bottom-up: `dir(name, entries)`. */
const classOf = (wt: string) => {
  const dirObjects: Array<Uint8Array> = [];
  const dir = (name: string, entries: ReadonlyArray<DirEntry>): DirEntry => {
    const bytes = encodeDirObject([...entries].toSorted((a, b) => a.name.localeCompare(b.name)));
    dirObjects.push(bytes);
    return { name, kind: "dir", mode: 0o40755, size: 0, mtime: 1, child: sha256Hex(bytes) };
  };
  const finish = (rootEntries: ReadonlyArray<DirEntry>) => {
    const root = dir("", rootEntries);
    const pack = writeCdcPack(dirObjects);
    const keys = captureKeys(wt, 1);
    const packKey = keys.pack(sha256Hex(pack.bytes));
    const workspace: WorkspaceSection = {
      root: root.child ?? "",
      packs: [],
      format: FORMAT_DIR_PACKS,
      dir_packs: [packKey],
    };
    return { objects: new Map([[packKey, pack.bytes]]), workspace };
  };
  return { dir, finish };
};

describe("pathsBeyondGit", () => {
  it("counts the worktree files of PATH_MAX bytes or more the workspace class carries, and nothing git reaches", async () => {
    const { dir, finish } = classOf("wt-long");
    // 17 directories of 243-byte names: the third Docker end to end's shape (4,186 bytes deep).
    const names = Array.from({ length: 17 }, (_, at) =>
      `${String(at).padStart(2, "0")}`.padEnd(243, "d"),
    );
    let deepest: DirEntry = dir(names[16] ?? "", [file("leaf.txt"), file("other.txt")]);
    for (let at = 15; at >= 0; at -= 1) deepest = dir(names[at] ?? "", [deepest]);
    const tree = dir("tree", [
      deepest,
      // An ignored build output git does not track: short, and not beyond git's reach.
      dir("dist", [file("app.js")]),
      // A file just under PATH_MAX: git stats it.
      file("s".repeat(4095)),
    ]);
    const { objects, workspace } = finish([
      tree,
      dir(".git", [file("index")]),
      dir("harness", [file("x".repeat(4200))]),
    ]);
    const built = buildManifest({ worktreeId: "wt-long", epoch: 1, n: 3, parent: null, workspace });
    const found = await runWith(
      Effect.gen(function* () {
        yield* uploadObjects(objects);
        return yield* pathsBeyondGit(built.manifest);
      }),
    );
    expect(found.count).toBe(2);
    expect(found.paths).toHaveLength(2);
    expect(found.paths[0]?.startsWith(`${names[0]}/${names[1]}/`)).toBe(true);
    expect(found.paths[0]?.endsWith("/leaf.txt")).toBe(true);
    expect(Buffer.byteLength(found.paths[0] ?? "", "utf8")).toBeGreaterThanOrEqual(4096);
  });

  it("finds none in a class without a tree, or with only short paths", async () => {
    const { dir, finish } = classOf("wt-short");
    const { objects, workspace } = finish([dir("tree", [file("a.txt")]), dir("harness", [])]);
    const built = buildManifest({
      worktreeId: "wt-short",
      epoch: 1,
      n: 0,
      parent: null,
      workspace,
    });
    const found = await runWith(
      Effect.gen(function* () {
        yield* uploadObjects(objects);
        return yield* pathsBeyondGit(built.manifest);
      }),
    );
    expect(found).toEqual({ count: 0, paths: [] });
  });

  it("says how many, and that they are saved but not in the diff", () => {
    expect(pathsBeyondGitWords({ count: 0, paths: [] })).toBeNull();
    expect(pathsBeyondGitWords({ count: 1, paths: ["a"] })).toBe(
      "1 path outside git (too long) · saved, not shown in the diff",
    );
    expect(pathsBeyondGitWords({ count: 3, paths: [] })).toBe(
      "3 paths outside git (too long) · saved, not shown in the diff",
    );
  });
});
