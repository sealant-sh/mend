import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { Cause, Effect, Exit, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";

/** A real pending producer that exposes its destination's filesystem lifecycle. */
class PendingUpload extends Readable {
  readonly piped = Promise.withResolvers<void>();
  output: fs.WriteStream | null = null;

  override _read(): void {}

  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    if (destination instanceof fs.WriteStream) {
      this.output = destination;
      this.piped.resolve();
    }
    return super.pipe(destination, options);
  }
}

/** Keeps destruction pending until the test permits the producer to close. */
class DelayedCloseUpload extends PendingUpload {
  readonly destroying = Promise.withResolvers<void>();
  private released = false;
  private finishDestroy: (() => void) | null = null;

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.finishDestroy = () => callback(error);
    this.destroying.resolve();
    if (this.released) this.release();
  }

  release(): void {
    this.released = true;
    this.finishDestroy?.();
    this.finishDestroy = null;
  }
}

describe("filesystem upload cleanup", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-blob-upload-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BlobStoreFsLive(root))));

  for (const existing of [false, true]) {
    it(`cleans a failed streamed upload ${existing ? "without replacing the existing object" : "without publishing an object"}`, async () => {
      const key = "objects/failed";
      if (existing) {
        await run(Effect.flatMap(BlobStore, (store) => store.put(key, Buffer.from("original"))));
      }
      const error = new Error("disconnected upload");
      const source = Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw error;
        })(),
      );
      try {
        const exit = await run(
          Effect.flatMap(BlobStore, (store) =>
            store.put(key, { stream: source, length: 100 }, { ifAbsent: existing }),
          ).pipe(Effect.exit),
        );
        if (!Exit.isFailure(exit)) throw new Error("the failed source must fail the upload");
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "BlobStoreError",
          operation: "put",
          key,
          cause: error,
        });
        expect(source.closed).toBe(true);
        expect(fs.readdirSync(path.join(root, ".tmp"))).toEqual([]);
        expect(await run(Effect.flatMap(BlobStore, (store) => store.head(key)))).toEqual(
          existing ? { size: 8, etag: null } : null,
        );
        if (existing) {
          expect(await run(Effect.flatMap(BlobStore, (store) => store.get(key)))).toEqual(
            new Uint8Array(Buffer.from("original")),
          );
        }
      } finally {
        source.destroy();
        await finished(source).catch(() => undefined);
      }
    });
  }

  it("waits for a pending producer's destruction before removing its temporary file", async () => {
    const key = "objects/delayed-close";
    const source = new DelayedCloseUpload();
    const fiber = Effect.runFork(
      Effect.flatMap(BlobStore, (store) => store.put(key, { stream: source, length: 100 })).pipe(
        Effect.provide(BlobStoreFsLive(root)),
      ),
    );
    try {
      await source.piped.promise;
      const output = source.output;
      if (output === null) throw new Error("the upload must pipe to a real file stream");
      source.push(Buffer.from("partial"));
      await new Promise<void>((resolve, reject) => {
        output.write(Buffer.alloc(0), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      let stopped = false;
      const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
        stopped = true;
        return undefined;
      });
      await Promise.race([source.destroying.promise, stopping]);
      expect(source.destroyed).toBe(true);
      expect(source.closed).toBe(false);
      expect(stopped).toBe(false);
      expect(fs.readdirSync(path.join(root, ".tmp"))).toHaveLength(1);
      source.release();
      await stopping;
      expect(source.closed).toBe(true);
      expect(output.closed).toBe(true);
      expect(fs.readdirSync(path.join(root, ".tmp"))).toEqual([]);
      expect(await run(Effect.flatMap(BlobStore, (store) => store.head(key)))).toBeNull();
    } finally {
      source.release();
      source.destroy();
      source.output?.destroy();
      await Promise.all([
        finished(source).catch(() => undefined),
        source.output === null ? undefined : finished(source.output).catch(() => undefined),
      ]);
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  for (const interrupted of [false, true]) {
    it(`retains ${interrupted ? "interruption" : "the source error"} when temporary-file removal also fails`, async () => {
      const key = "objects/cleanup-failure";
      const error = new Error("disconnected upload");
      const source = new PendingUpload();
      source.once("close", () => {
        // An external filesystem change makes removing the temporary path fail with ENOTDIR.
        fs.rmSync(path.join(root, ".tmp"), { recursive: true, force: true });
        fs.writeFileSync(path.join(root, ".tmp"), "not a directory");
      });
      const fiber = Effect.runFork(
        Effect.flatMap(BlobStore, (store) => store.put(key, { stream: source, length: 100 })).pipe(
          Effect.provide(BlobStoreFsLive(root)),
        ),
      );
      try {
        await source.piped.promise;
        if (interrupted) await Effect.runPromise(Fiber.interrupt(fiber));
        else source.destroy(error);
        const exit = await Effect.runPromise(Fiber.await(fiber));
        if (!Exit.isFailure(exit)) throw new Error("an upload with failed cleanup cannot succeed");
        const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
        expect(errors).toHaveLength(interrupted ? 1 : 2);
        expect(errors.at(-1)).toMatchObject({
          _tag: "BlobStoreError",
          operation: "put",
          key,
          cause: { code: "ENOTDIR" },
        });
        if (interrupted) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        else expect(errors[0]).toMatchObject({ _tag: "BlobStoreError", cause: error });
        expect(source.closed).toBe(true);
        expect(source.output?.closed).toBe(true);
        expect(await run(Effect.flatMap(BlobStore, (store) => store.head(key)))).toBeNull();
      } finally {
        source.destroy();
        source.output?.destroy();
        await Promise.all([
          finished(source).catch(() => undefined),
          source.output === null ? undefined : finished(source.output).catch(() => undefined),
        ]);
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    });
  }

  for (const prefix of [false, true]) {
    it(`closes an interrupted stream ${prefix ? "after writing a prefix" : "before its file opens"} before deleting its temporary file`, async () => {
      const key = "objects/interrupted";
      const source = new PendingUpload();
      const fiber = Effect.runFork(
        Effect.flatMap(BlobStore, (store) => store.put(key, { stream: source, length: 100 })).pipe(
          Effect.provide(BlobStoreFsLive(root)),
        ),
      );
      try {
        await source.piped.promise;
        const output = source.output;
        if (output === null) throw new Error("the upload must pipe to a real file stream");
        if (prefix) {
          source.push(Buffer.from("partial"));
          await new Promise<void>((resolve, reject) => {
            output.write(Buffer.alloc(0), (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          const temporary = fs.readdirSync(path.join(root, ".tmp"));
          expect(temporary).toHaveLength(1);
          expect(fs.readFileSync(path.join(root, ".tmp", temporary[0] ?? ""))).toEqual(
            Buffer.from("partial"),
          );
        } else {
          expect(output.pending).toBe(true);
        }
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        if (!Exit.isFailure(exit)) throw new Error("the upload must remain interrupted");
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(source.closed).toBe(true);
        expect(output.closed).toBe(true);
        expect(fs.readdirSync(path.join(root, ".tmp"))).toEqual([]);
        expect(await run(Effect.flatMap(BlobStore, (store) => store.head(key)))).toBeNull();
      } finally {
        source.destroy();
        source.output?.destroy();
        await Promise.all([
          finished(source).catch(() => undefined),
          source.output === null ? undefined : finished(source.output).catch(() => undefined),
        ]);
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    });
  }

  it("publishes successful streams atomically and preserves ifAbsent bytes", async () => {
    const key = "objects/complete";
    for (const input of ["first", "replacement"]) {
      const source = Readable.from([Buffer.from(input)]);
      expect(
        await run(
          Effect.flatMap(BlobStore, (store) =>
            store.put(key, { stream: source, length: input.length }, { ifAbsent: true }),
          ),
        ),
      ).toEqual({ written: input === "first" });
      expect(source.closed).toBe(true);
      expect(fs.readdirSync(path.join(root, ".tmp"))).toEqual([]);
    }
    expect(await run(Effect.flatMap(BlobStore, (store) => store.get(key)))).toEqual(
      new Uint8Array(Buffer.from("first")),
    );
    expect(fs.statSync(path.join(root, key)).mode & 0o777).toBe(0o444);
  });
});
