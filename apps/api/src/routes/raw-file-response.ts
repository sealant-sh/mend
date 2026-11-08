import { IncomingMessage } from "node:http";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  CurrentUser,
  RawFilePreparing,
  RawFileBusy,
  RawFileTooLarge,
  RawFileNotFound,
} from "@mend/api-contracts";
import { stampLabel, type RawFileObservation } from "@mend/sessions";
import type { RawReadError } from "@mend/store";
import { Clock, Context, Duration, Effect, Stream, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { Budgets } from "../budgets.ts";
import { budgetExceeded } from "../session-budgets.ts";

/**
 * How long a raw body waits for its reader to take the next chunk. A paused video or a sleeping
 * laptop stops reading without closing; its connection is reset, which frees the descriptor and
 * the read slot. Longer than a slow phone takes over one chunk. A reference so a test can shorten
 * it.
 */
export const RawReadStallLimit: Context.Reference<Duration.Duration> =
  Context.Reference<Duration.Duration>("@mend/api/RawReadStallLimit", {
    defaultValue: () => Duration.seconds(30),
  });

/** Serve a held raw descriptor using the API's budgets, ranges and stalled-reader bounds. */
export const rawFileResponse = (
  openFile: Effect.Effect<RawFileObservation, RawReadError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The one way to end a body whose headers went out: Node's adapter would end it short, and a
    // keep-alive client would wait for the rest.
    const reset = () => {
      if (request.source instanceof IncomingMessage)
        NodeHttpServerRequest.toServerResponse(request).destroy();
    };
    const full = yield* (yield* Budgets).rawReadSlot((yield* CurrentUser).user.id);
    if (full !== null) return yield* budgetExceeded(full, (yield* Budgets).limits);
    const file = yield* openFile.pipe(
      Effect.mapError((error) =>
        error.reason === "preparing"
          ? new RawFilePreparing({})
          : error.reason === "full" || error.reason === "busy"
            ? new RawFileBusy({ reason: error.reason })
            : error.reason === "too-large"
              ? new RawFileTooLarge({})
              : new RawFileNotFound({}),
      ),
    );
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      "x-mend-file-path": encodeURIComponent(file.canonicalPath),
      "x-mend-file-revision": file.revision,
      "x-mend-file-identity": file.identity,
      "content-length": String(file.size),
      ...(file.stamp?.source === "capture" && file.stamp.captureId !== null
        ? {
            "x-mend-capture-id": file.stamp.captureId,
            "x-mend-observation": stampLabel(file.stamp),
          }
        : {}),
    };
    let offset = 0;
    let length = file.size;
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
      const size = BigInt(file.size);
      if (!(first !== null && last !== null && last < first)) {
        if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
          return HttpServerResponse.empty({
            status: 416,
            headers: { ...headers, "content-length": "0", "content-range": `bytes */${size}` },
          });
        }
        const start = first ?? (last === null || last >= size ? 0n : size - last);
        const end = first === null || last === null || last >= size ? size - 1n : last;
        offset = Number(start);
        length = Number(end - start + 1n);
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
        headers["content-length"] = String(length);
      }
    }
    if (request.method === "HEAD") return HttpServerResponse.empty({ status, headers });
    const stall = Duration.toMillis(yield* RawReadStallLimit);
    let taken = yield* Clock.currentTimeMillis;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while ((yield* Clock.currentTimeMillis) - taken < stall) yield* Effect.sleep(stall / 4);
        reset();
      }),
    );
    return HttpServerResponse.stream(
      file.read(offset, length).pipe(
        Stream.tap(() =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            taken = now;
          }),
        ),
        Stream.onError(() => Effect.sync(reset)),
      ),
      { status, headers },
    );
  });
