import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { FolderStore, FolderStoreLive, isSafeFolderPath } from "../src/folder-store.ts";
import { StoreConfig } from "../src/store.ts";

const roots: Array<string> = [];

const withStore = <A, E>(effect: (root: string) => Effect.Effect<A, E, FolderStore>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-folder-store-"));
  roots.push(root);
  return Effect.runPromise(
    effect(root).pipe(
      Effect.provide(FolderStoreLive.pipe(Layer.provide(Layer.succeed(StoreConfig, { root })))),
    ),
  );
};

const upload = (filePath: string, contents: string | Buffer) => ({
  path: filePath,
  contentsBase64: Buffer.from(contents).toString("base64"),
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("folder paths", () => {
  it("accepts folder-relative paths and refuses escapes", () => {
    expect(isSafeFolderPath("notes/readme.md")).toBe(true);
    for (const unsafe of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b"]) {
      expect(isSafeFolderPath(unsafe)).toBe(false);
    }
  });
});

describe("FolderStore", () => {
  it("writes, lists, merges and replaces", async () => {
    const result = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* FolderStore;
        yield* store.write("f", [upload("a.md", "a"), upload("docs/b.md", "bb")], { merge: true });
        const first = yield* store.list("f", 100);
        yield* store.write("f", [upload("c.md", "ccc")], { merge: true });
        const merged = yield* store.list("f", 100);
        yield* store.write("f", [upload("d.md", "d")], { merge: false });
        const replaced = yield* store.list("f", 100);
        yield* store.deleteFile("f", "d.md");
        const deleted = yield* store.list("f", 100);
        const limited = yield* Effect.gen(function* () {
          yield* store.write("g", [upload("1", "x"), upload("2", "x"), upload("3", "x")], {
            merge: true,
          });
          return yield* store.list("g", 2);
        });
        return { first, merged, replaced, deleted, limited };
      }),
    );
    expect(result.first.files.map((file) => [file.path, file.bytes])).toEqual([
      ["a.md", 1],
      ["docs/b.md", 2],
    ]);
    expect(result.merged.files.map((file) => file.path)).toEqual(["a.md", "c.md", "docs/b.md"]);
    expect(result.replaced.files.map((file) => file.path)).toEqual(["d.md"]);
    expect(result.deleted.files).toEqual([]);
    expect(result.limited).toMatchObject({ truncated: true });
    expect(result.limited.files).toHaveLength(2);
  });

  it("refuses an escaping path before writing anything", async () => {
    const outcome = await withStore((root) =>
      Effect.gen(function* () {
        const store = yield* FolderStore;
        const refused = yield* store
          .write("f", [upload("ok.md", "fine"), upload("../escape.md", "no")], { merge: true })
          .pipe(Effect.flip);
        return {
          message: refused.message,
          wroteOk: fs.existsSync(path.join(root, "f", "ok.md")),
          escaped: fs.existsSync(path.join(root, "escape.md")),
        };
      }),
    );
    expect(outcome).toEqual({
      message: "not a folder-relative path: ../escape.md",
      wroteOk: false,
      escaped: false,
    });
  });

  it("never writes or deletes through a symlink out of the folder", async () => {
    const outcome = await withStore((root) =>
      Effect.gen(function* () {
        const store = yield* FolderStore;
        const outside = path.join(root, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "secret"), "keep");
        yield* store.create("f");
        fs.symlinkSync(outside, path.join(root, "f", "link"));
        fs.symlinkSync(path.join(outside, "secret"), path.join(root, "f", "secret-link"));
        const throughDirectory = yield* store
          .write("f", [upload("link/secret", "overwritten")], { merge: true })
          .pipe(Effect.flip);
        const throughFile = yield* store
          .write("f", [upload("secret-link", "overwritten")], { merge: true })
          .pipe(Effect.flip);
        const deleteThrough = yield* store.deleteFile("f", "link/secret").pipe(Effect.flip);
        const listing = yield* store.list("f", 100);
        return {
          throughDirectory: throughDirectory._tag,
          throughFile: throughFile._tag,
          deleteThrough: deleteThrough._tag,
          secret: fs.readFileSync(path.join(outside, "secret"), "utf8"),
          listed: listing.files.map((file) => file.path),
        };
      }),
    );
    expect(outcome).toEqual({
      throughDirectory: "FolderStoreError",
      throughFile: "FolderStoreError",
      deleteThrough: "FolderStoreError",
      secret: "keep",
      listed: [],
    });
  });

  it("caps a file at 1 MiB and a request at 4 MiB", async () => {
    const outcome = await withStore(() =>
      Effect.gen(function* () {
        const store = yield* FolderStore;
        const big = Buffer.alloc(1024 * 1024 + 1);
        const chunk = Buffer.alloc(1024 * 1024);
        const oneFile = yield* store
          .write("f", [upload("big", big)], { merge: true })
          .pipe(Effect.flip);
        const request = yield* store
          .write(
            "f",
            [0, 1, 2, 3, 4].map((index) => upload(`part-${index}`, chunk)),
            {
              merge: true,
            },
          )
          .pipe(Effect.flip);
        return [oneFile.message, request.message];
      }),
    );
    expect(outcome).toEqual([
      "big is over 1 MiB",
      "an upload is capped at 4 MiB; send the files in smaller batches",
    ]);
  });
});
