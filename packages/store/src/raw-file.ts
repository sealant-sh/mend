import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { Context, Duration, Effect, Schema, Stream } from "effect";

/**
 * Raw reads report no filesystem paths or underlying I/O errors.
 */
export class RawReadError extends Schema.TaggedError<RawReadError>()("RawReadError", {
  reason: Schema.Literals(["missing", "io", "too-large", "preparing"]),
}) {}

const ObjectId = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const ImmutableTreeSchema = ObjectId.pipe(Schema.brand("RawImmutableTree"));
/** A full immutable Git object ID, never a branch or revision expression. */
export type ImmutableTree = typeof ImmutableTreeSchema.Type;
export const parseImmutableTree = (value: string): Effect.Effect<ImmutableTree, RawReadError> =>
  Schema.decodeUnknownEffect(ImmutableTreeSchema)(value).pipe(
    Effect.mapError(() => new RawReadError({ reason: "missing" })),
  );

const BlobIdSchema = ObjectId.pipe(Schema.brand("RawBlobId"));
export type BlobId = typeof BlobIdSchema.Type;
export const parseBlobId = (value: string): Effect.Effect<BlobId, RawReadError> =>
  Schema.decodeUnknownEffect(BlobIdSchema)(value).pipe(
    Effect.mapError(() => new RawReadError({ reason: "missing" })),
  );

/** Keeps immutable blob revisions distinct from live descriptor revisions. */
export type RawRevision =
  | { readonly kind: "blob"; readonly oid: BlobId }
  | { readonly kind: "disk"; readonly fingerprint: string };

/** Preparation includes capture restoration, tree resolution and unpacking. */
export const RawPreparationWait = Context.Reference<Duration.Duration>(
  "@mend/store/RawPreparationWait",
  {
    defaultValue: () => Duration.seconds(10),
  },
);

/** Names an immutable tree before Git is consulted, so a prepared file opens without Git. */
export type RawTreeName =
  | { readonly kind: "capture"; readonly captureId: string }
  | { readonly kind: "commit"; readonly commit: ImmutableTree };

export interface RawBlobTarget {
  /** Unpacked files are shared only within one project. */
  readonly project: string;
  readonly name: RawTreeName;
  readonly path: string;
  readonly within: string;
}

/** Where Git reads a named tree: a prepared repository and the tree or commit itself. */
export interface RawTreeSource {
  readonly repository: string;
  readonly tree: ImmutableTree;
}

export const DEFAULT_RAW_CACHE_LIMITS = {
  fileBytes: 2 * 1024 ** 3,
  totalBytes: 8 * 1024 ** 3,
  entries: 256,
  preparations: 2,
  pending: 32,
  /** A cache file no process refreshed for this long is idle, or abandoned by a crash. */
  leaseMillis: 60_000,
  /** How often a process refreshes the files it reads, writes or locks. */
  heartbeatMillis: 10_000,
  /** How often a process waiting on another's lock looks again. */
  pollMillis: 50,
  /** Prepared paths remembered on disk; past this the oldest are forgotten and prepared again. */
  paths: 16_384,
};
export const RawCacheLimits = Context.Reference<typeof DEFAULT_RAW_CACHE_LIMITS>(
  "@mend/store/RawCacheLimits",
  {
    defaultValue: () => DEFAULT_RAW_CACHE_LIMITS,
  },
);

/** One descriptor, held by the caller's scope through body consumption. */
export interface OpenRawFile {
  readonly canonicalPath: string;
  readonly size: number;
  /** Changes with the file's contents or identity. */
  readonly revision: string;
  /** Live descriptor identity, or the immutable blob revision. */
  readonly identity: string;
  readonly read: (offset: number, length: number) => Stream.Stream<Uint8Array, RawReadError>;
}

/** Opaque wire revision; callers never receive descriptor or repository identities. */
export const revisionFingerprint = (revision: RawRevision): string =>
  createHash("sha256")
    .update(revision.kind === "blob" ? `blob:${revision.oid}` : revision.fingerprint)
    .digest("hex");

/** Positional chunks from a descriptor owned by the caller's scope. */
export const readRawDescriptor =
  (fd: number, size: number): OpenRawFile["read"] =>
  (offset, length) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > size
    )
      return Stream.fail(new RawReadError({ reason: "io" }));
    return Stream.unfold(offset, (position) => {
      if (position >= offset + length) return Effect.succeed(undefined);
      // Node cannot cancel fs.read; finish its callback before the scope closes the descriptor.
      return Effect.callback<readonly [Uint8Array, number], RawReadError>((resume) => {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, offset + length - position));
        fs.read(fd, buffer, 0, buffer.length, position, (error, count) =>
          resume(
            error !== null || count === 0
              ? Effect.fail(new RawReadError({ reason: "io" }))
              : Effect.succeed([buffer.subarray(0, count), position + count] as const),
          ),
        );
      }).pipe(Effect.uninterruptible);
    });
  };
