import { McpAppsRepo, type McpAppStorageError } from "@mend/db";
import type { AgentItemId, SessionId } from "@mend/domain";
import {
  McpAppError,
  parseMcpAppModelContext,
  type McpAppResourceResult,
  type McpAppSnapshot,
  type McpAppToolInfo,
  type McpAppToolResult,
} from "@mend/domain/workbench";
import { Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import { McpAppConnections } from "./mcp-app-connections.ts";

type Target = { readonly sessionId: SessionId; readonly itemId: AgentItemId };
type LiveTarget = Target & { readonly accountId: string };
type RequestError = McpAppError | McpAppStorageError;

/** Runs callbacks only against the server recorded on the originating app item. */
export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly snapshot: (target: Target) => Effect.Effect<McpAppSnapshot, RequestError>;
    readonly toolInfo: (
      input: LiveTarget & { readonly name: string },
    ) => Effect.Effect<McpAppToolInfo, RequestError>;
    readonly callTool: (
      input: LiveTarget & {
        readonly name: string;
        readonly arguments: Readonly<Record<string, unknown>>;
      },
    ) => Effect.Effect<McpAppToolResult, RequestError>;
    readonly readResource: (
      input: LiveTarget & { readonly uri: string },
    ) => Effect.Effect<McpAppResourceResult, RequestError>;
    readonly updateModelContext: (
      input: Target & {
        readonly content?: ReadonlyArray<unknown>;
        readonly structuredContent?: Readonly<Record<string, unknown>>;
      },
    ) => Effect.Effect<void, RequestError>;
  }
>()("@mend/sessions/McpAppRequests") {}

const callable = (meta: unknown) => {
  const parsed = Schema.decodeUnknownOption(
    Schema.Struct({
      ui: Schema.optional(
        Schema.Struct({ visibility: Schema.optional(Schema.Array(Schema.Unknown)) }),
      ),
    }),
  )(meta);
  return (
    Option.isNone(parsed) ||
    parsed.value.ui?.visibility === undefined ||
    parsed.value.ui.visibility.includes("app")
  );
};

const failed = () => new McpAppError({ reason: "request-failed" });

const make: Effect.Effect<McpAppRequests["Service"], never, McpAppsRepo | McpAppConnections> =
  Effect.gen(function* () {
    const repo = yield* McpAppsRepo;
    const connections = yield* McpAppConnections;
    const snapshot = Effect.fn("McpAppRequests.snapshot")(function* (target: Target) {
      const app = yield* repo.byItem(target.itemId);
      if (app === null || app.sessionId !== target.sessionId)
        return yield* new McpAppError({ reason: "not-an-app" });
      return app;
    });
    const resolve = Effect.fn("McpAppRequests.resolve")(function* (target: LiveTarget) {
      const app = yield* snapshot(target);
      return { app, connection: yield* connections.forProcess(app.processId, target.accountId) };
    });
    const toolInfo = Effect.fn("McpAppRequests.toolInfo")(function* (
      input: LiveTarget & { readonly name: string },
    ) {
      const { app, connection } = yield* resolve(input);
      const tools = yield* connection.listTools(app.server).pipe(Effect.mapError(failed));
      const tool = tools.find((candidate) => candidate.name === input.name);
      const annotations = Schema.decodeUnknownOption(
        Schema.Struct({
          readOnlyHint: Schema.optional(Schema.Boolean),
          title: Schema.optional(Schema.String),
        }),
      )(tool?.annotations);
      return {
        // oxlint-disable-next-line no-underscore-dangle -- _meta is the MCP protocol field.
        callable: tool !== undefined && callable(tool._meta),
        readOnly: Option.isSome(annotations) && annotations.value.readOnlyHint === true,
        ...(Option.isSome(annotations) && annotations.value.title !== undefined
          ? { title: annotations.value.title }
          : {}),
        ...(tool === undefined ? {} : { tool }),
      };
    });
    const callTool = Effect.fn("McpAppRequests.callTool")(function* (
      input: LiveTarget & {
        readonly name: string;
        readonly arguments: Readonly<Record<string, unknown>>;
      },
    ) {
      const { app, connection } = yield* resolve(input);
      const tools = yield* connection.listTools(app.server).pipe(Effect.mapError(failed));
      const tool = tools.find((candidate) => candidate.name === input.name);
      // oxlint-disable-next-line no-underscore-dangle -- _meta is the MCP protocol field.
      if (tool === undefined || !callable(tool._meta))
        return yield* new McpAppError({ reason: "tool-not-callable" });
      return yield* connection
        .callTool({ server: app.server, tool: input.name, arguments: input.arguments })
        .pipe(Effect.mapError(failed));
    });
    const readResource = Effect.fn("McpAppRequests.readResource")(function* (
      input: LiveTarget & { readonly uri: string },
    ) {
      const { app, connection } = yield* resolve(input);
      return yield* connection
        .readResource({ server: app.server, uri: input.uri })
        .pipe(Effect.mapError(failed));
    });
    const updateModelContext = Effect.fn("McpAppRequests.updateModelContext")(function* (
      input: Target & {
        readonly content?: ReadonlyArray<unknown>;
        readonly structuredContent?: Readonly<Record<string, unknown>>;
      },
    ) {
      yield* snapshot(input);
      const text = yield* parseMcpAppModelContext(input);
      yield* repo.setContext(input.sessionId, input.itemId, text);
    });
    return McpAppRequests.of({ snapshot, toolInfo, callTool, readResource, updateModelContext });
  });

/** Uses the same live connection registry as the protocol host. */
export const McpAppRequestsLive: Layer.Layer<
  McpAppRequests,
  never,
  McpAppsRepo | McpAppConnections
> = Layer.effect(McpAppRequests, make);
