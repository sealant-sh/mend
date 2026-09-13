import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { mendHome } from "./paths.ts";

/**
 * The capture store's object half (docs/adr/0002-session-capture-store.md "The capture store in
 * packages/store"): immutable, content-addressed blobs under `captures/<worktree>/<epoch>/…`,
 * `changes/<worktree>/<n>/…` and `projects/<project>/…`. Two implementations behind one port: a
 * directory (`local`, tests, the single-machine fallback) and any S3-compatible bucket (S3, R2,
 * Garage, Ceph RGW). Postgres holds every mutable pointer; nothing here is ever overwritten in
 * place by design — keys are digests, so a second write of a key carries the same bytes.
 */

export class BlobNotFoundError extends Schema.TaggedErrorClass<BlobNotFoundError>()(
  "BlobNotFoundError",
  { key: Schema.String },
) {}

export class BlobStoreError extends Schema.TaggedErrorClass<BlobStoreError>()("BlobStoreError", {
  operation: Schema.String,
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A body whose length is known up front — S3 `PutObject` needs it for a stream. */
export interface BlobBody {
  readonly stream: Readable;
  readonly length: number;
}

export interface BlobHead {
  readonly size: number;
  readonly etag: string | null;
}

export interface BlobEntry {
  readonly key: string;
  readonly size: number;
}

export type PresignMethod = "PUT" | "GET";

/** One uploaded part of a multipart upload, as the executor reports it back. */
export interface MultipartPart {
  /** 1-based. */
  readonly partNumber: number;
  /** The ETag the store answered the part's PUT with, quotes included as answered. */
  readonly etag: string;
}

/** A multipart upload the store still holds open. */
export interface MultipartUploadEntry {
  readonly key: string;
  readonly uploadId: string;
  /** When the upload was created; null when the store does not say. */
  readonly initiatedAt: Date | null;
}

/** `createMultipart`'s answer: an upload to fill, or the key already holds bytes. */
export type MultipartCreated =
  | { readonly kind: "created"; readonly uploadId: string }
  | { readonly kind: "exists" };

export class BlobStore extends Context.Service<
  BlobStore,
  {
    /**
     * Write `key`. With `ifAbsent`, an existing object is left alone and `written` is false —
     * atomic on the directory store and on S3 backends that honour `If-None-Match: *`; on a
     * backend without conditional writes (Garage) it is head-then-put, which is safe only
     * because keys are content-addressed.
     */
    readonly put: (
      key: string,
      body: Uint8Array | BlobBody,
      options?: { readonly ifAbsent?: boolean },
    ) => Effect.Effect<{ readonly written: boolean }, BlobStoreError>;
    readonly get: (key: string) => Effect.Effect<Uint8Array, BlobNotFoundError | BlobStoreError>;
    /** Stream a large object (a harness-home transcript) instead of buffering it. */
    readonly getStream: (
      key: string,
    ) => Effect.Effect<Readable, BlobNotFoundError | BlobStoreError>;
    readonly head: (key: string) => Effect.Effect<BlobHead | null, BlobStoreError>;
    /** Every key under `prefix`, sorted; pagination is the implementation's. */
    readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<BlobEntry>, BlobStoreError>;
    /**
     * A URL an executor can PUT to or GET from for `ttlSeconds`, naming the host executors
     * resolve (`MEND_BLOB_STORE_PUBLIC_URL`). The directory store answers a `file://` URL —
     * usable only by a process on this machine (the `local` degenerate case).
     */
    readonly presign: (
      key: string,
      method: PresignMethod,
      ttlSeconds: number,
    ) => Effect.Effect<string, BlobStoreError>;
    /** Server-side copy — promotion into `projects/<project>/…` never round-trips bytes. */
    readonly copy: (
      from: string,
      to: string,
    ) => Effect.Effect<void, BlobNotFoundError | BlobStoreError>;
    /** Retention's primitive; deleting a missing key is not an error. */
    readonly remove: (key: string) => Effect.Effect<void, BlobStoreError>;
    /**
     * Open a multipart upload for `key`: parts go up in parallel through `presignPart` URLs
     * and `completeMultipart` assembles them write-once (measured: one PUT stream to
     * Cloudflare peaks at 37–47 MB/s, four parts reach 64 MB/s). A key that already
     * holds bytes answers `exists` and opens nothing — S3's CreateMultipartUpload takes no
     * `If-None-Match`, so this is a HEAD; the complete is where the store enforces it.
     */
    readonly createMultipart: (key: string) => Effect.Effect<MultipartCreated, BlobStoreError>;
    /** A URL an executor can PUT part `partNumber` (1-based) of `uploadId` to for `ttlSeconds`. */
    readonly presignPart: (
      key: string,
      uploadId: string,
      partNumber: number,
      ttlSeconds: number,
    ) => Effect.Effect<string, BlobStoreError>;
    /**
     * Assemble the parts into `key` with `If-None-Match: *`: `written` is false when the key
     * already existed (the upload is then discarded). Garage accepts the header silently and
     * overwrites — harmless for a content-addressed key; R2 and S3 refuse with a 412.
     */
    readonly completeMultipart: (
      key: string,
      uploadId: string,
      parts: ReadonlyArray<MultipartPart>,
    ) => Effect.Effect<{ readonly written: boolean }, BlobStoreError>;
    /** Discard an open upload and its parts; an upload the store no longer knows is not an error. */
    readonly abortMultipart: (key: string, uploadId: string) => Effect.Effect<void, BlobStoreError>;
    /** Every open upload whose key starts with `prefix`, sorted by key — retention's orphan sweep. */
    readonly listMultipart: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<MultipartUploadEntry>, BlobStoreError>;
  }
>()("@mend/store/BlobStore") {}

// ─── Configuration ──────────────────────────────────────────────────────────

export type BlobStoreTarget =
  | { readonly kind: "dir"; readonly root: string }
  | {
      readonly kind: "s3";
      readonly bucket: string;
      readonly endpoint: string | undefined;
      readonly region: string;
      readonly forcePathStyle: boolean;
    };

export class BlobStoreConfig extends Context.Service<
  BlobStoreConfig,
  {
    readonly target: BlobStoreTarget;
    /** The S3 endpoint as executors reach it; presigned URLs are minted against it. */
    readonly publicUrl: string | undefined;
  }
>()("@mend/store/BlobStoreConfig") {
  static readonly layerFor = (
    target: BlobStoreTarget,
    publicUrl?: string,
  ): Layer.Layer<BlobStoreConfig> => Layer.succeed(BlobStoreConfig, { target, publicUrl });
}

export class BlobStoreConfigError extends Error {
  override readonly name = "BlobStoreConfigError";
}

export interface BlobStoreEnvLike {
  readonly MEND_BLOB_STORE?: string | undefined;
  readonly MEND_BLOB_STORE_PUBLIC_URL?: string | undefined;
  readonly MEND_STORE_ROOT?: string | undefined;
}

/**
 * `MEND_BLOB_STORE` is `dir://<absolute path>` or
 * `s3://<bucket>?endpoint=<url>&region=<name>&forcePathStyle=<bool>`; credentials come from the
 * usual `AWS_*` variables through the SDK's default chain. Unset = a directory beside the store
 * root (`<MEND_STORE_ROOT>/_blobs`), which is what `pnpm dev` without Docker gets.
 */
export const resolveBlobStoreConfig = (
  env: BlobStoreEnvLike,
): { readonly target: BlobStoreTarget; readonly publicUrl: string | undefined } => {
  const raw = env.MEND_BLOB_STORE?.trim();
  const publicRaw = env.MEND_BLOB_STORE_PUBLIC_URL?.trim();
  const publicUrl = publicRaw === undefined || publicRaw === "" ? undefined : publicRaw;
  if (publicUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new BlobStoreConfigError(`MEND_BLOB_STORE_PUBLIC_URL is not a URL: "${publicUrl}".`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BlobStoreConfigError("MEND_BLOB_STORE_PUBLIC_URL must be http:// or https://.");
    }
  }
  if (raw === undefined || raw === "") {
    const storeRoot =
      env.MEND_STORE_ROOT === undefined || env.MEND_STORE_ROOT === ""
        ? path.join(mendHome(), "store")
        : env.MEND_STORE_ROOT;
    return { target: { kind: "dir", root: path.join(storeRoot, "_blobs") }, publicUrl };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlobStoreConfigError(`MEND_BLOB_STORE is not a URL: "${raw}".`);
  }
  if (url.protocol === "dir:") {
    // `dir:///abs/path` parses with an empty host; `dir://relative` would put the first segment
    // in the host, which is never what anyone meant.
    if (url.host !== "" || !url.pathname.startsWith("/")) {
      throw new BlobStoreConfigError(
        `MEND_BLOB_STORE must be dir:///absolute/path for a directory store, got "${raw}".`,
      );
    }
    return { target: { kind: "dir", root: decodeURIComponent(url.pathname) }, publicUrl };
  }
  if (url.protocol === "s3:") {
    const bucket = url.host;
    if (bucket === "") throw new BlobStoreConfigError("MEND_BLOB_STORE s3:// needs a bucket.");
    const endpoint = url.searchParams.get("endpoint") ?? undefined;
    const region = url.searchParams.get("region") ?? "us-east-1";
    const fps = url.searchParams.get("forcePathStyle");
    const forcePathStyle = fps === null ? endpoint !== undefined : fps === "true" || fps === "1";
    return { target: { kind: "s3", bucket, endpoint, region, forcePathStyle }, publicUrl };
  }
  throw new BlobStoreConfigError(`MEND_BLOB_STORE must be dir:// or s3://, got "${raw}".`);
};

export const BlobStoreConfigLive: Layer.Layer<BlobStoreConfig> = Layer.effect(
  BlobStoreConfig,
  Effect.sync(() => resolveBlobStoreConfig(process.env)),
);

// ─── Shared ─────────────────────────────────────────────────────────────────

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Keys are relative, slash-separated, and never climb: the directory store maps them to paths. */
export const isValidBlobKey = (key: string): boolean =>
  KEY.test(key) && !key.split("/").some((segment) => segment === "." || segment === "..");

const checkKey = (operation: string, key: string): Effect.Effect<void, BlobStoreError> =>
  isValidBlobKey(key)
    ? Effect.void
    : Effect.fail(
        new BlobStoreError({ operation, key, cause: new Error(`invalid blob key "${key}"`) }),
      );

/** Upload ids travel back from the executor: one path segment, never a climb. */
const UPLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~+=-]*$/;

const checkUploadId = (
  operation: string,
  key: string,
  uploadId: string,
): Effect.Effect<void, BlobStoreError> =>
  UPLOAD_ID.test(uploadId) && uploadId.length <= 1024
    ? Effect.void
    : Effect.fail(
        new BlobStoreError({
          operation,
          key,
          cause: new Error(`invalid multipart upload id "${uploadId}"`),
        }),
      );

const checkPartNumber = (
  operation: string,
  key: string,
  partNumber: number,
): Effect.Effect<void, BlobStoreError> =>
  Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= 10_000
    ? Effect.void
    : Effect.fail(
        new BlobStoreError({
          operation,
          key,
          cause: new Error(`part number ${partNumber} is outside 1..10000`),
        }),
      );

/** Parts in ascending order, each number once — the store assembles in this order. */
const orderedParts = (
  operation: string,
  key: string,
  parts: ReadonlyArray<MultipartPart>,
): Effect.Effect<ReadonlyArray<MultipartPart>, BlobStoreError> => {
  const sorted = parts.toSorted((a, b) => a.partNumber - b.partNumber);
  const distinct = new Set(sorted.map((part) => part.partNumber)).size === sorted.length;
  return sorted.length > 0 && distinct && sorted.every((part) => part.etag !== "")
    ? Effect.forEach(sorted, (part) => checkPartNumber(operation, key, part.partNumber), {
        discard: true,
      }).pipe(Effect.as(sorted))
    : Effect.fail(
        new BlobStoreError({
          operation,
          key,
          cause: new Error("parts must be non-empty, distinct by number, each with an etag"),
        }),
      );
};

const collect = (stream: Readable): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    stream.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    stream.on("error", reject);
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });

// ─── Directory store ────────────────────────────────────────────────────────

/** Build the directory-backed service value; `root` is created on first use. */
export const makeFsBlobStore = (root: string): typeof BlobStore.Service => {
  const tmpDir = path.join(root, ".tmp");
  /** Open multipart uploads: `.multipart/<uploadId>/{meta.json, part-<n>}`. */
  const multipartDir = path.join(root, ".multipart");
  const objectPath = (key: string) => path.join(root, key);
  const uploadDir = (uploadId: string) => path.join(multipartDir, uploadId);
  const partPath = (uploadId: string, partNumber: number) =>
    path.join(uploadDir(uploadId), `part-${partNumber}`);
  const attempt = <A>(operation: string, key: string, thunk: () => A) =>
    Effect.try({
      try: thunk,
      catch: (cause) => new BlobStoreError({ operation, key, cause }),
    });

  const put = Effect.fn("BlobStore.put")(function* (
    key: string,
    body: Uint8Array | BlobBody,
    options?: { readonly ifAbsent?: boolean },
  ) {
    yield* checkKey("put", key);
    const target = objectPath(key);
    const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`);
    yield* attempt("put", key, () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
    });
    if (body instanceof Uint8Array) {
      yield* attempt("put", key, () => fs.writeFileSync(tmp, body));
    } else {
      yield* Effect.tryPromise({
        try: async () => {
          const out = fs.createWriteStream(tmp);
          await new Promise<void>((resolve, reject) => {
            body.stream.on("error", reject);
            out.on("error", reject);
            out.on("finish", () => resolve());
            body.stream.pipe(out);
          });
        },
        catch: (cause) => new BlobStoreError({ operation: "put", key, cause }),
      });
    }
    // Publish atomically: rename replaces; link refuses an existing target (EEXIST) — that is the
    // `ifAbsent` race decided by the filesystem, not by a check we made a moment ago.
    return yield* attempt("put", key, () => {
      try {
        if (options?.ifAbsent === true) {
          try {
            fs.linkSync(tmp, target);
          } catch (error) {
            if (isErrno(error, "EEXIST")) return { written: false };
            throw error;
          }
          return { written: true };
        }
        fs.renameSync(tmp, target);
        return { written: true };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  const get = Effect.fn("BlobStore.get")(function* (key: string) {
    yield* checkKey("get", key);
    return yield* Effect.try({
      try: () => new Uint8Array(fs.readFileSync(objectPath(key))),
      catch: (cause) =>
        isErrno(cause, "ENOENT")
          ? new BlobNotFoundError({ key })
          : new BlobStoreError({ operation: "get", key, cause }),
    });
  });

  const getStream = Effect.fn("BlobStore.getStream")(function* (key: string) {
    yield* checkKey("getStream", key);
    // Open first so a missing key fails here, not on the consumer's first read.
    const fd = yield* Effect.try({
      try: () => fs.openSync(objectPath(key), "r"),
      catch: (cause) =>
        isErrno(cause, "ENOENT")
          ? new BlobNotFoundError({ key })
          : new BlobStoreError({ operation: "getStream", key, cause }),
    });
    return fs.createReadStream(objectPath(key), { fd });
  });

  const head = Effect.fn("BlobStore.head")(function* (key: string) {
    yield* checkKey("head", key);
    return yield* attempt("head", key, (): BlobHead | null => {
      try {
        const stat = fs.statSync(objectPath(key));
        return stat.isFile() ? { size: stat.size, etag: null } : null;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    });
  });

  const list = Effect.fn("BlobStore.list")(function* (prefix: string) {
    return yield* attempt("list", prefix, (): ReadonlyArray<BlobEntry> => {
      if (!fs.existsSync(root)) return [];
      const out: Array<BlobEntry> = [];
      const walk = (dir: string, rel: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (rel === "" && (entry.name === ".tmp" || entry.name === ".multipart")) continue;
          const key = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), key);
          } else if (entry.isFile() && key.startsWith(prefix)) {
            out.push({ key, size: fs.statSync(path.join(dir, entry.name)).size });
          }
        }
      };
      walk(root, "");
      return out.toSorted((a, b) => a.key.localeCompare(b.key));
    });
  });

  const presign = Effect.fn("BlobStore.presign")(function* (key: string) {
    yield* checkKey("presign", key);
    return `file://${objectPath(key)}`;
  });

  const copy = Effect.fn("BlobStore.copy")(function* (from: string, to: string) {
    yield* checkKey("copy", from);
    yield* checkKey("copy", to);
    const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.dirname(objectPath(to)), { recursive: true });
        try {
          fs.copyFileSync(objectPath(from), tmp);
          fs.renameSync(tmp, objectPath(to));
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      },
      catch: (cause) =>
        isErrno(cause, "ENOENT")
          ? new BlobNotFoundError({ key: from })
          : new BlobStoreError({ operation: "copy", key: from, cause }),
    });
  });

  const remove = Effect.fn("BlobStore.remove")(function* (key: string) {
    yield* checkKey("remove", key);
    yield* attempt("remove", key, () => fs.rmSync(objectPath(key), { force: true }));
  });

  interface UploadMeta {
    readonly key: string;
    readonly initiatedAt: string;
  }
  const readMeta = (uploadId: string): UploadMeta | null => {
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(path.join(uploadDir(uploadId), "meta.json"), "utf8"),
      );
      if (typeof raw !== "object" || raw === null) return null;
      const record = raw as Record<string, unknown>;
      const key = record["key"];
      const initiatedAt = record["initiatedAt"];
      return typeof key === "string" && typeof initiatedAt === "string"
        ? { key, initiatedAt }
        : null;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  };
  /** The upload must exist and belong to `key`: a part URL for another key's upload is refused. */
  const requireUpload = (operation: string, key: string, uploadId: string) =>
    Effect.gen(function* () {
      yield* checkKey(operation, key);
      yield* checkUploadId(operation, key, uploadId);
      const meta = yield* attempt(operation, key, () => readMeta(uploadId));
      if (meta === null || meta.key !== key) {
        return yield* new BlobStoreError({
          operation,
          key,
          cause: new Error(`no multipart upload "${uploadId}" for this key`),
        });
      }
      return meta;
    });

  const createMultipart = Effect.fn("BlobStore.createMultipart")(function* (key: string) {
    yield* checkKey("createMultipart", key);
    return yield* attempt("createMultipart", key, (): MultipartCreated => {
      if (fs.existsSync(objectPath(key))) return { kind: "exists" };
      const uploadId = crypto.randomUUID();
      fs.mkdirSync(uploadDir(uploadId), { recursive: true });
      const meta: UploadMeta = { key, initiatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(uploadDir(uploadId), "meta.json"), JSON.stringify(meta));
      return { kind: "created", uploadId };
    });
  });

  const presignPart = Effect.fn("BlobStore.presignPart")(function* (
    key: string,
    uploadId: string,
    partNumber: number,
  ) {
    yield* requireUpload("presignPart", key, uploadId);
    yield* checkPartNumber("presignPart", key, partNumber);
    return `file://${partPath(uploadId, partNumber)}`;
  });

  const completeMultipart = Effect.fn("BlobStore.completeMultipart")(function* (
    key: string,
    uploadId: string,
    parts: ReadonlyArray<MultipartPart>,
  ) {
    yield* requireUpload("completeMultipart", key, uploadId);
    const ordered = yield* orderedParts("completeMultipart", key, parts);
    const target = objectPath(key);
    const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`);
    // Concatenate in part order into a temp file, then publish exactly as `put` does: `link`
    // refuses an existing target, which is the `If-None-Match: *` of a directory.
    return yield* attempt("completeMultipart", key, () => {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const out = fs.openSync(tmp, "w");
        try {
          for (const part of ordered) {
            const source = partPath(uploadId, part.partNumber);
            if (!fs.existsSync(source)) {
              throw new Error(`part ${part.partNumber} was never uploaded`);
            }
            fs.writeSync(out, fs.readFileSync(source));
          }
        } finally {
          fs.closeSync(out);
        }
        try {
          fs.linkSync(tmp, target);
        } catch (error) {
          if (isErrno(error, "EEXIST")) return { written: false };
          throw error;
        }
        return { written: true };
      } finally {
        fs.rmSync(tmp, { force: true });
        // Completed or refused, the upload is consumed either way.
        fs.rmSync(uploadDir(uploadId), { recursive: true, force: true });
      }
    });
  });

  const abortMultipart = Effect.fn("BlobStore.abortMultipart")(function* (
    key: string,
    uploadId: string,
  ) {
    yield* checkKey("abortMultipart", key);
    yield* checkUploadId("abortMultipart", key, uploadId);
    yield* attempt("abortMultipart", key, () => {
      const meta = readMeta(uploadId);
      if (meta === null || meta.key !== key) return;
      fs.rmSync(uploadDir(uploadId), { recursive: true, force: true });
    });
  });

  const listMultipart = Effect.fn("BlobStore.listMultipart")(function* (prefix: string) {
    return yield* attempt("listMultipart", prefix, (): ReadonlyArray<MultipartUploadEntry> => {
      if (!fs.existsSync(multipartDir)) return [];
      const out: Array<MultipartUploadEntry> = [];
      for (const entry of fs.readdirSync(multipartDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readMeta(entry.name);
        if (meta === null || !meta.key.startsWith(prefix)) continue;
        const initiated = new Date(meta.initiatedAt);
        out.push({
          key: meta.key,
          uploadId: entry.name,
          initiatedAt: Number.isNaN(initiated.getTime()) ? null : initiated,
        });
      }
      return out.toSorted(
        (a, b) => a.key.localeCompare(b.key) || a.uploadId.localeCompare(b.uploadId),
      );
    });
  });

  return {
    put,
    get,
    getStream,
    head,
    list,
    presign,
    copy,
    remove,
    createMultipart,
    presignPart,
    completeMultipart,
    abortMultipart,
    listMultipart,
  };
};

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export const BlobStoreFsLive = (root: string): Layer.Layer<BlobStore> =>
  Layer.succeed(BlobStore, makeFsBlobStore(root));

// ─── S3 store ───────────────────────────────────────────────────────────────

export interface S3BlobStoreOptions {
  readonly bucket: string;
  readonly endpoint?: string | undefined;
  readonly region: string;
  readonly forcePathStyle: boolean;
  /** Endpoint executors resolve; presigned URLs are signed against a client pointed here. */
  readonly publicEndpoint?: string | undefined;
  /** Explicit credentials (tests); omitted = the SDK's default chain (`AWS_*`, profiles, IMDS). */
  readonly credentials?:
    | { readonly accessKeyId: string; readonly secretAccessKey: string }
    | undefined;
}

const s3Status = (error: unknown): number | undefined =>
  error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
const s3Name = (error: unknown): string | undefined =>
  error instanceof S3ServiceException ? error.name : undefined;
const isS3NotFound = (error: unknown) =>
  s3Status(error) === 404 || s3Name(error) === "NoSuchKey" || s3Name(error) === "NotFound";

const bodyOf = (body: Uint8Array | BlobBody) =>
  body instanceof Uint8Array
    ? { Body: body, ContentLength: body.byteLength }
    : { Body: body.stream, ContentLength: body.length };

/** Build the S3-backed service value over any S3-compatible endpoint. */
export const makeS3BlobStore = (options: S3BlobStoreOptions): typeof BlobStore.Service => {
  const clientOptions = {
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    // The SDK's default flexible checksums sign an empty-body CRC32 into presigned PUT URLs,
    // which every real upload then fails (measured against Garage); required-only keeps
    // presigning honest and matches what non-AWS backends implement.
    requestChecksumCalculation: "WHEN_REQUIRED" as const,
    responseChecksumValidation: "WHEN_REQUIRED" as const,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  };
  const client = new S3Client(clientOptions);
  const publicClient =
    options.publicEndpoint === undefined
      ? client
      : new S3Client({ ...clientOptions, endpoint: options.publicEndpoint });
  const bucket = options.bucket;
  const call = <A>(operation: string, key: string, thunk: () => Promise<A>) =>
    Effect.tryPromise({
      try: thunk,
      catch: (cause) => new BlobStoreError({ operation, key, cause }),
    });

  const put = Effect.fn("BlobStore.put")(function* (
    key: string,
    body: Uint8Array | BlobBody,
    putOptions?: { readonly ifAbsent?: boolean },
  ) {
    yield* checkKey("put", key);
    if (putOptions?.ifAbsent !== true) {
      yield* call("put", key, () =>
        client.send(new PutObjectCommand({ Bucket: bucket, Key: key, ...bodyOf(body) })),
      );
      return { written: true };
    }
    // Streams cannot be replayed after a refused conditional write, so buffer them once here:
    // `ifAbsent` callers pass small objects (manifests, dir objects) by contract.
    const bytes =
      body instanceof Uint8Array
        ? body
        : yield* Effect.tryPromise({
            try: () => collect(body.stream),
            catch: (cause) => new BlobStoreError({ operation: "put", key, cause }),
          });
    // HEAD first, then a conditional PUT. Backends with conditional writes (S3, R2) turn the
    // remaining race into a 412; Garage accepts `If-None-Match: *` silently (measured, v2.4.1),
    // so there the HEAD is the whole check — harmless, because a content-addressed key carries
    // the same bytes whoever wins.
    const existing = yield* head(key);
    if (existing !== null) return { written: false };
    return yield* Effect.tryPromise({
      try: () =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.byteLength,
            IfNoneMatch: "*",
          }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.map(() => ({ written: true })),
      Effect.catch((cause) =>
        s3Status(cause) === 412
          ? Effect.succeed({ written: false })
          : Effect.fail(new BlobStoreError({ operation: "put", key, cause })),
      ),
    );
  });

  const fetchBody = (operation: string, key: string) =>
    Effect.tryPromise({
      try: () => client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) =>
        isS3NotFound(cause)
          ? new BlobNotFoundError({ key })
          : new BlobStoreError({ operation, key, cause }),
    });

  const get = Effect.fn("BlobStore.get")(function* (key: string) {
    yield* checkKey("get", key);
    const response = yield* fetchBody("get", key);
    const body = response.Body;
    if (body === undefined) return new Uint8Array();
    return yield* call("get", key, () => body.transformToByteArray());
  });

  const getStream = Effect.fn("BlobStore.getStream")(function* (key: string) {
    yield* checkKey("getStream", key);
    const response = yield* fetchBody("getStream", key);
    const body = response.Body;
    if (body instanceof Readable) return body;
    if (body === undefined) return Readable.from([]);
    const bytes = yield* call("getStream", key, () => body.transformToByteArray());
    return Readable.from([Buffer.from(bytes)]);
  });

  const head = Effect.fn("BlobStore.head")(function* (key: string) {
    yield* checkKey("head", key);
    return yield* Effect.tryPromise({
      try: () => client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((response): BlobHead | null => ({
        size: response.ContentLength ?? 0,
        etag: response.ETag ?? null,
      })),
      Effect.catch((cause) =>
        isS3NotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(new BlobStoreError({ operation: "head", key, cause })),
      ),
    );
  });

  const list = Effect.fn("BlobStore.list")(function* (prefix: string) {
    const out: Array<BlobEntry> = [];
    let token: string | undefined;
    do {
      const page = yield* call("list", prefix, () =>
        client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        ),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) out.push({ key: object.Key, size: object.Size ?? 0 });
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return out.toSorted((a, b) => a.key.localeCompare(b.key));
  });

  const presign = Effect.fn("BlobStore.presign")(function* (
    key: string,
    method: PresignMethod,
    ttlSeconds: number,
  ) {
    yield* checkKey("presign", key);
    const command =
      method === "PUT"
        ? new PutObjectCommand({ Bucket: bucket, Key: key })
        : new GetObjectCommand({ Bucket: bucket, Key: key });
    return yield* call("presign", key, () =>
      getSignedUrl(publicClient, command, { expiresIn: ttlSeconds }),
    );
  });

  const copy = Effect.fn("BlobStore.copy")(function* (from: string, to: string) {
    yield* checkKey("copy", from);
    yield* checkKey("copy", to);
    yield* Effect.tryPromise({
      try: () =>
        client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: to,
            CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
          }),
        ),
      catch: (cause) =>
        isS3NotFound(cause)
          ? new BlobNotFoundError({ key: from })
          : new BlobStoreError({ operation: "copy", key: from, cause }),
    });
  });

  const remove = Effect.fn("BlobStore.remove")(function* (key: string) {
    yield* checkKey("remove", key);
    yield* call("remove", key, () =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    );
  });

  const createMultipart = Effect.fn("BlobStore.createMultipart")(function* (key: string) {
    yield* checkKey("createMultipart", key);
    // No conditional create exists in the S3 API; the HEAD keeps a second executor from filling
    // parts for bytes that are already there, and the complete stays the write-once gate.
    const existing = yield* head(key);
    if (existing !== null) return { kind: "exists" } satisfies MultipartCreated;
    const response = yield* call("createMultipart", key, () =>
      client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })),
    );
    const uploadId = response.UploadId;
    if (uploadId === undefined || uploadId === "") {
      return yield* new BlobStoreError({
        operation: "createMultipart",
        key,
        cause: new Error("CreateMultipartUpload answered without an upload id"),
      });
    }
    return { kind: "created", uploadId } satisfies MultipartCreated;
  });

  const presignPart = Effect.fn("BlobStore.presignPart")(function* (
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ) {
    yield* checkKey("presignPart", key);
    yield* checkUploadId("presignPart", key, uploadId);
    yield* checkPartNumber("presignPart", key, partNumber);
    return yield* call("presignPart", key, () =>
      getSignedUrl(
        publicClient,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: ttlSeconds },
      ),
    );
  });

  const abortMultipart = Effect.fn("BlobStore.abortMultipart")(function* (
    key: string,
    uploadId: string,
  ) {
    yield* checkKey("abortMultipart", key);
    yield* checkUploadId("abortMultipart", key, uploadId);
    yield* Effect.tryPromise({
      try: () =>
        client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        isS3NotFound(cause) || s3Name(cause) === "NoSuchUpload"
          ? Effect.void
          : Effect.fail(new BlobStoreError({ operation: "abortMultipart", key, cause })),
      ),
    );
  });

  const completeMultipart = Effect.fn("BlobStore.completeMultipart")(function* (
    key: string,
    uploadId: string,
    parts: ReadonlyArray<MultipartPart>,
  ) {
    yield* checkKey("completeMultipart", key);
    yield* checkUploadId("completeMultipart", key, uploadId);
    const ordered = yield* orderedParts("completeMultipart", key, parts);
    const outcome = yield* Effect.tryPromise({
      try: () =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            IfNoneMatch: "*",
            MultipartUpload: {
              Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
          }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.map(() => ({ written: true })),
      Effect.catch((cause) =>
        s3Status(cause) === 412
          ? Effect.succeed({ written: false })
          : Effect.fail(new BlobStoreError({ operation: "completeMultipart", key, cause })),
      ),
    );
    // A refused complete leaves the upload open on S3; its parts are billed until aborted.
    if (!outcome.written) yield* abortMultipart(key, uploadId).pipe(Effect.ignore);
    return outcome;
  });

  const listMultipart = Effect.fn("BlobStore.listMultipart")(function* (prefix: string) {
    const out: Array<MultipartUploadEntry> = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = yield* call("listMultipart", prefix, () =>
        client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key === undefined || upload.UploadId === undefined) continue;
        out.push({
          key: upload.Key,
          uploadId: upload.UploadId,
          initiatedAt: upload.Initiated ?? null,
        });
      }
      keyMarker = page.IsTruncated === true ? page.NextKeyMarker : undefined;
      uploadIdMarker = page.IsTruncated === true ? page.NextUploadIdMarker : undefined;
    } while (keyMarker !== undefined || uploadIdMarker !== undefined);
    return out.toSorted(
      (a, b) => a.key.localeCompare(b.key) || a.uploadId.localeCompare(b.uploadId),
    );
  });

  return {
    put,
    get,
    getStream,
    head,
    list,
    presign,
    copy,
    remove,
    createMultipart,
    presignPart,
    completeMultipart,
    abortMultipart,
    listMultipart,
  };
};

export const BlobStoreS3Live = (options: S3BlobStoreOptions): Layer.Layer<BlobStore> =>
  Layer.succeed(BlobStore, makeS3BlobStore(options));

/** The configured store: `dir://` → the directory implementation, `s3://` → the bucket. */
export const BlobStoreLive: Layer.Layer<BlobStore, never, BlobStoreConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BlobStoreConfig;
    const target = config.target;
    return target.kind === "dir"
      ? BlobStoreFsLive(target.root)
      : BlobStoreS3Live({
          bucket: target.bucket,
          endpoint: target.endpoint,
          region: target.region,
          forcePathStyle: target.forcePathStyle,
          publicEndpoint: config.publicUrl,
        });
  }),
);
