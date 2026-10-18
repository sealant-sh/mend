import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import { HttpApi, HttpApiClient } from "effect/http-api";
import * as SchemaAST from "effect/SchemaAST";

import { MendApi } from "./api.ts";

/**
 * The derived Mend API client — every path, parameter, payload encoding and
 * response decoding comes from the contract itself ("clients derive themselves
 * from what is declared here"). Consumers provide an `HttpClient` (fetch, node,
 * test stub) and get the full typed surface: `client.sessions.launch(...)`,
 * `client.projects.list()`, with contract errors as typed failures.
 */
export type MendApiClient = HttpApiClient.ForApi<typeof MendApi>;

export const makeMendApiClient = (options: {
  readonly baseUrl: URL | string;
  /** Attach credentials, tracing, retries — runs on every request. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}): Effect.Effect<MendApiClient, never, HttpClient.HttpClient> =>
  HttpApiClient.make(MendApi, options);

/**
 * `_tag` → HTTP status for every error the contract declares, read from the
 * endpoints' own error maps — so a transport layer (the web tier's tRPC
 * bridge) can translate a typed failure into a status-correct response
 * without keeping a hand-maintained table.
 */
export const errorStatusByTag: ReadonlyMap<string, number> = (() => {
  const statuses = new Map<string, number>();
  const tagOf = SchemaAST.resolveAt("~sentinels");
  HttpApi.reflect(MendApi, {
    onGroup: () => {},
    onEndpoint: ({ errors }) => {
      for (const [status, schemas] of errors) {
        for (const schema of schemas) {
          const sentinels = tagOf(schema.ast) as
            | ReadonlyArray<{ readonly key: string; readonly literal: unknown }>
            | undefined;
          const tag = sentinels?.find((sentinel) => sentinel.key === "_tag")?.literal;
          if (typeof tag === "string" && !statuses.has(tag)) statuses.set(tag, status);
        }
      }
    },
  });
  return statuses;
})();
