import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { DotfilesStore, DotfilesStoreLive } from "../src/dotfiles-store.ts";
import { StoreConfig } from "../src/store.ts";

const layerFor = (root: string) =>
  DotfilesStoreLive.pipe(Layer.provide(StoreConfig.layerFor(root)));

const run = <A, E>(root: string, effect: Effect.Effect<A, E, DotfilesStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layerFor(root))));

const b64 = (value: string) => Buffer.from(value).toString("base64");

describe("DotfilesStore", () => {
  it("has no snapshot until the first sync", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const current = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        return yield* store.current("user_a");
      }),
    );
    expect(current).toBeNull();
  });

  it("commits a snapshot per user and keeps users apart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const summaries = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        const a = yield* store.snapshot(
          "user_a",
          [{ path: ".zshrc", contentsBase64: b64("export A=1\n") }],
          { source: "thinkpad", merge: false },
        );
        const b = yield* store.snapshot(
          "user_b",
          [{ path: ".bashrc", contentsBase64: b64("export B=1\n") }],
          { source: "macbook", merge: false },
        );
        return { a, b, currentA: yield* store.current("user_a") };
      }),
    );
    expect(summaries.a.files).toEqual([{ path: ".zshrc", bytes: 11 }]);
    expect(summaries.a.source).toBe("thinkpad");
    expect(summaries.b.files).toEqual([{ path: ".bashrc", bytes: 11 }]);
    expect(summaries.currentA?.sha).toBe(summaries.a.sha);
  });

  it("merge overlays the current snapshot; replace supersedes it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const result = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        yield* store.snapshot(
          "user_a",
          [
            { path: ".zshrc", contentsBase64: b64("one\n") },
            { path: ".vimrc", contentsBase64: b64("vim\n") },
          ],
          { source: "thinkpad", merge: false },
        );
        const merged = yield* store.snapshot(
          "user_a",
          [{ path: ".zshrc", contentsBase64: b64("two\n") }],
          { source: "web", merge: true },
        );
        const replaced = yield* store.snapshot(
          "user_a",
          [{ path: ".gitconfig", contentsBase64: b64("[user]\n") }],
          { source: "thinkpad", merge: false },
        );
        return { merged, replaced };
      }),
    );
    expect(result.merged.files.map((f) => f.path).toSorted()).toEqual([".vimrc", ".zshrc"]);
    expect(result.replaced.files.map((f) => f.path)).toEqual([".gitconfig"]);
  });

  it("returns the current summary unchanged for an identical sync", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const files = [{ path: ".zshrc", contentsBase64: b64("same\n") }];
    const shas = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        const first = yield* store.snapshot("user_a", files, {
          source: "thinkpad",
          merge: false,
        });
        const second = yield* store.snapshot("user_a", files, {
          source: "thinkpad",
          merge: false,
        });
        return { first: first.sha, second: second.sha };
      }),
    );
    expect(shas.second).toBe(shas.first);
  });

  it("packs the snapshot as a tar.gz whose contents extract intact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const archive = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        yield* store.snapshot(
          "user_a",
          [{ path: ".config/starship.toml", contentsBase64: b64("format = 'x'\n") }],
          { source: "thinkpad", merge: false },
        );
        return yield* store.archive("user_a");
      }),
    );
    expect(archive).not.toBeNull();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-out-"));
    const tarball = path.join(out, "a.tar.gz");
    fs.writeFileSync(tarball, Buffer.from(archive?.data ?? "", "base64"));
    execFileSync("tar", ["-xzf", tarball, "-C", out]);
    expect(fs.readFileSync(path.join(out, ".config/starship.toml"), "utf8")).toBe("format = 'x'\n");
  });

  it("rejects escapes, oversized files, and hostile user ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const escape = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        return yield* store
          .snapshot("user_a", [{ path: "../etc/passwd", contentsBase64: b64("x") }], {
            source: "t",
            merge: false,
          })
          .pipe(Effect.result);
      }),
    );
    expect(Result.isFailure(escape)).toBe(true);
    const bigFile = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        return yield* store
          .snapshot(
            "user_a",
            [{ path: ".big", contentsBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }],
            { source: "t", merge: false },
          )
          .pipe(Effect.result);
      }),
    );
    expect(Result.isFailure(bigFile)).toBe(true);
    const hostileUser = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        return yield* store.current("../user_a").pipe(Effect.result);
      }),
    );
    expect(Result.isFailure(hostileUser)).toBe(true);
  });

  it("caps a merge at 4MB counting the files it keeps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotstore-"));
    const mb = Buffer.alloc(1024 * 1024).toString("base64");
    const result = await run(
      root,
      Effect.gen(function* () {
        const store = yield* DotfilesStore;
        yield* store.snapshot(
          "user_a",
          [0, 1, 2].map((index) => ({ path: `.part${index}`, contentsBase64: mb })),
          { source: "t", merge: false },
        );
        // Replacing a kept file does not count it twice: 3MB → 4MB is still inside the cap.
        const within = yield* store.snapshot(
          "user_a",
          [
            { path: ".part0", contentsBase64: mb },
            { path: ".part3", contentsBase64: mb },
          ],
          { source: "t", merge: true },
        );
        // One byte more than the 4MB the snapshot now holds.
        const over = yield* store
          .snapshot("user_a", [{ path: ".one", contentsBase64: b64("x") }], {
            source: "t",
            merge: true,
          })
          .pipe(Effect.result);
        const afterRefusal = yield* store.current("user_a");
        // A replace is measured on its own files only.
        const replaced = yield* store.snapshot(
          "user_a",
          [{ path: ".one", contentsBase64: b64("x") }],
          { source: "t", merge: false },
        );
        return { within, over, afterRefusal, replaced };
      }),
    );
    expect(result.within.files.map((file) => file.path)).toEqual([
      ".part0",
      ".part1",
      ".part2",
      ".part3",
    ]);
    expect(Result.isFailure(result.over)).toBe(true);
    if (Result.isFailure(result.over)) {
      expect(result.over.failure.message).toBe(
        "snapshot exceeds the 4MB cap with the files it already holds — trim the selection",
      );
    }
    // The refused merge left the snapshot as it was.
    expect(result.afterRefusal?.sha).toBe(result.within.sha);
    expect(result.replaced.files.map((file) => file.path)).toEqual([".one"]);
  });
});
