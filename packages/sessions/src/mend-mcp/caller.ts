import { type SessionId, SessionProcessId } from "@mend/domain";
import {
  type SessionProcess,
  currentAgentProcess,
  isAgentProcessKind,
} from "@mend/domain/workbench";
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

const AGENT_PROCESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The process id a request's header names, when it has the form Mend mints one in. */
export const agentProcessNamed = (header: string | ReadonlyArray<string> | undefined) =>
  typeof header === "string" && AGENT_PROCESS_ID.test(header)
    ? SessionProcessId.make(header)
    : null;

/** One of the session's agent processes, and whether it is still the session's agent. */
export type AgentProcessRef =
  | { readonly _tag: "Current"; readonly id: SessionProcessId }
  | { readonly _tag: "Superseded"; readonly id: SessionProcessId };

/** The session's agent process `id` names among its `processes`; null when it names none. */
export const agentProcessRefOf = (
  processes: ReadonlyArray<SessionProcess>,
  id: SessionProcessId,
): AgentProcessRef | null => {
  const named = processes.find((process) => process.id === id && isAgentProcessKind(process.kind));
  if (named === undefined) return null;
  return currentAgentProcess(processes)?.id === named.id
    ? { _tag: "Current", id: named.id }
    : { _tag: "Superseded", id: named.id };
};

export interface Caller {
  readonly sessionId: SessionId;
  readonly accountId: string | null;
  /** The agent process the call names; null when it names none of the session's. */
  readonly agentProcess: AgentProcessRef | null;
  readonly callKey: string | null;
}

export type ChannelCaller = Pick<Caller, "sessionId" | "accountId" | "agentProcess">;

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
