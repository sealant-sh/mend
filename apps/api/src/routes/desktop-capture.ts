import { CaptureStoreRepo, HarnessLayoutsRepo } from "@mend/db";
import { DesktopPilotRun } from "@mend/domain";
import type { Session } from "@mend/domain/workbench";
import {
  BlobStore,
  decodeManifest,
  listCaptureFiles,
  readCaptureFile,
  readCaptureFileBytes,
  withCaptureReadPass,
} from "@mend/store";
import { Effect, Schema, Stream } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/** Byte ranges for recorded media, shared by captured artifacts and their boundary tests. */
export const desktopByteRange = (header: string | undefined, size: number) => {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? { start, end, partial: true }
    : null;
};

/** Read only this owner's session artifacts from the capture, even after its workspace ends. */
export const capturedDesktop = (session: Session, path: string, rangeHeader?: string) =>
  Effect.gen(function* () {
    const captures = yield* Effect.serviceOption(CaptureStoreRepo);
    const blobStore = yield* Effect.serviceOption(BlobStore);
    if (captures._tag === "None" || blobStore._tag === "None") return null;
    return yield* withCaptureReadPass(
      Effect.gen(function* () {
        const layouts = yield* HarnessLayoutsRepo;
        const blobs = yield* BlobStore;
        const head = (yield* captures.value.headOf(session.worktreeId))?.head;
        if (!head) return null;
        const manifest = yield* blobs
          .get(head.manifestKey)
          .pipe(Effect.flatMap((bytes) => decodeManifest(head.manifestKey, bytes)));
        const layout = yield* layouts.worktreeLayout(session.worktreeId);
        const root =
          layout.layout === "person"
            ? `harness/people/${session.ownerUserId}/desktop/${session.id}`
            : `harness/.mend/desktop/${session.id}`;
        const files = yield* listCaptureFiles(manifest, "workspace", `${root}/runs`, {
          limit: 1000,
        });
        if (path === "/state") {
          const candidates = files
            .filter((file) => file.path.endsWith("/state.json") && file.entry.size <= 64000)
            .slice(0, 20);
          const runs = [];
          for (const file of candidates) {
            const bytes = yield* readCaptureFileBytes(manifest, "workspace", file.path);
            const parsed = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(DesktopPilotRun),
            )(Buffer.from(bytes).toString("utf8")).pipe(Effect.option);
            if (parsed._tag === "None" || parsed.value.sessionId !== session.id) continue;
            const run = parsed.value;
            runs.push(
              run.status === "running"
                ? {
                    ...run,
                    status: "interrupted",
                    result: `${run.result}\nThe capture was taken before this pilot finished.`,
                  }
                : run,
            );
          }
          runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          return yield* HttpServerResponse.json({
            live: false,
            active: null,
            humanControl: false,
            runs,
            display: `Recorded desktop · observed · capture ${head.n}`,
          });
        }
        const file = files.find((entry) => entry.path === `${root}${path}`);
        if (!file) return HttpServerResponse.empty({ status: 404 });
        const range = desktopByteRange(rangeHeader, file.entry.size);
        if (!range)
          return HttpServerResponse.empty({
            status: 416,
            headers: { "content-range": `bytes */${file.entry.size}` },
          });
        const readable = yield* readCaptureFile(manifest, "workspace", file.path);
        let at = 0;
        const bytes = Stream.fromAsyncIterable<Uint8Array, Error>(
          readable,
          () => new Error("Captured desktop could not be read"),
        ).pipe(
          Stream.map((chunk) => {
            const start = Math.max(0, range.start - at),
              end = Math.min(chunk.byteLength, range.end + 1 - at);
            at += chunk.byteLength;
            return chunk.subarray(start, Math.max(start, end));
          }),
          Stream.takeUntil(() => at > range.end),
          Stream.filter((chunk) => chunk.byteLength > 0),
          Stream.ensuring(Effect.sync(() => readable.destroy())),
        );
        const type = path.endsWith(".mp4")
          ? "video/mp4"
          : path.endsWith(".png")
            ? "image/png"
            : path.endsWith(".jsonl")
              ? "application/x-ndjson"
              : "text/plain; charset=utf-8";
        return HttpServerResponse.stream(bytes, {
          status: range.partial ? 206 : 200,
          headers: {
            "content-type": type,
            "content-length": String(Math.max(0, range.end - range.start + 1)),
            "accept-ranges": "bytes",
            "cache-control": "no-store",
            "x-mend-capture": String(head.n),
            ...(range.partial
              ? { "content-range": `bytes ${range.start}-${range.end}/${file.entry.size}` }
              : {}),
          },
        });
      }),
    ).pipe(Effect.provideService(BlobStore, blobStore.value));
  });
