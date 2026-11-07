import * as http from "node:http";
import * as https from "node:https";

import { Effect } from "effect";

import { ExecutorFailure } from "./failure.ts";

/** The logical authority stays fixed; only Mend's server receives a private dial address. */
export type ExecutorTarget =
  | string
  | {
      readonly origin: string;
      readonly endpoint: { readonly host: string; readonly port: number };
    };

/** Canonical OAuth issuer/resource authority, independent of the private route. */
export const executorAuthority = (target: ExecutorTarget): string =>
  typeof target === "string" ? target : target.origin;

/** No automatic redirects or fetch metadata. Callers validate every protocol redirect. */
export const requestExecutor = (
  target: ExecutorTarget,
  path: string,
  options: RequestInit = {},
  timeoutMs = 20_000,
): Effect.Effect<Response, ExecutorFailure> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<Response>((resolve, reject) => {
        const origin = executorAuthority(target);
        const url = new URL(path, origin);
        if (url.origin !== origin || url.username || url.password) {
          reject(new Error("origin mismatch"));
          return;
        }
        const headers = new Headers(options.headers);
        headers.set("Host", url.host);
        const request = (url.protocol === "https:" ? https : http).request(
          {
            protocol: url.protocol,
            hostname: typeof target === "string" ? url.hostname : target.endpoint.host,
            port: typeof target === "string" ? url.port : target.endpoint.port,
            path: url.pathname + url.search,
            method: options.method ?? "GET",
            headers: Object.fromEntries(headers),
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            servername: url.hostname,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 16 * 1024 * 1024) {
                request.destroy(new Error("response limit"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              const answerHeaders = new Headers();
              for (let i = 0; i < response.rawHeaders.length; i += 2) {
                const name = response.rawHeaders[i];
                const value = response.rawHeaders[i + 1];
                if (name !== undefined && value !== undefined) answerHeaders.append(name, value);
              }
              const status = response.statusCode ?? 502;
              resolve(
                new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), {
                  status,
                  headers: answerHeaders,
                }),
              );
            });
          },
        );
        request.on("error", reject);
        if (options.body !== undefined && options.body !== null) {
          if (typeof options.body !== "string") {
            request.destroy(new Error("unsupported request body"));
            return;
          }
          request.write(options.body);
        }
        request.end();
      }),
    catch: () =>
      new ExecutorFailure({ kind: "unavailable", message: "Executor did not answer · observed" }),
  });
