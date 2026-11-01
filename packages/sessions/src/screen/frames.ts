import { createHash } from "node:crypto";

import type { ScreenFrameRef } from "@mend/db";
import { type ScreenId, ScreenFrameId } from "@mend/domain";
import { FrameDigest } from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Effect } from "effect";

/**
 * Under a key of its screen's, so no blob is shared across organizations, and by its digest, so
 * identical frames of one screen share one blob.
 */
export const screenFrameBlobKey = (screenId: ScreenId, digest: FrameDigest) =>
  `screen-frames/${screenId}/${digest}.png`;

/** A frame's id names its screen and digest, so a read finds its blob without a lookup. */
export const screenFrameId = (screenId: ScreenId, digest: FrameDigest): ScreenFrameId =>
  ScreenFrameId.make(`${screenId}.${digest}`);

/** Stores a PNG Mend encoded; null when the store refused it, and the caller still has the PNG. */
export const storeFrame = Effect.fnUntraced(function* (screenId: ScreenId, png: Uint8Array) {
  const blobs = yield* BlobStore;
  const digest = FrameDigest.make(createHash("sha256").update(png).digest("hex"));
  return yield* blobs.put(screenFrameBlobKey(screenId, digest), png, { ifAbsent: true }).pipe(
    Effect.as<ScreenFrameRef | null>({ id: screenFrameId(screenId, digest), digest }),
    Effect.catchTag("BlobStoreError", (error) =>
      Effect.logWarning("screen: frame not stored").pipe(
        Effect.annotateLogs({ screenId, cause: String(error.cause) }),
        Effect.as(null),
      ),
    ),
  );
});

/** A stored frame's PNG; null once its blob is gone or the store cannot answer. */
export const readFrame = Effect.fnUntraced(function* (screenId: ScreenId, digest: FrameDigest) {
  const blobs = yield* BlobStore;
  return yield* blobs.get(screenFrameBlobKey(screenId, digest)).pipe(
    Effect.catchTags({
      BlobNotFoundError: () => Effect.succeed(null),
      BlobStoreError: () => Effect.succeed(null),
    }),
  );
});
