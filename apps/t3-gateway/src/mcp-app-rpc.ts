import {
  McpAppRequestError,
  EnvironmentAuthorizationError,
  type McpAppToolInfo,
  type McpAppCallToolResult,
  type McpAppReadResourceResult,
  type McpAppCallToolInput,
  type McpAppReadResourceInput,
  type McpAppToolInfoInput,
  type McpAppUpdateModelContextInput,
  type ThreadId,
} from "@mend/t3-contracts";
import { Effect } from "effect";

import type { PersonHub } from "./hub.ts";
import type { MendMcpApps } from "./mcp-app-client.ts";
import type { BearerSession } from "./state.ts";

type AppFailure = Effect.Error<ReturnType<MendMcpApps["mcpAppSnapshot"]>>;

type Callback<A> = Effect.Effect<A, McpAppRequestError | EnvironmentAuthorizationError>;
interface McpAppHandlers {
  readonly toolInfo: (input: McpAppToolInfoInput) => Callback<McpAppToolInfo>;
  readonly callTool: (input: McpAppCallToolInput) => Callback<McpAppCallToolResult>;
  readonly readResource: (input: McpAppReadResourceInput) => Callback<McpAppReadResourceResult>;
  readonly updateModelContext: (input: McpAppUpdateModelContextInput) => Callback<void>;
}

/** Map Mend's ownership and provider refusals to the pinned client's MCP error vocabulary. */
export const makeMcpAppHandlers = ({
  hub,
  session,
}: {
  readonly hub: PersonHub;
  readonly session: BearerSession;
}): McpAppHandlers => {
  const failure =
    (threadId: ThreadId) =>
    (error: AppFailure | Effect.Error<ReturnType<PersonHub["sessionIdForThread"]>>) => {
      if (error._tag === "MendDeviceRefused")
        return new EnvironmentAuthorizationError({
          message: "Mend no longer accepts this device. Pair again from Mend.",
          requiredScope: "orchestration:read",
        });
      const reason =
        error._tag === "McpAppError"
          ? error.reason
          : error._tag === "MendNotFound"
            ? "not-an-app"
            : "request-failed";
      return new McpAppRequestError({
        threadId,
        reason:
          reason === "context-too-large" || reason === "login-mismatch" ? "request-failed" : reason,
      });
    };
  const target = (input: { readonly threadId: ThreadId; readonly itemId: string }) =>
    Effect.gen(function* () {
      const sessionId = yield* hub
        .sessionIdForThread(input.threadId)
        .pipe(Effect.mapError(failure(input.threadId)));
      if (sessionId === null)
        return yield* new McpAppRequestError({ threadId: input.threadId, reason: "not-an-app" });
      return { sessionId, itemId: input.itemId };
    });
  return {
    toolInfo: (input: McpAppToolInfoInput) =>
      Effect.gen(function* () {
        const app = yield* target(input);
        return yield* hub.mend
          .mcpAppToolInfo(session.deviceToken, app, input.name)
          .pipe(Effect.mapError(failure(input.threadId)));
      }),
    callTool: (input: McpAppCallToolInput) =>
      Effect.gen(function* () {
        const app = yield* target(input);
        return yield* hub.mend
          .mcpAppCallTool(session.deviceToken, app, {
            name: input.name,
            arguments: input.arguments,
          })
          .pipe(Effect.mapError(failure(input.threadId)));
      }),
    readResource: (input: McpAppReadResourceInput) =>
      Effect.gen(function* () {
        const app = yield* target(input);
        return yield* hub.mend
          .mcpAppReadResource(session.deviceToken, app, input.uri)
          .pipe(Effect.mapError(failure(input.threadId)));
      }),
    updateModelContext: (input: McpAppUpdateModelContextInput) =>
      Effect.gen(function* () {
        const app = yield* target(input);
        const conversationSessionId = yield* hub
          .sessionIdForThread(input.conversationThreadId)
          .pipe(Effect.mapError(failure(input.threadId)));
        if (conversationSessionId === null)
          return yield* new McpAppRequestError({ threadId: input.threadId, reason: "not-an-app" });
        return yield* hub.mend
          .mcpAppUpdateContext(session.deviceToken, app, {
            conversationSessionId,
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.structuredContent === undefined
              ? {}
              : { structuredContent: input.structuredContent }),
          })
          .pipe(Effect.mapError(failure(input.threadId)));
      }),
  };
};
