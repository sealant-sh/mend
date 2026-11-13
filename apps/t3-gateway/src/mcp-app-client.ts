import {
  McpAppError,
  McpAppRef,
  McpAppSnapshot,
  McpAppToolInfo,
  McpAppToolResult,
  McpAppResourceResult,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { MendDeviceRefused, MendNotFound, MendUnavailable } from "./mend-errors.ts";

type AppError = McpAppError | MendDeviceRefused | MendNotFound | MendUnavailable;
type Target = { readonly sessionId: string; readonly itemId: string };
type ContextUpdate = {
  readonly conversationSessionId: string;
  readonly content?: ReadonlyArray<unknown>;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
};

/** Flat token-carrying calls so every MCP read and callback passes the device gate. */
export interface MendMcpApps {
  readonly listMcpApps: (
    token: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<McpAppRef>, AppError>;
  readonly mcpAppSnapshot: (
    token: string,
    target: Target,
  ) => Effect.Effect<McpAppSnapshot, AppError>;
  readonly mcpAppToolInfo: (
    token: string,
    target: Target,
    name: string,
  ) => Effect.Effect<McpAppToolInfo, AppError>;
  readonly mcpAppCallTool: (
    token: string,
    target: Target,
    input: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
  ) => Effect.Effect<McpAppToolResult, AppError>;
  readonly mcpAppReadResource: (
    token: string,
    target: Target,
    uri: string,
  ) => Effect.Effect<McpAppResourceResult, AppError>;
  readonly mcpAppUpdateContext: (
    token: string,
    target: Target,
    input: ContextUpdate,
  ) => Effect.Effect<void, AppError>;
}

const pathOf = (target: Target) =>
  `/api/sessions/${encodeURIComponent(target.sessionId)}/mcp-apps/${encodeURIComponent(target.itemId)}`;

/** Decodes the public Mend API without exposing app bytes, arguments or tokens in traces. */
export const makeMcpAppsClient = (http: HttpClient.HttpClient, base: URL): MendMcpApps => {
  const call = <A, I>(
    token: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    schema: Schema.Codec<A, I>,
    body?: unknown,
  ): Effect.Effect<A, AppError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const operation = "MCP app request";
        const failed = () => new MendUnavailable({ operation, status: null, cause: null });
        const request = HttpClientRequest.make(method)(new URL(path, base)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(token),
        );
        const response = yield* http
          .execute(
            body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          )
          .pipe(Effect.mapError(failed));
        if (response.status === 401) return yield* new MendDeviceRefused({ operation });
        if (response.status === 404) return yield* new MendNotFound({ operation });
        if (response.status === 409) {
          const refusal = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(McpAppError)),
            Effect.mapError(failed),
          );
          return yield* refusal;
        }
        if (response.status !== 200 && response.status !== 204) return yield* failed();
        const value =
          method === "PUT" ? undefined : yield* response.json.pipe(Effect.mapError(failed));
        return yield* Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(failed));
      }),
    ).pipe(
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeoutOrElse({
        duration: "2 minutes",
        orElse: () => Effect.fail(new McpAppError({ reason: "request-failed" })),
      }),
    );
  return {
    listMcpApps: (token, sessionId) =>
      call(
        token,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/mcp-apps`,
        Schema.Array(Schema.toCodecJson(McpAppRef)),
      ),
    mcpAppSnapshot: (token, target) =>
      call(token, "GET", pathOf(target), Schema.toCodecJson(McpAppSnapshot)),
    mcpAppToolInfo: (token, target, name) =>
      call(
        token,
        "GET",
        `${pathOf(target)}/tool-info?${new URLSearchParams({ name })}`,
        McpAppToolInfo,
      ),
    mcpAppCallTool: (token, target, input) =>
      call(token, "POST", `${pathOf(target)}/call-tool`, McpAppToolResult, input),
    mcpAppReadResource: (token, target, uri) =>
      call(
        token,
        "GET",
        `${pathOf(target)}/resource?${new URLSearchParams({ uri })}`,
        McpAppResourceResult,
      ),
    mcpAppUpdateContext: (token, target, input) =>
      call(token, "PUT", `${pathOf(target)}/context`, Schema.Void, input),
  };
};
