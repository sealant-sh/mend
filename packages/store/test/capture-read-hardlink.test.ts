import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { type BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type DirEntry,
  captureKeys,
  encodeDirObject,
  FORMAT_DIR_PACKS,
  readCaptureFileBytes,
  sha256Hex,
  type WorkspaceSection,
} from "../src/captures.ts";
import {
  buildManifest,
  sectionOf,
  snapshotDirectory,
  uploadObjects,
  writeCdcPack,
} from "./capture-fixture.ts";

/**
 * Reading one file of a capture must never report success on bytes it did not find (review
 * 2026-09-27 #16): a hardlink member other than the canonical one carries no chunks, and the
 * transcript harvest reads files this way.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-read-hardlink-"));
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

/** A format-2 section over one hand-written dir object and one content pack of `chunks`. */
const handSection = (
  wt: string,
  entries: ReadonlyArray<DirEntry>,
  chunks: ReadonlyArray<Uint8Array>,
) => {
  const keys = captureKeys(wt, 1);
  const content = writeCdcPack(chunks);
  const contentKey = keys.pack(sha256Hex(content.bytes));
  const dirBytes = encodeDirObject(entries);
  const dirPack = writeCdcPack([dirBytes]);
  const dirPackKey = keys.pack(sha256Hex(dirPack.bytes));
  const workspace: WorkspaceSection = {
    root: sha256Hex(dirBytes),
    packs: [contentKey],
    format: FORMAT_DIR_PACKS,
    dir_packs: [dirPackKey],
  };
  return {
    objects: new Map([
      [contentKey, content.bytes],
      [dirPackKey, dirPack.bytes],
    ]),
    workspace,
  };
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

describe("readCaptureFile over a hardlink group", () => {
  it("streams a non-canonical member's bytes from its canonical member, in both formats", async () => {
    for (const format of [1, 2] as const) {
      const source = freshDir("hardlink-source");
      fs.mkdirSync(path.join(source, "sub"));
      fs.writeFileSync(path.join(source, "a"), "work product");
      fs.linkSync(path.join(source, "a"), path.join(source, "sub", "b"));
      const snapshot = snapshotDirectory(source, captureKeys("wt-hardlink", 1), { format });
      const built = buildManifest({
        worktreeId: "wt-hardlink",
        epoch: 1,
        n: 0,
        parent: null,
        workspace: sectionOf(snapshot),
      });
      const blobs = freshDir("hardlink-blobs");
      const read = await runWith(
        blobs,
        Effect.gen(function* () {
          yield* uploadObjects(snapshot.objects);
          return yield* readCaptureFileBytes(built.manifest, "workspace", "sub/b");
        }),
      );
      expect(Buffer.from(read).toString("utf8")).toBe("work product");
    }
  });

  it("fails — never an empty file — when a member's canonical path is missing, escapes, loops or disagrees on size", async () => {
    const body = utf8("canonical bytes");
    const cases: ReadonlyArray<{ readonly label: string; readonly member: DirEntry }> = [
      {
        label: "missing",
        member: {
          name: "m",
          kind: "hardlink-group",
          mode: 0o100644,
          size: 15,
          mtime: 1,
          target: "gone",
        },
      },
      {
        label: "escapes",
        member: {
          name: "m",
          kind: "hardlink-group",
          mode: 0o100644,
          size: 15,
          mtime: 1,
          target: "../a",
        },
      },
      {
        label: "loops",
        member: {
          name: "m",
          kind: "hardlink-group",
          mode: 0o100644,
          size: 15,
          mtime: 1,
          target: "n",
        },
      },
      {
        label: "size",
        member: {
          name: "m",
          kind: "hardlink-group",
          mode: 0o100644,
          size: 99,
          mtime: 1,
          target: "a",
        },
      },
    ];
    for (const { label, member } of cases) {
      const loop: DirEntry = {
        name: "n",
        kind: "hardlink-group",
        mode: 0o100644,
        size: 15,
        mtime: 1,
        target: "m",
      };
      const hand = handSection(`wt-${label}`, [fileEntry("a", body), member, loop], [body]);
      const built = buildManifest({
        worktreeId: `wt-${label}`,
        epoch: 1,
        n: 0,
        parent: null,
        workspace: hand.workspace,
      });
      const result = await runWith(
        freshDir(`blobs-${label}`),
        Effect.gen(function* () {
          yield* uploadObjects(hand.objects);
          return yield* outcome(readCaptureFileBytes(built.manifest, "workspace", "m"));
        }),
      );
      expect(result, label).toMatch(/^CaptureFormatError/);
    }
  });

  it("fails a plain file whose chunks do not add up to the size its entry advertises", async () => {
    const body = utf8("twelve bytes");
    const short: DirEntry = { ...fileEntry("a", body), size: 40 };
    const hand = handSection("wt-short", [short], [body]);
    const built = buildManifest({
      worktreeId: "wt-short",
      epoch: 1,
      n: 0,
      parent: null,
      workspace: hand.workspace,
    });
    const result = await runWith(
      freshDir("blobs-short"),
      Effect.gen(function* () {
        yield* uploadObjects(hand.objects);
        return yield* outcome(readCaptureFileBytes(built.manifest, "workspace", "a"));
      }),
    );
    expect(result).toMatch(/^CaptureFormatError: .*read 12 bytes, entry says 40/);
  });
});
