import { createHash } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import * as https from "node:https";

/**
 * Generated payloads for the preview tests: byte `i` of every payload is `i % 251`, produced from
 * one shared slab, so no payload is ever held whole on either end.
 */

const PERIOD = 251;
/** A multiple of the period, so every full chunk is the same bytes and the slab can be reused. */
export const PATTERN_CHUNK_BYTES = PERIOD * 256;
const SLAB = Buffer.from(Array.from({ length: PATTERN_CHUNK_BYTES }, (_, i) => i % PERIOD));

export function* patternChunks(bytes: number): Generator<Buffer> {
  for (let sent = 0; sent < bytes; sent += PATTERN_CHUNK_BYTES) {
    yield SLAB.subarray(0, Math.min(PATTERN_CHUNK_BYTES, bytes - sent));
  }
}

export const patternSha256 = (bytes: number): string => {
  const hash = createHash("sha256");
  for (const chunk of patternChunks(bytes)) hash.update(chunk);
  return hash.digest("hex");
};

export const writePattern = async (
  stream: NodeJS.WritableStream & { readonly destroyed: boolean },
  bytes: number,
  onChunk?: (chunk: Buffer) => void,
): Promise<void> => {
  for (const chunk of patternChunks(bytes)) {
    if (stream.destroyed) return;
    onChunk?.(chunk);
    if (!stream.write(chunk)) {
      const settled = new AbortController();
      // `once` rejects on the stream's error: a peer that answered and closed mid-body ends it too.
      const drained = await Promise.race([
        once(stream, "drain", { signal: settled.signal }).then(() => true),
        once(stream, "close", { signal: settled.signal }).then(() => false),
      ])
        .catch(() => false)
        .finally(() => settled.abort());
      if (!drained) return;
    }
  }
  stream.end();
};

export interface UploadOptions {
  readonly bytes: number;
  readonly method?: string;
  readonly chunked?: boolean;
  readonly expectContinue?: boolean;
  readonly headers?: http.OutgoingHttpHeaders;
  readonly rejectUnauthorized?: boolean;
  readonly agent?: http.Agent;
}

export interface UploadResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  readonly sentSha256: string;
  readonly sentBytes: number;
  readonly continued: boolean;
}

export const uploadGenerated = (url: string, options: UploadOptions): Promise<UploadResult> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "application/octet-stream",
      ...options.headers,
      ...(options.chunked === true
        ? { "transfer-encoding": "chunked" }
        : { "content-length": String(options.bytes) }),
      ...(options.expectContinue === true ? { expect: "100-continue" } : {}),
    };
    const requestOptions: https.RequestOptions = {
      method: options.method ?? "POST",
      headers,
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...(target.protocol === "https:"
        ? { rejectUnauthorized: options.rejectUnauthorized ?? false }
        : {}),
    };
    const request =
      target.protocol === "https:"
        ? https.request(target, requestOptions)
        : http.request(target, requestOptions);
    const hash = createHash("sha256");
    let sentBytes = 0;
    let continued = false;
    let answered = false;
    const send = () => {
      void writePattern(request, options.bytes, (chunk) => {
        if (answered) return;
        hash.update(chunk);
        sentBytes += chunk.length;
      });
    };
    request.on("error", reject);
    request.on("response", (response) => {
      const parts: Buffer[] = [];
      response.on("data", (chunk: Buffer) => parts.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        answered = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(parts).toString("utf8"),
          sentSha256: hash.digest("hex"),
          sentBytes,
          continued,
        });
      });
    });
    if (options.expectContinue === true) {
      request.flushHeaders();
      request.once("continue", () => {
        continued = true;
        send();
      });
    } else send();
  });
