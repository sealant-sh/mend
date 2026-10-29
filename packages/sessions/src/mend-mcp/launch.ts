import { MEND_MCP_SERVER } from "@mend/domain/workbench";

import { MEND_HELPER_PATH } from "../session-socket.ts";
import { MEND_AGENT_PROCESS_ENV, MEND_MCP_TOOL_TIMEOUT_SECONDS } from "./caller.ts";

// Attached with `=`: `--mcp-config` takes any number of values, so a separate value would take the
// prompt after it as a second config (Claude 2.1.308).
const CLAUDE_MCP_CONFIG = `--mcp-config=${JSON.stringify({
  mcpServers: {
    [MEND_MCP_SERVER]: { type: "stdio", command: MEND_HELPER_PATH, args: ["mcp"] },
  },
})}`;

// Codex passes a stdio server only an allow-list of its environment, so the channel's variables
// are named.
const CODEX_MCP_CONFIG = [
  "-c",
  `mcp_servers.${MEND_MCP_SERVER}.command=${JSON.stringify(MEND_HELPER_PATH)}`,
  "-c",
  `mcp_servers.${MEND_MCP_SERVER}.args=["mcp"]`,
  "-c",
  `mcp_servers.${MEND_MCP_SERVER}.env_vars=${JSON.stringify([
    "MEND_SESSION_ENDPOINT",
    "MEND_SESSION_ID",
    "MEND_SESSION_TOKEN",
    "MEND_SESSION_TOKEN_FILE",
    MEND_AGENT_PROCESS_ENV,
  ])}`,
  "-c",
  `mcp_servers.${MEND_MCP_SERVER}.tool_timeout_sec=${MEND_MCP_TOOL_TIMEOUT_SECONDS}`,
] as const;

export const mendMcpFlags = (harness: string): ReadonlyArray<string> =>
  harness === "claude" ? [CLAUDE_MCP_CONFIG] : harness === "codex" ? CODEX_MCP_CONFIG : [];

const namesMendMcp = (argv: ReadonlyArray<string>, flags: ReadonlyArray<string>): boolean =>
  argv.some((_, at) => flags.every((flag, offset) => argv[at + offset] === flag));

export const withMendMcp = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (head === undefined) return argv;
  const flags = mendMcpFlags(head);
  return flags.length === 0 || namesMendMcp(argv, flags) ? argv : [head, ...flags, ...rest];
};
