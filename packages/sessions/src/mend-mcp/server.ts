import type { SessionId } from "@mend/domain";
import { MEND_MCP_SERVER } from "@mend/domain/workbench";
import { Duration, Effect, Layer, Schedule } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import { HttpRouter } from "effect/http";

import { SessionChannelRegistry } from "../session-channel.ts";
import {
  type ChannelCaller,
  MEND_MCP_CALL_KEY_HEADER,
  MEND_MCP_PATH,
  MendMcpCaller,
} from "./caller.ts";
import { MEND_TOOLKITS, type MendMcpServices } from "./toolkits.ts";

export class MendMcp extends Context.Service<
  MendMcp,
  {
    readonly handle: (request: Request, caller: ChannelCaller) => Effect.Effect<Response>;
    readonly endSession: (sessionId: SessionId) => Effect.Effect<void>;
  }
>()("@mend/sessions/MendMcp") {}

// Effect's HTTP MCP transport keeps every session until a DELETE, and a killed bridge sends none.
export const MCP_SESSION_IDLE = Duration.minutes(30);

const MCP_SESSION_HEADER = "mcp-session-id";

export const mendMcpLayer = <R>(
  toolkits: Layer.Layer<never, never, R>,
  options: { readonly idle?: Duration.Input } = {},
): Layer.Layer<MendMcp, never, SessionChannelRegistry | R> =>
  Layer.effect(
    MendMcp,
    Effect.gen(function* () {
      const registry = yield* SessionChannelRegistry;
      const provided: Layer.Layer<never> = Layer.provide(
        toolkits,
        Layer.succeedContext(yield* Effect.context<R>()),
      );
      const app = provided.pipe(
        Layer.provideMerge(
          McpServer.layerHttp({
            name: MEND_MCP_SERVER,
            version: "1.0.0",
            path: MEND_MCP_PATH,
            protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
            allowSessionTermination: true,
          }),
        ),
      );
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(app, {
            disableLogger: true,
            middleware: (effect) => Effect.andThen(MendMcpCaller, effect),
          }),
        ),
        ({ dispose }) => Effect.promise(dispose),
      );
      const answer = (request: Request, caller: ChannelCaller) =>
        Effect.promise(() =>
          handler(
            request,
            Context.make(MendMcpCaller, {
              ...caller,
              callKey: request.headers.get(MEND_MCP_CALL_KEY_HEADER),
            }),
          ),
        );

      const opened = new Map<string, { readonly sessionId: SessionId; seenAt: number }>();
      const seen = (mcpSession: string | null) => {
        const entry = mcpSession === null ? undefined : opened.get(mcpSession);
        if (entry !== undefined) entry.seenAt = Date.now();
      };
      const end = (mcpSession: string, sessionId: SessionId) =>
        Effect.suspend(() => {
          opened.delete(mcpSession);
          return answer(
            new Request(`http://mend.session${MEND_MCP_PATH}`, {
              method: "DELETE",
              headers: { [MCP_SESSION_HEADER]: mcpSession },
            }),
            { sessionId, accountId: null, agentProcess: null },
          );
        }).pipe(Effect.asVoid);

      const handle = (request: Request, caller: ChannelCaller) =>
        Effect.gen(function* () {
          const named = request.headers.get(MCP_SESSION_HEADER);
          seen(named);
          const response = yield* answer(request, caller);
          const given = response.headers.get(MCP_SESSION_HEADER);
          if (given !== null && !opened.has(given)) {
            opened.set(given, { sessionId: caller.sessionId, seenAt: Date.now() });
          } else if (request.method === "DELETE" && named !== null) {
            opened.delete(named);
          } else {
            seen(named);
          }
          return response;
        });

      const endSession = (sessionId: SessionId) =>
        Effect.forEach(
          [...opened].filter(([, entry]) => entry.sessionId === sessionId),
          ([mcpSession]) => end(mcpSession, sessionId),
          { discard: true },
        );

      const idle = Duration.fromInputUnsafe(options.idle ?? MCP_SESSION_IDLE);
      const sweep = Effect.suspend(() => {
        const before = Date.now() - Duration.toMillis(idle);
        return Effect.forEach(
          [...opened].filter(([, entry]) => entry.seenAt < before),
          ([mcpSession, entry]) => end(mcpSession, entry.sessionId),
          { discard: true },
        );
      });
      yield* Effect.forkScoped(
        sweep.pipe(Effect.repeat(Schedule.spaced(Duration.min(idle, Duration.minutes(1))))),
      );

      const server = { handle, endSession };
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.serveMcp(server)),
        () => Effect.sync(() => registry.serveMcp(undefined)),
      );
      return server;
    }),
  );

export const MendMcpLive: Layer.Layer<MendMcp, never, SessionChannelRegistry | MendMcpServices> =
  mendMcpLayer(MEND_TOOLKITS);
