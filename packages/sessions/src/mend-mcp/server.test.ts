import { UsersRepo } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { SessionEngineLive } from "../engine.ts";
import { Screens } from "../screen/screens.ts";
import { type SessionChannelRegistry, SessionChannelRegistryLive } from "../session-channel.ts";
import { asCaller, MEND_MCP_PATH } from "./caller.ts";
import { ProofCaptures } from "./proof-captures.ts";
import { MendMcp, mendMcpLayer } from "./server.ts";
import { SessionPages } from "./session-pages.ts";
import { MEND_TOOLKITS } from "./toolkits.ts";

class Greetings extends Context.Service<Greetings, { readonly to: (name: string) => string }>()(
  "test/Greetings",
) {}

const GreetTool = Tool.make("greet", {
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
});
const GreetToolkit = Toolkit.make(GreetTool);
const GreetToolkitLive = McpServer.toolkit(GreetToolkit).pipe(
  Layer.provide(
    GreetToolkit.toLayer(
      Effect.gen(function* () {
        const greetings = yield* Greetings;
        return {
          greet: asCaller(({ name }, caller) =>
            Effect.succeed(`${greetings.to(name)}, from ${caller.accountId}`),
          ),
        };
      }),
    ),
  ),
);

const extended = mendMcpLayer(Layer.mergeAll(MEND_TOOLKITS, GreetToolkitLive));

const post = (message: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://mend.session${MEND_MCP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
  });

describe("Mend's MCP server", () => {
  it("serves a toolkit added as one more entry, with the services it needs and each request's caller", async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const mcp = yield* MendMcp;
        const caller = {
          sessionId: SessionId.make("s-greet"),
          accountId: "maria",
          agentProcess: null,
        };
        const opened = yield* mcp.handle(
          post({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "0" },
            },
          }),
          caller,
        );
        const session = {
          "mcp-session-id": opened.headers.get("mcp-session-id") ?? "",
          "mcp-protocol-version": "2025-06-18",
        };
        const listed = yield* mcp.handle(
          post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session),
          caller,
        );
        const called = yield* mcp.handle(
          post(
            {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "greet", arguments: { name: "Anna" } },
            },
            session,
          ),
          caller,
        );
        return yield* Effect.promise(() => Promise.all([listed.json(), called.json()]));
      }).pipe(
        Effect.provide(
          extended.pipe(
            Layer.provide(Layer.mock(ProofCaptures)({})),
            Layer.provide(SessionChannelRegistryLive),
            Layer.provide(Layer.succeed(Greetings, { to: (name) => `Hello ${name}` })),
            Layer.provide(
              Layer.succeed(SessionPages, { publish: () => Effect.die("not in this test") }),
            ),
            Layer.provide(Layer.mock(Screens)({})),
            Layer.provide(Layer.mock(UsersRepo)({})),
          ),
        ),
        Effect.scoped,
      ),
    );
    expect(answers[0]).toMatchObject({
      result: {
        tools: [
          { name: "html_render" },
          { name: "screen_look" },
          { name: "screen_act" },
          { name: "proof_screenshot" },
          { name: "proof_video_start" },
          { name: "proof_video_stop" },
          { name: "proof_missing" },
          { name: "greet" },
        ],
      },
    });
    expect(answers[1]).toMatchObject({
      result: { content: [{ type: "text", text: "Hello Anna, from maria" }] },
    });
  });

  it("needs what its toolkits need, and the engine does not need it, so a toolkit may need the engine", () => {
    expectTypeOf<Layer.Services<typeof extended>>().toEqualTypeOf<
      SessionChannelRegistry | SessionPages | Screens | UsersRepo | ProofCaptures | Greetings
    >();
    expectTypeOf<Extract<Layer.Services<typeof SessionEngineLive>, MendMcp>>().toBeNever();
  });
});
