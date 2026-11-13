import type { AgentMcpApps } from "@mend/agent-protocol";
import type { SessionProcessId } from "@mend/domain";
import type { McpAppError } from "@mend/domain/workbench";
import type { Effect } from "effect";
import * as Context from "effect/Context";

/** Resolves only the original live provider process, on the caller's own login. */
export class McpAppConnections extends Context.Service<
  McpAppConnections,
  {
    readonly forProcess: (
      processId: SessionProcessId,
      accountId: string,
    ) => Effect.Effect<AgentMcpApps, McpAppError>;
  }
>()("@mend/sessions/McpAppConnections") {}
