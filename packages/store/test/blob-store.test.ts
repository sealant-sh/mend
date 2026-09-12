import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BlobStore,
  BlobStoreConfigError,
  type BlobStoreError,
  BlobStoreFsLive,
  BlobStoreS3Live,
  isValidBlobKey,
  resolveBlobStoreConfig,
} from "../src/blob-store.ts";

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const text = (raw: Uint8Array) => Buffer.from(raw).toString("utf8");

/**
 * Upload one part the way an executor does: a plain PUT to the URL the store minted. A
 * `file://` URL is the directory store's — the bytes land in the part file directly.
 */
const putPart = async (url: string, body: Uint8Array): Promise<string> => {
  if (url.startsWith("file://")) {
    fs.writeFileSync(url.slice("file://".length), body);
    return `"local-${body.byteLength}"`;
  }
  const response = await fetch(url, { method: "PUT", body: new Uint8Array(body) });
  if (!response.ok) throw new Error(`part PUT failed: ${response.status}`);
  const etag = response.headers.get("etag");
  if (etag === null) throw new Error("part PUT answered without an ETag");
  return etag;
};

/** "ok", or the tag of the error an operation was refused with. */
const tagOf = <A>(effect: Effect.Effect<A, BlobStoreError>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

interface ContractOptions {
  /** Bytes per non-final part: S3 refuses parts under 5 MiB; the directory store takes any. */
  readonly partBytes: number;
  /** Whether the backend refuses a second complete of the same key (S3, R2, dir: yes; Garage: no). */
  readonly writeOnce: boolean;
}

/** The port contract, run against whichever implementation the layer provides. */
const contract = (
  name: string,
  layerOf: () => Layer.Layer<BlobStore>,
  prefix: string,
  options: ContractOptions,
) => {
  describe(name, () => {
    const run = <A, E>(effect: Effect.Effect<A, E, BlobStore>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layerOf())));
    const key = (suffix: string) => `${prefix}/${suffix}`;

    it("round-trips bytes and reports head, list and get consistently", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          expect(yield* store.head(key("a/one"))).toBeNull();
          yield* store.put(key("a/one"), bytes("one"));
          yield* store.put(key("a/two"), bytes("two-two"));
          yield* store.put(key("b/three"), {
            stream: Readable.from([Buffer.from("thr"), Buffer.from("ee")]),
            length: 5,
          });
          const head = yield* store.head(key("a/two"));
          const listed = yield* store.list(key("a/"));
          const all = yield* store.list(key(""));
          return {
            one: text(yield* store.get(key("a/one"))),
            three: text(yield* store.get(key("b/three"))),
            head,
            listed: listed.map((entry) => entry.key),
            all: all.map((entry) => [entry.key, entry.size]),
          };
        }),
      );
      expect(result.one).toBe("one");
      expect(result.three).toBe("three");
      expect(result.head?.size).toBe(7);
      expect(result.listed).toEqual([key("a/one"), key("a/two")]);
      expect(result.all).toEqual([
        [key("a/one"), 3],
        [key("a/two"), 7],
        [key("b/three"), 5],
      ]);
    });

    it("streams an object back", async () => {
      const out = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.put(key("stream/x"), bytes("streamed"));
          const stream = yield* store.getStream(key("stream/x"));
          return yield* Effect.promise(async () => {
            const chunks: Array<Buffer> = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            return Buffer.concat(chunks).toString("utf8");
          });
        }),
      );
      expect(out).toBe("streamed");
    });

    it("ifAbsent keeps the first write and reports the second as not written", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const first = yield* store.put(key("c/obj"), bytes("first"), { ifAbsent: true });
          const second = yield* store.put(key("c/obj"), bytes("second"), { ifAbsent: true });
          const content = text(yield* store.get(key("c/obj")));
          // A plain put still replaces (same bytes by contract; the store does not police it).
          const third = yield* store.put(key("c/obj"), bytes("third"));
          return { first, second, content, third, after: text(yield* store.get(key("c/obj"))) };
        }),
      );
      expect(result.first).toEqual({ written: true });
      expect(result.second).toEqual({ written: false });
      expect(result.content).toBe("first");
      expect(result.third).toEqual({ written: true });
      expect(result.after).toBe("third");
    });

    it("get of a missing key is BlobNotFoundError; remove of a missing key is fine", async () => {
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          return yield* store.get(key("missing"));
        }).pipe(Effect.provide(layerOf()), Effect.exit),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("BlobNotFoundError");
      }
      await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.remove(key("missing"));
        }),
      );
    });

    it("copies server-side and refuses a missing source", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.put(key("src/pack"), bytes("pack-bytes"));
          yield* store.copy(key("src/pack"), key("dst/pack"));
          const copied = text(yield* store.get(key("dst/pack")));
          const missing = yield* store.copy(key("src/none"), key("dst/none")).pipe(
            Effect.map(() => "copied"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
          return { copied, missing };
        }),
      );
      expect(result.copied).toBe("pack-bytes");
      expect(result.missing).toBe("BlobNotFoundError");
    });

    it("rejects keys that climb or are absolute", async () => {
      const tags = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          return yield* Effect.forEach(["../x", "/abs", "a//b", "a/./b", ""], (bad) =>
            store.put(bad, bytes("x")).pipe(
              Effect.map(() => "ok"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            ),
          );
        }),
      );
      expect(tags).toEqual(Array<string>(5).fill("BlobStoreError"));
    });

    it("multipart: parts assemble in part order, the upload is listed until completed, a filled key answers exists", async () => {
      const target = key("mp/object");
      const part1 = new Uint8Array(options.partBytes).fill(0x61);
      const part2 = bytes("-tail");
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const created = yield* store.createMultipart(target);
          if (created.kind !== "created") throw new Error("expected a fresh upload");
          const open = yield* store.listMultipart(key("mp/"));
          const url1 = yield* store.presignPart(target, created.uploadId, 1, 120);
          const url2 = yield* store.presignPart(target, created.uploadId, 2, 120);
          // Uploaded out of order; the complete names the order.
          const etag2 = yield* Effect.promise(() => putPart(url2, part2));
          const etag1 = yield* Effect.promise(() => putPart(url1, part1));
          const completed = yield* store.completeMultipart(target, created.uploadId, [
            { partNumber: 2, etag: etag2 },
            { partNumber: 1, etag: etag1 },
          ]);
          const stored = yield* store.get(target);
          const after = yield* store.listMultipart(key("mp/"));
          const again = yield* store.createMultipart(target);
          return { open, completed, stored, after, again };
        }),
      );
      expect(result.open.map((entry) => entry.key)).toEqual([target]);
      expect(result.open[0]?.initiatedAt).toBeInstanceOf(Date);
      expect(result.completed).toEqual({ written: true });
      expect(result.stored.byteLength).toBe(part1.byteLength + part2.byteLength);
      expect(text(result.stored.subarray(part1.byteLength))).toBe("-tail");
      expect(result.stored[0]).toBe(0x61);
      expect(result.after).toEqual([]);
      expect(result.again).toEqual({ kind: "exists" });
    });

    it("multipart: complete is write-once where the backend enforces it; abort discards; bad inputs are refused", async () => {
      const target = key("mp/race");
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          // Two executors open the same key before either completes.
          const a = yield* store.createMultipart(target);
          const b = yield* store.createMultipart(target);
          if (a.kind !== "created" || b.kind !== "created") throw new Error("expected uploads");
          const bodyA = new Uint8Array(options.partBytes).fill(0x41);
          const bodyB = new Uint8Array(options.partBytes).fill(0x42);
          const urlA = yield* store.presignPart(target, a.uploadId, 1, 120);
          const urlB = yield* store.presignPart(target, b.uploadId, 1, 120);
          const etagA = yield* Effect.promise(() => putPart(urlA, bodyA));
          const etagB = yield* Effect.promise(() => putPart(urlB, bodyB));
          const first = yield* store.completeMultipart(target, a.uploadId, [
            { partNumber: 1, etag: etagA },
          ]);
          const second = yield* store.completeMultipart(target, b.uploadId, [
            { partNumber: 1, etag: etagB },
          ]);
          const stored = yield* store.get(target);
          // Abort: the upload and its parts go; a later complete has nothing to assemble.
          const c = yield* store.createMultipart(key("mp/aborted"));
          if (c.kind !== "created") throw new Error("expected an upload");
          const urlC = yield* store.presignPart(key("mp/aborted"), c.uploadId, 1, 120);
          yield* Effect.promise(() => putPart(urlC, bodyA));
          yield* store.abortMultipart(key("mp/aborted"), c.uploadId);
          yield* store.abortMultipart(key("mp/aborted"), c.uploadId);
          const afterAbort = yield* store.listMultipart(key("mp/aborted"));
          const completeAborted = yield* store
            .completeMultipart(key("mp/aborted"), c.uploadId, [{ partNumber: 1, etag: "x" }])
            .pipe(
              Effect.map(() => "completed"),
              Effect.catch((error) => Effect.succeed(error._tag)),
            );
          const refused = yield* Effect.all([
            tagOf(store.presignPart(target, a.uploadId, 0, 60)),
            tagOf(store.presignPart(target, "../escape", 1, 60)),
            tagOf(store.completeMultipart(target, a.uploadId, [])),
            tagOf(
              store.completeMultipart(target, a.uploadId, [
                { partNumber: 1, etag: "e" },
                { partNumber: 1, etag: "e" },
              ]),
            ),
          ]);
          return { first, second, stored, afterAbort, completeAborted, refused };
        }),
      );
      expect(result.first).toEqual({ written: true });
      if (options.writeOnce) {
        expect(result.second).toEqual({ written: false });
        expect(result.stored[0]).toBe(0x41);
      } else {
        expect([0x41, 0x42]).toContain(result.stored[0]);
      }
      expect(result.afterAbort).toEqual([]);
      expect(result.completeAborted).toBe("BlobStoreError");
      expect(result.refused).toEqual(Array<string>(4).fill("BlobStoreError"));
    });
  });
};

// ─── Directory store ────────────────────────────────────────────────────────

describe("BlobStore (dir)", () => {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-blobs-"));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  contract("contract", () => BlobStoreFsLive(root), "t", { partBytes: 16, writeOnce: true });

  // Only the directory store promises this: the filesystem's `link(2)` decides the race. An
  // S3 backend without conditional writes (Garage) can let several writers through.
  it("concurrent ifAbsent writers: exactly one wins", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* Effect.forEach(
          ["w0", "w1", "w2", "w3", "w4", "w5"],
          (writer) => store.put("race/obj", bytes(writer), { ifAbsent: true }),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(BlobStoreFsLive(root))),
    );
    expect(outcomes.filter((outcome) => outcome.written)).toHaveLength(1);
  });

  it("presigns a file:// URL naming the object path", async () => {
    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* store.presign("captures/w/1/packs/abc", "GET", 60);
      }).pipe(Effect.provide(BlobStoreFsLive(root))),
    );
    expect(url).toBe(`file://${path.join(root, "captures/w/1/packs/abc")}`);
  });

  it("leaves no temp files behind and never lists them, nor open multipart uploads", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put("tmpcheck/a", bytes("a"));
        yield* store.put("tmpcheck/a", bytes("a"), { ifAbsent: true });
        const created = yield* store.createMultipart("tmpcheck/open");
        if (created.kind !== "created") throw new Error("expected an upload");
        yield* Effect.promise(() =>
          putPart(
            `file://${path.join(root, ".multipart", created.uploadId, "part-1")}`,
            bytes("p"),
          ),
        );
        return yield* store.list("");
      }).pipe(Effect.provide(BlobStoreFsLive(root))),
    );
    expect(listed.some((entry) => entry.key.startsWith(".tmp"))).toBe(false);
    expect(listed.some((entry) => entry.key.startsWith(".multipart"))).toBe(false);
    expect(fs.readdirSync(path.join(root, ".tmp"))).toEqual([]);
  });
});

// ─── S3 store (Garage, R2, S3 …) — opt-in through the environment ───────────

const S3_URL = process.env["MEND_TEST_S3_URL"];
const s3Config = (() => {
  if (S3_URL === undefined || S3_URL === "") return null;
  const resolved = resolveBlobStoreConfig({ MEND_BLOB_STORE: S3_URL });
  if (resolved.target.kind !== "s3") return null;
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  if (accessKeyId === undefined || secretAccessKey === undefined) return null;
  return { target: resolved.target, credentials: { accessKeyId, secretAccessKey } };
})();

// Skipped without MEND_TEST_S3_URL (s3://bucket?endpoint=…&region=…) + AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY: the contract needs a reachable bucket (a local Garage does).
describe.skipIf(s3Config === null)("BlobStore (s3)", () => {
  const layerOf = () => {
    if (s3Config === null) throw new Error("unreachable: suite is skipped without config");
    return BlobStoreS3Live({ ...s3Config.target, credentials: s3Config.credentials });
  };
  const prefix = `test/${process.pid}-${Date.now()}`;

  afterAll(async () => {
    if (s3Config === null) return;
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const entries = yield* store.list(prefix);
        yield* Effect.forEach(entries, (entry) => store.remove(entry.key), { discard: true });
        const open = yield* store.listMultipart(prefix);
        yield* Effect.forEach(open, (entry) => store.abortMultipart(entry.key, entry.uploadId), {
          discard: true,
        });
      }).pipe(Effect.provide(layerOf())),
    );
  });

  // Garage accepts `If-None-Match: *` on a complete silently (measured, v2.4.1); S3 and R2
  // refuse with a 412. MEND_TEST_S3_WRITE_ONCE=1 asserts the strict behaviour.
  contract("contract", layerOf, prefix, {
    partBytes: 5 * 1024 * 1024,
    writeOnce: process.env["MEND_TEST_S3_WRITE_ONCE"] === "1",
  });

  it("presigned PUT and GET URLs work with plain fetch, and name the public endpoint", async () => {
    if (s3Config === null) return;
    const key = `${prefix}/presign/obj`;
    const { putUrl, getUrl, publicUrl } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const pub = yield* BlobStore.pipe(
          Effect.provide(
            BlobStoreS3Live({
              ...s3Config.target,
              credentials: s3Config.credentials,
              publicEndpoint: "http://bucket.internal:3900",
            }),
          ),
        );
        return {
          putUrl: yield* store.presign(key, "PUT", 120),
          getUrl: yield* store.presign(key, "GET", 120),
          publicUrl: yield* pub.presign(key, "GET", 120),
        };
      }).pipe(Effect.provide(layerOf())),
    );
    expect(new URL(publicUrl).host).toBe("bucket.internal:3900");
    const put = await fetch(putUrl, { method: "PUT", body: "via-presign" });
    expect(put.ok).toBe(true);
    const get = await fetch(getUrl);
    expect(await get.text()).toBe("via-presign");
  });
});

// ─── Config ─────────────────────────────────────────────────────────────────

describe("resolveBlobStoreConfig", () => {
  it("defaults to a directory beside the store root", () => {
    expect(resolveBlobStoreConfig({ MEND_STORE_ROOT: "/srv/mend" })).toEqual({
      target: { kind: "dir", root: "/srv/mend/_blobs" },
      publicUrl: undefined,
    });
  });

  it("parses dir:// and s3:// targets", () => {
    expect(resolveBlobStoreConfig({ MEND_BLOB_STORE: "dir:///var/lib/mend/blobs" }).target).toEqual(
      { kind: "dir", root: "/var/lib/mend/blobs" },
    );
    expect(
      resolveBlobStoreConfig({
        MEND_BLOB_STORE: "s3://mend?endpoint=http://garage:3900&region=garage",
        MEND_BLOB_STORE_PUBLIC_URL: "http://garage.mend.svc:3900",
      }),
    ).toEqual({
      target: {
        kind: "s3",
        bucket: "mend",
        endpoint: "http://garage:3900",
        region: "garage",
        forcePathStyle: true,
      },
      publicUrl: "http://garage.mend.svc:3900",
    });
    expect(resolveBlobStoreConfig({ MEND_BLOB_STORE: "s3://bucket" }).target).toEqual({
      kind: "s3",
      bucket: "bucket",
      endpoint: undefined,
      region: "us-east-1",
      forcePathStyle: false,
    });
  });

  it("refuses relative dir:// paths, unknown schemes and non-http public URLs", () => {
    expect(() => resolveBlobStoreConfig({ MEND_BLOB_STORE: "dir://relative/path" })).toThrow(
      BlobStoreConfigError,
    );
    expect(() => resolveBlobStoreConfig({ MEND_BLOB_STORE: "ftp://x" })).toThrow(
      BlobStoreConfigError,
    );
    expect(() =>
      resolveBlobStoreConfig({ MEND_BLOB_STORE: "s3://b", MEND_BLOB_STORE_PUBLIC_URL: "garage" }),
    ).toThrow(BlobStoreConfigError);
  });
});

describe("isValidBlobKey", () => {
  it("accepts the layout's keys and refuses climbs", () => {
    expect(isValidBlobKey("captures/wt-1/3/packs/abc.idx")).toBe(true);
    expect(isValidBlobKey("projects/p/packs/x")).toBe(true);
    expect(isValidBlobKey("../x")).toBe(false);
    expect(isValidBlobKey("a/../b")).toBe(false);
    expect(isValidBlobKey("/a")).toBe(false);
    expect(isValidBlobKey(".hidden")).toBe(false);
  });
});
