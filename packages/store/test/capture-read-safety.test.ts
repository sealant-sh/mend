import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type CaptureManifest,
  type DirEntry,
  captureKeys,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  materialize,
  readPackIndex,
  readPackIndexRemote,
  sha256Hex,
  verifySectionRestorable,
} from "../src/captures.ts";
import {
  buildManifest,
  sectionOf,
  snapshotDirectory,
  uploadObjects,
  writeCdcPack,
} from "./capture-fixture.ts";

/**
 * The restorability check register runs before it acknowledges a capture (review 2026-09-27
 * #19), and the ranged pack-index read it stands on.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-read-safety-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  dirs += 1;
  const at = path.join(scratch, `${label}-${dirs}`);
  fs.mkdirSync(at, { recursive: true });
  return at;
};
const runWith = <A, E>(blobRoot: string, effect: Effect.Effect<A, E, BlobStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BlobStoreFsLive(blobRoot))));
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) =>
      Effect.succeed(
        `${error._tag}${"reason" in error && typeof error.reason === "string" ? `: ${error.reason}` : ""}`,
      ),
    ),
  );

/** A format-2 section over hand-written dir objects and one content pack of `chunks`. */
const handSection = (
  wt: string,
  tree: ReadonlyArray<{ readonly entries: ReadonlyArray<DirEntry> }>,
  chunks: ReadonlyArray<Uint8Array>,
) => {
  const keys = captureKeys(wt, 1);
  const objects = new Map<string, Uint8Array>();
  const content = writeCdcPack(chunks);
  const contentKey = keys.pack(sha256Hex(content.bytes));
  objects.set(contentKey, content.bytes);
  const dirBytes = tree.map((dir) => encodeDirObject(dir.entries));
  const dirPack = writeCdcPack(dirBytes);
  const dirPackKey = keys.pack(sha256Hex(dirPack.bytes));
  objects.set(dirPackKey, dirPack.bytes);
  const digests = dirBytes.map(sha256Hex);
  return { objects, contentKey, dirPackKey, digests };
};

const fileEntry = (name: string, bytes: Uint8Array): DirEntry => ({
  name,
  kind: "file",
  mode: 0o100644,
  size: bytes.byteLength,
  mtime: 1,
  chunks: [sha256Hex(bytes)],
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

describe("readPackIndexRemote", () => {
  it("reads the same index from the pack's tail as from the whole pack, whatever the index size", async () => {
    const blobs = freshDir("remote-index");
    for (const count of [1, 40, 5_000]) {
      const chunks = Array.from({ length: count }, (_, at) => utf8(`chunk ${at}`));
      const pack = writeCdcPack(chunks);
      const key = captureKeys("wt-index", 1).pack(sha256Hex(pack.bytes));
      const [local, remote] = await runWith(
        blobs,
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.put(key, pack.bytes);
          return [
            yield* readPackIndex(key, pack.bytes),
            yield* readPackIndexRemote(key, pack.bytes.byteLength),
          ] as const;
        }),
      );
      expect(remote).toEqual(local);
    }
  });
});

describe("verifySectionRestorable", () => {
  const snapshotOf = (format: 1 | 2) => {
    const source = freshDir(`verify-source-${format}`);
    fs.mkdirSync(path.join(source, "dir", "deep"), { recursive: true });
    fs.writeFileSync(path.join(source, "dir", "deep", "file.txt"), "x".repeat(300_000));
    fs.writeFileSync(path.join(source, "empty"), "");
    fs.symlinkSync("dir/deep/file.txt", path.join(source, "link"));
    fs.linkSync(path.join(source, "dir", "deep", "file.txt"), path.join(source, "z-hard"));
    return snapshotDirectory(source, captureKeys(`wt-verify-${format}`, 1), {
      format,
      chunkSize: 64 * 1024,
    });
  };

  it("passes a section every materializer restores, in both formats", async () => {
    for (const format of [1, 2] as const) {
      const snapshot = snapshotOf(format);
      const check = await runWith(
        freshDir("verify-ok"),
        Effect.gen(function* () {
          yield* uploadObjects(snapshot.objects);
          return yield* verifySectionRestorable(sectionOf(snapshot));
        }),
      );
      expect(check).toMatchObject({ dirs: 3, hardlinks: 1 });
    }
  });

  it("refuses a root no dir pack holds, a chunk no listed pack holds, a missing pack and a missing dir object", async () => {
    const two = snapshotOf(2);
    const one = snapshotOf(1);
    const sectionTwo = sectionOf(two);
    const sectionOne = sectionOf(one);
    const blobs = freshDir("verify-bad");
    const results = await runWith(
      blobs,
      Effect.gen(function* () {
        yield* uploadObjects(two.objects);
        yield* uploadObjects(one.objects);
        const store = yield* BlobStore;
        const wrongRoot = yield* outcome(
          verifySectionRestorable({ ...sectionTwo, root: "f".repeat(64) }),
        );
        const noPacks = yield* outcome(verifySectionRestorable({ ...sectionTwo, packs: [] }));
        const missingPack = yield* outcome(
          verifySectionRestorable({
            ...sectionTwo,
            packs: [...sectionTwo.packs, captureKeys("wt-verify-2", 1).pack("0".repeat(64))],
          }),
        );
        // Format 1: remove one dir object below the root.
        const treeKeys = [...one.objects.keys()].filter((key) => key.includes("/trees/"));
        const below = treeKeys.find((key) => key !== one.root);
        if (below !== undefined) yield* store.remove(below);
        const missingDir = yield* outcome(verifySectionRestorable(sectionOne));
        return { wrongRoot, noPacks, missingPack, missingDir };
      }),
    );
    expect(results.wrongRoot).toMatch(/^CaptureFormatError: .*in no dir pack/);
    expect(results.noPacks).toMatch(/^CaptureFormatError: .*is in no pack the section lists/);
    expect(results.missingPack).toBe("BlobNotFoundError");
    expect(results.missingDir).toBe("BlobNotFoundError");
  });

  it("refuses a hardlink member whose canonical member is not a file of its size", async () => {
    const body = utf8("canonical bytes");
    for (const member of [
      { name: "m", kind: "hardlink-group", mode: 0o100644, size: 15, mtime: 1, target: "gone" },
      { name: "m", kind: "hardlink-group", mode: 0o100644, size: 3, mtime: 1, target: "a" },
      { name: "m", kind: "hardlink-group", mode: 0o100644, size: 15, mtime: 1, target: "/a" },
    ] satisfies ReadonlyArray<DirEntry>) {
      const hand = handSection("wt-hl", [{ entries: [fileEntry("a", body), member] }], [body]);
      const result = await runWith(
        freshDir("verify-hl"),
        Effect.gen(function* () {
          yield* uploadObjects(hand.objects);
          return yield* outcome(
            verifySectionRestorable({
              root: hand.digests[0] ?? "",
              packs: [hand.contentKey],
              format: FORMAT_DIR_PACKS,
              dir_packs: [hand.dirPackKey],
            }),
          );
        }),
      );
      expect(result, JSON.stringify(member)).toMatch(/^CaptureFormatError/);
    }
  });

  it("agrees with materialize: what it passes restores", async () => {
    const snapshot = snapshotOf(2);
    const built = buildManifest({
      worktreeId: "wt-verify-2",
      epoch: 1,
      n: 0,
      parent: null,
      workspace: sectionOf(snapshot),
    });
    const target = path.join(freshDir("verify-restore"), "out");
    const stats = await runWith(
      freshDir("verify-restore-blobs"),
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        yield* verifySectionRestorable(built.manifest.sections.workspace);
        return yield* materialize(built.manifest satisfies CaptureManifest, "workspace", target);
      }),
    );
    expect(stats.hardlinks).toBe(1);
    expect(fs.readFileSync(path.join(target, "z-hard"), "utf8")).toHaveLength(300_000);
  });
});
