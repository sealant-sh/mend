import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BlobStore,
  BlobStoreConfigError,
  BlobStoreFsLive,
  BlobStoreS3Live,
  isValidBlobKey,
  makeS3BlobStore,
  PUT_URL_TTL_MAX_SECONDS,
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
const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

interface ContractOptions {
  /** Bytes per non-final part: S3 refuses parts under 5 MiB; the directory store takes any. */
  readonly partBytes: number;
  /** MinIO deliberately lists multipart uploads by exact object key only, never by prefix. */
  readonly multipartListing: "prefix" | "exact-key";
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

    effectIt.live(
      "ranges return exact slices, clamp starts and ends, and return empty past EOF",
      () =>
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.put(key("ranges/obj"), bytes("abcdef"));
          expect(text(yield* store.getRange(key("ranges/obj"), 1, 3))).toBe("bcd");
          expect(text(yield* store.getRange(key("ranges/obj"), -4, 3))).toBe("abc");
          expect(text(yield* store.getRange(key("ranges/obj"), 4, 99))).toBe("ef");
          expect(yield* store.getRange(key("ranges/obj"), 6, 2)).toEqual(new Uint8Array());
          expect(yield* store.getRange(key("ranges/obj"), 100, 2)).toEqual(new Uint8Array());
          expect(yield* store.getRange(key("ranges/obj"), 0, 0)).toEqual(new Uint8Array());
          expect(yield* store.getRange(key("ranges/obj"), 0, -1)).toEqual(new Uint8Array());
        }).pipe(Effect.provide(layerOf())),
    );

    effectIt.live("ranges refuse missing objects and invalid keys with the named error", () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        expect(yield* tagOf(store.getRange(key("ranges/missing"), 0, 1))).toBe("BlobNotFoundError");
        for (const bad of ["../x", "/abs", "a//b", "a/./b", ""]) {
          expect(yield* tagOf(store.getRange(bad, 0, 1))).toBe("BlobStoreError");
        }
      }).pipe(Effect.provide(layerOf())),
    );

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
      const listingKey = options.multipartListing === "prefix" ? key("mp/") : target;
      const part1 = new Uint8Array(options.partBytes).fill(0x61);
      const part2 = bytes("-tail");
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const created = yield* store.createMultipart(target);
          if (created.kind !== "created") throw new Error("expected a fresh upload");
          // Keep the full prefix oracle for directory/Garage. The strict MinIO interoperability
          // lane explicitly covers only its documented exact-key listing profile.
          const open = yield* store.listMultipart(listingKey);
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
          const after = yield* store.listMultipart(listingKey);
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

    it("multipart: complete keeps the first exact bytes on every backend; abort discards; bad inputs are refused", async () => {
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
          const afterFirst = yield* store.get(target);
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
          return { first, afterFirst, second, stored, afterAbort, completeAborted, refused };
        }),
      );
      expect(result.first).toEqual({ written: true });
      const expected = Buffer.alloc(options.partBytes, 0x41);
      expect(Buffer.from(result.afterFirst).equals(expected)).toBe(true);
      expect(result.second).toEqual({ written: false });
      expect(Buffer.from(result.stored).equals(expected)).toBe(true);
      expect(result.afterAbort).toEqual([]);
      expect(result.completeAborted).toBe("BlobStoreError");
      expect(result.refused).toEqual(Array<string>(4).fill("BlobStoreError"));
    });

    it("multipart: concurrent completions have exactly one winner and retain its exact bytes", async () => {
      const target = key("mp/concurrent");
      const bodies = [0x41, 0x42, 0x43].map((value) =>
        new Uint8Array(options.partBytes).fill(value),
      );
      const result = await run(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          const uploads = yield* Effect.forEach(bodies, (body) =>
            Effect.gen(function* () {
              const upload = yield* store.createMultipart(target);
              if (upload.kind !== "created") throw new Error("expected an open upload");
              const url = yield* store.presignPart(target, upload.uploadId, 1, 120);
              const etag = yield* Effect.promise(() => putPart(url, body));
              return { uploadId: upload.uploadId, etag };
            }),
          );
          // Resolve the backend capability before the overlapping publication attempts, so its
          // one-time probe does not stagger the race being exercised.
          yield* store.startupUntil;
          // The same service owns all completes, as the API's multipart publication boundary does.
          const outcomes = yield* Effect.forEach(
            uploads,
            (upload) =>
              store.completeMultipart(target, upload.uploadId, [
                { partNumber: 1, etag: upload.etag },
              ]),
            { concurrency: "unbounded" },
          );
          return {
            outcomes,
            stored: yield* store.get(target),
            open: yield* store.listMultipart(target),
          };
        }),
      );
      const winners = result.outcomes.flatMap((outcome, index) => (outcome.written ? [index] : []));
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner === undefined) throw new Error("expected one winning completion");
      expect(result.outcomes).toEqual(
        bodies.map((_body, index) => ({ written: index === winner })),
      );
      const winningBody = bodies[winner];
      if (winningBody === undefined) throw new Error("winning completion did not have input bytes");
      expect(Buffer.from(result.stored).equals(Buffer.from(winningBody))).toBe(true);
      expect(result.open).toEqual([]);
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

  contract("contract", () => BlobStoreFsLive(root), "t", {
    partBytes: 16,
    multipartListing: "prefix",
  });

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

  // Review 2026-09-28 (6) #9, cross-repo decision 19: the directory store's `file://` URL is the
  // object's path; a holder of it must not be able to rewrite a stored object in place.
  it.skipIf(process.getuid?.() === 0)(
    "#9 a stored object is read-only: a PUT through its file:// URL cannot replace its bytes",
    async () => {
      const key = "captures/w/1/packs/readonly";
      const url = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BlobStore;
          yield* store.put(key, bytes("good"), { ifAbsent: true });
          return yield* store.presign(key, "PUT", 60, 4);
        }).pipe(Effect.provide(BlobStoreFsLive(root))),
      );
      expect(() => fs.writeFileSync(url.slice("file://".length), "evil")).toThrow(/EACCES/);
      const kept = await Effect.runPromise(
        Effect.flatMap(BlobStore, (store) => store.get(key)).pipe(
          Effect.provide(BlobStoreFsLive(root)),
        ),
      );
      expect(text(kept)).toBe("good");
      const until = await Effect.runPromise(
        Effect.flatMap(BlobStore, (store) => store.replaceableUntil(key)).pipe(
          Effect.provide(BlobStoreFsLive(root)),
        ),
      );
      expect(until).toBe(0);
    },
  );

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

/** The `x-amz-checksum-sha256` of a body. */
const checksum = (body: string) => crypto.createHash("sha256").update(body).digest("base64");

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
if (process.env["MEND_TEST_S3_REQUIRED"] === "1" && s3Config === null) {
  throw new Error("Required S3 contract needs an explicit bucket URL and test credentials");
}
const listingProfile = process.env["MEND_TEST_S3_MULTIPART_LISTING"];
if (listingProfile !== undefined && listingProfile !== "prefix" && listingProfile !== "exact-key") {
  throw new Error("Unknown S3 test multipart listing profile");
}

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

  // Multipart publication is write-once through BlobStore even when the bucket ignores the
  // conditional header: the S3 adapter owns a same-key completion lock and HEAD check.
  contract("contract", layerOf, prefix, {
    partBytes: 5 * 1024 * 1024,
    multipartListing: listingProfile === "exact-key" ? "exact-key" : "prefix",
  });

  effectIt.live("observes the declared backend's replacement and byte-binding capabilities", () =>
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const startup = yield* store.startupUntil;
      const binds = yield* store.bindsBytes;
      const until = yield* store.replaceableUntil(`${prefix}/capability/untouched`);
      if (process.env["MEND_TEST_S3_WRITE_ONCE"] === "1") {
        expect(startup).toBe(0);
        expect(binds).toBe(false);
        expect(until).toBe(0);
      } else {
        expect(startup).toBeGreaterThan(Date.now());
        expect(binds).toBe(true);
        expect(until).toBe(startup);
      }
    }).pipe(Effect.provide(layerOf())),
  );

  effectIt.live(
    "real signed fetch refuses altered signatures and wrong lengths without creating bytes",
    () =>
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = `${prefix}/signed/length`;
        const putUrl = yield* store.presign(key, "PUT", 120, 4);
        const wrong = yield* Effect.promise(() =>
          fetch(putUrl, {
            method: "PUT",
            body: "bad",
            headers: { "if-none-match": "*" },
          }),
        );
        expect(wrong.status).toBe(403);
        expect(yield* store.head(key)).toBeNull();
        const good = yield* Effect.promise(() =>
          fetch(putUrl, {
            method: "PUT",
            body: "good",
            headers: { "if-none-match": "*" },
          }),
        );
        expect(good.status).toBe(200);
        const getUrl = yield* store.presign(key, "GET", 120);
        const changed = new URL(getUrl);
        changed.searchParams.set("X-Amz-Signature", "0".repeat(64));
        const refused = yield* Effect.promise(() => fetch(changed));
        expect(refused.status).toBe(403);
        const allowed = yield* Effect.promise(() => fetch(getUrl));
        expect(allowed.status).toBe(200);
        expect(yield* Effect.promise(() => allowed.text())).toBe("good");
        expect(text(yield* store.get(key))).toBe("good");
      }).pipe(Effect.provide(layerOf())),
  );

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
    // Every PUT URL is write-once: the upload carries the `If-None-Match: *` signed into it.
    const put = await fetch(putUrl, {
      method: "PUT",
      body: "via-presign",
      headers: { "if-none-match": "*" },
    });
    expect(put.ok).toBe(true);
    const get = await fetch(getUrl);
    expect(await get.text()).toBe("via-presign");
  });

  // Review 2026-09-28 (6) #9 (the reviewer's MinIO reproduction, packages/store/test/
  // review6-s3-mutable.test.ts): a size-bound PUT URL replaced a verified content-addressed
  // object with 200. Now `If-None-Match: *` is signed into it: an upload without the header is
  // refused as unsigned, and one with it cannot replace the bytes on a bucket that refuses an
  // overwrite (S3, R2, MinIO: 412). A bucket that accepts the header and replaces anyway
  // (Garage, measured) says so through `replaceableUntil`: a proof about the key stands only
  // after the URL expired.
  it("#9 a signed PUT URL never replaces a stored object where the bucket refuses an overwrite, and says until when it could where it does not", async () => {
    if (s3Config === null) return;
    const key = `${prefix}/write-once/packs/${"a".repeat(64)}`;
    const { url, untilBefore, untilAfter } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put(key, bytes("good"), { ifAbsent: true });
        const before = yield* store.replaceableUntil(key);
        const minted = yield* store.presign(key, "PUT", 900, 4);
        return { url: minted, untilBefore: before, untilAfter: yield* store.replaceableUntil(key) };
      }).pipe(Effect.provide(layerOf())),
    );
    expect(signedHeadersOf(url)).toContain("if-none-match");
    const unsigned = await fetch(url, { method: "PUT", body: "evl1" });
    expect(unsigned.ok).toBe(false);
    const conditional = await fetch(url, {
      method: "PUT",
      body: "evl2",
      headers: { "if-none-match": "*" },
    });
    const now = Date.now();
    const stored = await Effect.runPromise(
      Effect.flatMap(BlobStore, (store) => store.get(key)).pipe(Effect.provide(layerOf())),
    );
    if (process.env["MEND_TEST_S3_WRITE_ONCE"] === "1") {
      expect(conditional.status).toBe(412);
      expect(text(stored)).toBe("good");
      expect(untilBefore).toBe(0);
      expect(untilAfter).toBe(0);
    } else {
      // Garage: the header is accepted and the bytes replaced — the store never claims otherwise.
      expect(untilBefore).toBeGreaterThan(now);
      expect(untilAfter).toBeGreaterThanOrEqual(now + 14 * 60 * 1000);
    }
  });

  // Garage, 2026-10-02: a bucket that replaces objects can still refuse other bytes. A PUT URL
  // with the bytes' SHA-256 signed in as `x-amz-checksum-sha256` writes those bytes or none, so
  // it gives no authority to replace the object, and `replaceableUntil` does not count it.
  it("a digest-requested PUT URL binds bytes on Garage or refuses replacement on a strict bucket", async () => {
    if (s3Config === null) return;
    const good = "the bytes the name says";
    const digest = crypto.createHash("sha256").update(good).digest("hex");
    const key = `${prefix}/bound/packs/${digest}`;
    const { binds, url, untilBefore, untilAfter } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const before = yield* store.replaceableUntil(key);
        const minted = yield* store.presign(key, "PUT", 900, good.length, digest);
        return {
          binds: yield* store.bindsBytes,
          url: minted,
          untilBefore: before,
          untilAfter: yield* store.replaceableUntil(key),
        };
      }).pipe(Effect.provide(layerOf())),
    );
    if (process.env["MEND_TEST_S3_WRITE_ONCE"] === "1") {
      expect(binds).toBe(false);
      expect(signedHeadersOf(url)).not.toContain("x-amz-checksum-sha256");
      const put = (body: string) =>
        fetch(url, {
          method: "PUT",
          body,
          headers: { "if-none-match": "*" },
        });
      expect((await put(good)).ok).toBe(true);
      expect((await put("other bytes, same size!")).status).toBe(412);
      expect((await put(good)).status).toBe(412);
      const stored = await Effect.runPromise(
        Effect.flatMap(BlobStore, (store) => store.get(key)).pipe(Effect.provide(layerOf())),
      );
      expect(text(stored)).toBe(good);
      expect(untilBefore).toBe(0);
      expect(untilAfter).toBe(0);
      return;
    }
    expect(binds).toBe(true);
    expect(signedHeadersOf(url)).toContain("x-amz-checksum-sha256");
    const putWith = (body: string, sum: string | null) =>
      fetch(url, {
        method: "PUT",
        body,
        headers: {
          "if-none-match": "*",
          ...(sum === null ? {} : { "x-amz-checksum-sha256": sum }),
        },
      });
    const evil = "other bytes, same size!";
    expect(evil.length).toBe(good.length);
    expect((await putWith(evil, checksum(good))).ok).toBe(false);
    expect((await putWith(evil, checksum(evil))).ok).toBe(false);
    expect((await putWith(evil, null)).ok).toBe(false);
    expect((await putWith(good, checksum(good))).ok).toBe(true);
    expect((await putWith(evil, checksum(good))).ok).toBe(false);
    expect((await putWith(good, checksum(good))).ok).toBe(true);
    const stored = await Effect.runPromise(
      Effect.flatMap(BlobStore, (store) => store.get(key)).pipe(Effect.provide(layerOf())),
    );
    expect(text(stored)).toBe(good);
    // The bound URL is not write authority: what a seal waits for is unchanged by it.
    expect(untilAfter).toBe(untilBefore);
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

/** The headers a presigned URL was signed over. */
const signedHeadersOf = (url: string) =>
  (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");

describe("upload length binding (docs/adr/0003, multi mode gate)", () => {
  const store = Effect.runSync(
    makeS3BlobStore({
      bucket: "captures",
      endpoint: "https://s3.example.invalid",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    }),
  );

  it("signs a declared size into PUT and part URLs, and leaves others unbound", async () => {
    const [bound, unbound, part] = await Effect.runPromise(
      Effect.all([
        store.presign("captures/w/1/packs/a", "PUT", 60, 1234),
        store.presign("captures/w/1/packs/b", "PUT", 60),
        store.presignPart("captures/w/1/packs/c", "upload-1", 2, 60, 5_242_880),
      ]),
    );
    expect(signedHeadersOf(bound)).toContain("content-length");
    expect(signedHeadersOf(unbound)).not.toContain("content-length");
    expect(signedHeadersOf(part)).toContain("content-length");
  });

  // Review 2026-09-28 (6) #9, cross-repo decision 19: every PUT URL is write-once — the upload
  // must carry `If-None-Match: *`, which a bucket that honours it answers with 412 over an
  // existing key. Before, a size-bound URL signed only `content-length;host`.
  it("#9 signs If-None-Match: * into every PUT URL, sized or not, and lives at most 15 minutes", async () => {
    const [bound, unbound, long] = await Effect.runPromise(
      Effect.all([
        store.presign("captures/w/1/packs/a", "PUT", 60, 1234),
        store.presign("captures/w/1/packs/b", "PUT", 60),
        store.presign("captures/w/1/packs/c", "PUT", 7 * 24 * 60 * 60, 4),
      ]),
    );
    expect(signedHeadersOf(bound)).toContain("if-none-match");
    expect(signedHeadersOf(unbound)).toContain("if-none-match");
    expect(new URL(long).searchParams.get("X-Amz-Expires")).toBe("900");
  });
});

// A bucket that does not answer the overwrite probe is treated as one that replaces objects, so
// both windows count here: the one after this store started, and each minted PUT URL's life.
describe("replacement windows on the Effect clock", () => {
  const startupWindowMs = (PUT_URL_TTL_MAX_SECONDS + 5 * 60) * 1000;
  const unreachable = makeS3BlobStore({
    bucket: "captures",
    endpoint: "https://s3.example.invalid",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  });

  effectIt.effect("the startup window runs from when the store was made", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(1_000);
      const store = yield* unreachable;
      yield* TestClock.adjust(60_000);
      expect(yield* store.startupUntil).toBe(1_000 + startupWindowMs);
      expect(yield* store.replaceableUntil("captures/w/1/packs/never-minted")).toBe(
        1_000 + startupWindowMs,
      );
    }),
  );

  effectIt.effect("a minted PUT URL keeps its key replaceable until it expires", () =>
    Effect.gen(function* () {
      const store = yield* unreachable;
      yield* TestClock.adjust(startupWindowMs + 7_000);
      yield* store.presign("captures/w/1/packs/minted", "PUT", 60);
      expect(yield* store.replaceableUntil("captures/w/1/packs/minted")).toBe(
        startupWindowMs + 7_000 + 60_000,
      );
      expect(yield* store.replaceableUntil("captures/w/1/packs/never-minted")).toBe(
        startupWindowMs,
      );
    }),
  );
});
