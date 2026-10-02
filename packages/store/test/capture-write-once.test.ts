import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  captureKeys,
  sha256Hex,
  storedObjectProblem,
  verifyPackPayloads,
  verifySectionRestorable,
} from "../src/captures.ts";
import { sectionOf, snapshotDirectory, uploadObjects, writeCdcPack } from "./capture-fixture.ts";

/**
 * Review 2026-09-28 (6) #9, cross-repo decision 19: stored objects are write-once, and what Mend
 * keeps about a key's bytes — a pack read and hashed chunk by chunk, a dir pack, a pack's index —
 * is a proof about one store's object, taken when nothing could replace it any more. Before, the
 * proofs were kept by key alone, process-wide, forever: a key verified once stayed verified in
 * another bucket, and after an upload URL still alive replaced its bytes.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-write-once-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label: string) => {
  dirs += 1;
  const at = path.join(scratch, `${label}-${dirs}`);
  fs.mkdirSync(at, { recursive: true });
  return at;
};

const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>, layer: Layer.Layer<BlobStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));
const outcome = <A, E>(effect: Effect.Effect<A, E, BlobStore>, layer: Layer.Layer<BlobStore>) =>
  run(
    effect.pipe(
      Effect.map(() => "read"),
      Effect.catch((error) =>
        Effect.succeed(
          typeof error === "object" && error !== null && "_tag" in error
            ? String(error._tag)
            : "failed",
        ),
      ),
    ),
    layer,
  );

/** A CDC pack of one chunk, keyed by the sha256 of its bytes, and the same length turned bad. */
const packPair = (worktree: string) => {
  const good = writeCdcPack([new Uint8Array(Buffer.from(`unique saved bytes of ${worktree}\n`))]);
  const key = captureKeys(worktree, 1).pack(sha256Hex(good.bytes));
  const bad = Buffer.from(good.bytes);
  bad[0] = (bad[0] ?? 0) ^ 0xff;
  return { key, good: good.bytes, bad: new Uint8Array(bad) };
};

/** An object as a bucket that replaced it would now hold it (the file is published read-only). */
const replaceInPlace = (root: string, key: string, bytes: Uint8Array) => {
  const at = path.join(root, key);
  fs.chmodSync(at, 0o644);
  fs.writeFileSync(at, bytes);
};

describe("capture proofs are bound to the store and stand only once nothing can replace the bytes", () => {
  it("#9 a pack verified in one store proves nothing about the same key in another", async () => {
    const { key, good, bad } = packPair("wt-identity");
    const first = BlobStoreFsLive(freshDir("first"));
    const second = BlobStoreFsLive(freshDir("second"));
    await run(uploadObjects(new Map([[key, good]])), first);
    await run(uploadObjects(new Map([[key, bad]])), second);
    expect(await outcome(verifyPackPayloads([key]), first)).toBe("read");
    expect(await outcome(verifyPackPayloads([key]), second)).toBe("CaptureIntegrityError");
  });

  it("#9 on a store an upload URL could still write, a read-back reads again and finds replaced bytes", async () => {
    const { key, good, bad } = packPair("wt-replaceable");
    const root = freshDir("replaceable");
    // A bucket that accepts `If-None-Match: *` and replaces the object anyway (Garage, measured):
    // a PUT URL minted for the key lives on for its TTL.
    const replaceable = Layer.effect(
      BlobStore,
      Effect.map(BlobStore, (inner): typeof BlobStore.Service => ({
        ...inner,
        identity: `garage-like:${root}`,
        replaceableUntil: () => Effect.succeed(Date.now() + 15 * 60 * 1000),
      })),
    ).pipe(Layer.provide(BlobStoreFsLive(root)));
    await run(uploadObjects(new Map([[key, good]])), replaceable);
    expect(await outcome(verifyPackPayloads([key]), replaceable)).toBe("read");
    expect(await run(storedObjectProblem(key), replaceable)).toBeNull();
    replaceInPlace(root, key, bad);
    // What the pack's chunks decode to was proven of the bytes that hash to the key, and is not
    // asked again (2026-10-02). Whether the stored object still is those bytes is the read-back's
    // question, and it never answers from a read taken while a URL could replace them.
    expect(await outcome(verifyPackPayloads([key]), replaceable)).toBe("read");
    expect(await run(storedObjectProblem(key), replaceable)).toMatch(/holds bytes that hash to/);
    expect(await run(storedObjectProblem(key, { reuseProofs: true }), replaceable)).toMatch(
      /holds bytes that hash to/,
    );
  });

  it("#9 a dir pack read from one store does not stand for the same key in another", async () => {
    const tree = freshDir("tree");
    fs.writeFileSync(path.join(tree, "a.txt"), "a\n");
    fs.mkdirSync(path.join(tree, "sub"));
    fs.writeFileSync(path.join(tree, "sub", "b.txt"), "b\n");
    const snapshot = snapshotDirectory(tree, captureKeys("wt-dir-packs", 1), { format: 2 });
    const first = BlobStoreFsLive(freshDir("dirs-first"));
    const second = BlobStoreFsLive(freshDir("dirs-second"));
    await run(uploadObjects(snapshot.objects), first);
    const dirPack = snapshot.dirPacks[0];
    if (dirPack === undefined) throw new Error("the snapshot wrote no dir pack");
    const corrupted = Buffer.from(snapshot.objects.get(dirPack) ?? new Uint8Array());
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await run(
      uploadObjects(
        new Map([
          ...[...snapshot.objects].filter(([at]) => at !== dirPack),
          [dirPack, new Uint8Array(corrupted)],
        ]),
      ),
      second,
    );
    expect(await outcome(verifySectionRestorable(sectionOf(snapshot)), first)).toBe("read");
    expect(await outcome(verifySectionRestorable(sectionOf(snapshot)), second)).not.toBe("read");
  });

  it("#9 an object already stored is accepted only as the bytes its key names", async () => {
    const { key, good, bad } = packPair("wt-present");
    const store = BlobStoreFsLive(freshDir("present"));
    const other = BlobStoreFsLive(freshDir("present-bad"));
    await run(uploadObjects(new Map([[key, good]])), store);
    await run(uploadObjects(new Map([[key, bad]])), other);
    expect(await run(storedObjectProblem(key), store)).toBeNull();
    expect(await run(storedObjectProblem(key), other)).toMatch(/holds bytes that hash to/);
  });
});
