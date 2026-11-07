import { CurrentUser, MendApi } from "@mend/api-contracts";
import { McpAppsRepo } from "@mend/db";
import { McpAppRequests } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { SessionSteering } from "../session-steering.ts";

/** Authorizes before resolving app state or reaching the provider's credentials. */
export const McpAppsGroupLive = HttpApiBuilder.group(MendApi, "mcpApps", (handlers) =>
  handlers
    .handle("listForSession", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        return yield* (yield* McpAppsRepo).listForSession(params.id).pipe(Effect.orDie);
      }),
    )
    .handle("snapshot", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        return yield* (yield* McpAppRequests)
          .snapshot({ sessionId: params.id, itemId: params.itemId })
          .pipe(Effect.catchTag("McpAppStorageError", Effect.die));
      }),
    )
    .handle("toolInfo", ({ params, query }) =>
      Effect.gen(function* () {
        yield* (yield* SessionSteering).session(params.id);
        const caller = yield* CurrentUser;
        return yield* (yield* McpAppRequests)
          .toolInfo({
            sessionId: params.id,
            itemId: params.itemId,
            accountId: caller.user.id,
            name: query.name,
          })
          .pipe(Effect.catchTag("McpAppStorageError", Effect.die));
      }),
    )
    .handle("callTool", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* SessionSteering).session(params.id);
        const caller = yield* CurrentUser;
        return yield* (yield* McpAppRequests)
          .callTool({
            sessionId: params.id,
            itemId: params.itemId,
            accountId: caller.user.id,
            ...payload,
          })
          .pipe(Effect.catchTag("McpAppStorageError", Effect.die));
      }),
    )
    .handle("readResource", ({ params, query }) =>
      Effect.gen(function* () {
        yield* (yield* SessionSteering).session(params.id);
        const caller = yield* CurrentUser;
        return yield* (yield* McpAppRequests)
          .readResource({
            sessionId: params.id,
            itemId: params.itemId,
            accountId: caller.user.id,
            uri: query.uri,
          })
          .pipe(Effect.catchTag("McpAppStorageError", Effect.die));
      }),
    )
    .handle("updateModelContext", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* SessionSteering).session(params.id);
        return yield* (yield* McpAppRequests)
          .updateModelContext({
            sessionId: params.id,
            itemId: params.itemId,
            ...(payload.content === undefined ? {} : { content: payload.content }),
            ...(payload.structuredContent === undefined
              ? {}
              : { structuredContent: payload.structuredContent }),
          })
          .pipe(Effect.catchTag("McpAppStorageError", Effect.die));
      }),
    ),
);
