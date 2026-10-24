import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store, StoreConfig } from "../src/index.ts";

let root: string;
let store: Store["Service"];
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-raw-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "private"));
  fs.writeFileSync(path.join(root, "docs/data.bin"), bytes);
  fs.writeFileSync(path.join(root, "private/secret.bin"), "secret");
  fs.symlinkSync("../private/secret.bin", path.join(root, "docs/link.bin"));
  fs.symlinkSync("data.bin", path.join(root, "docs/alias.png"));
  fs.symlinkSync("/etc/passwd", path.join(root, "escape.bin"));
  store = await run(
    Effect.provide(Store, Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
  );
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (name: string, within = "") =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* store.openRawWorktreeFile(root, name, within);
      const chunks = yield* Stream.runCollect(file.read(0, file.size));
      return { file, bytes: Buffer.concat(chunks) };
    }),
  );

describe("raw worktree files", () => {
  it("returns exact binary bytes and canonical descriptor metadata", async () => {
    const result = await run(read("docs/alias.png"));
    expect(result.bytes).toEqual(Buffer.from(bytes));
    expect(result.file.canonicalPath).toBe("docs/data.bin");
    expect(result.file.size).toBe(256);
  });
  it("keeps a file's identity through an in-place edit and gives a replacement a new one", async () => {
    const name = path.join(root, "docs/edited.bin");
    fs.writeFileSync(name, bytes);
    const opened = () => run(read("docs/edited.bin")).then((result) => result.file);
    const first = await opened();
    expect(first.identity).toMatch(/^[a-f0-9]{64}$/);
    fs.appendFileSync(name, "more");
    const edited = await opened();
    expect(edited.identity).toBe(first.identity);
    expect(edited.revision).not.toBe(first.revision);
    fs.writeFileSync(`${name}.next`, bytes);
    fs.renameSync(`${name}.next`, name);
    expect((await opened()).identity).not.toBe(first.identity);
  });
  it("refuses traversal, outside links, non-files and canonical directory escapes", async () => {
    for (const name of [
      "../etc/passwd",
      "escape.bin",
      ".git/config",
      "docs",
      "docs/../private/secret.bin",
      "docs\\data.bin",
    ]) {
      expect(await run(Effect.result(read(name)))).toMatchObject({ _tag: "Failure" });
    }
    expect(await run(Effect.result(read("docs/link.bin", "docs")))).toMatchObject({
      _tag: "Failure",
    });
    expect((await run(read("docs/data.bin", "docs"))).bytes).toEqual(Buffer.from(bytes));
  });
  it("seeks a large sparse file and streams in bounded chunks from its opened descriptor", async () => {
    const name = path.join(root, "large.bin");
    const fd = fs.openSync(name, "w");
    const size = 512 * 1024 * 1024 + 256;
    fs.ftruncateSync(fd, size);
    fs.writeSync(fd, bytes, 0, bytes.length, size - bytes.length);
    fs.closeSync(fd);
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* store.openRawWorktreeFile(root, "large.bin", "");
          fs.renameSync(name, `${name}.old`);
          fs.writeFileSync(name, "replacement");
          expect(Buffer.concat(yield* Stream.runCollect(file.read(size - 256, 256)))).toEqual(
            Buffer.from(bytes),
          );
          let total = 0;
          yield* Stream.runForEach(file.read(0, file.size), (chunk) =>
            Effect.sync(() => {
              expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
              total += chunk.length;
            }),
          );
          expect(total).toBe(size);
        }),
      ),
    );
  });
  it("fails an incomplete stream instead of reporting truncated success and closes on scope exit", async () => {
    const baseline = fs.readdirSync("/proc/self/fd").length;
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* store.openRawWorktreeFile(root, "docs/data.bin", "");
          fs.truncateSync(path.join(root, "docs/data.bin"), 1);
          expect(yield* Effect.result(Stream.runDrain(file.read(0, file.size)))).toMatchObject({
            _tag: "Failure",
          });
        }),
      ),
    );
    expect(fs.readdirSync("/proc/self/fd").length).toBe(baseline);
  });
});
