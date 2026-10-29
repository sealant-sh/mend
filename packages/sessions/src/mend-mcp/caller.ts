import type { SessionId } from "@mend/domain";
import { Effect, Option, Schema } from "effect";
import * as Context from "effect/Context";

export const MEND_MCP_PATH = "/session/mcp";

export const MEND_MCP_CALL_KEY_HEADER = "x-mend-call-key";

export const MEND_MCP_TOOL_TIMEOUT_SECONDS = 120;

/** The variable naming an agent's own process row, set where Mend opens the agent's process. */
export const MEND_AGENT_PROCESS_ENV = "MEND_AGENT_PROCESS_ID";

/**
 * The header the staged bridge names its agent process in. It names a process of a caller the
 * channel already authenticated, and proves nothing on its own.
 */
export const MEND_MCP_AGENT_PROCESS_HEADER = "x-mend-agent-process";

export interface Caller {
  readonly sessionId: SessionId;
  readonly accountId: string | null;
  readonly callKey: string | null;
}

export type ChannelCaller = Pick<Caller, "sessionId" | "accountId">;

export class McpCallerUnavailableError extends Schema.TaggedError<McpCallerUnavailableError>()(
  "McpCallerUnavailableError",
  { message: Schema.String },
) {}

// Effect's McpServer runs a toolkit's handlers in the context their layer was built in, so a
// caller provided by a layer would answer every request after it.
export class MendMcpCaller extends Context.Service<MendMcpCaller, Caller>()(
  "@mend/sessions/MendMcpCaller",
) {}

export const asCaller =
  <I, A, E, R>(handler: (input: I, caller: Caller) => Effect.Effect<A, E, R>) =>
  (input: I): Effect.Effect<A, E, R> =>
    Effect.serviceOption(MendMcpCaller).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("an MCP request reached a tool without the channel's caller"),
          onSome: (caller) => handler(input, caller),
        }),
      ),
    );
