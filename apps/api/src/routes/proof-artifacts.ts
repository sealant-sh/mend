import { MendApi, NotFound, proofArtifactView } from "@mend/api-contracts";
import { ProofArtifactsRepo } from "@mend/db";
import type { ProofArtifactId } from "@mend/domain";
import { BlobStore } from "@mend/store";
import { Effect, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";

const visible = Effect.fn("proofArtifact.visible")(function* (id: ProofArtifactId) {
  const artifact = yield* (yield* ProofArtifactsRepo).byId(id).pipe(Effect.orDie);
  if (artifact === null) return yield* new NotFound({ id });
  yield* (yield* ProjectAccess)
    .change(artifact.changeId)
    .pipe(Effect.mapError(() => new NotFound({ id })));
  return artifact;
});

const media = Effect.fn("proofArtifact.media")(function* (id: ProofArtifactId) {
  const artifact = yield* visible(id);
  const capture = artifact.capture;
  if (capture._tag !== "Screenshot" && capture._tag !== "Video") return yield* new NotFound({ id });
  const blob = capture.media;
  const blobs = yield* BlobStore;
  const head = yield* blobs.head(blob.blobKey).pipe(Effect.orDie);
  if (head === null || head.size !== blob.bytes) return yield* new NotFound({ id });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headers: Record<string, string> = {
    "content-type": blob.mimeType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-length": String(head.size),
  };
  let start = 0;
  let length = head.size;
  let status = 200;
  const range =
    request.method === "HEAD" || request.headers["if-range"] !== undefined
      ? undefined
      : request.headers.range;
  const match =
    range === undefined || range.length > 1024 ? null : /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (match !== null && (match[1] || match[2])) {
    const first = match[1] ? BigInt(match[1]) : null;
    const last = match[2] ? BigInt(match[2]) : null;
    const size = BigInt(head.size);
    if (!(first !== null && last !== null && last < first)) {
      if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n))
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "content-length": "0", "content-range": `bytes */${size}` },
        });
      const offset = first ?? (last === null || last >= size ? 0n : size - last);
      const end = first === null || last === null || last >= size ? size - 1n : last;
      start = Number(offset);
      length = Number(end - offset + 1n);
      status = 206;
      headers["content-range"] = `bytes ${offset}-${end}/${size}`;
      headers["content-length"] = String(length);
    }
  }
  if (request.method === "HEAD") return HttpServerResponse.empty({ status, headers });
  // Bounded reads keep a video response streaming with either blob-store backend.
  const body = Stream.unfold(start, (offset) => {
    const remaining = start + length - offset;
    if (remaining <= 0) return Effect.succeed(undefined);
    return blobs
      .getRange(blob.blobKey, offset, Math.min(64 * 1024, remaining))
      .pipe(
        Effect.map((bytes): readonly [Uint8Array, number] | undefined =>
          bytes.length === 0 ? undefined : [bytes, offset + bytes.length],
        ),
      );
  });
  return HttpServerResponse.stream(body, { status, headers });
});

export const ProofArtifactsGroupLive = HttpApiBuilder.group(MendApi, "proofArtifacts", (handlers) =>
  handlers
    .handle("listForChange", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).change(params.changeId);
        return (yield* (yield* ProofArtifactsRepo)
          .listForChange(params.changeId)
          .pipe(Effect.orDie)).map(proofArtifactView);
      }),
    )
    .handle("byId", ({ params }) => visible(params.id).pipe(Effect.map(proofArtifactView)))
    .handle("media", ({ params }) => media(params.id))
    .handle("mediaHead", ({ params }) => media(params.id)),
);
