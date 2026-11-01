import {
  MEND_MCP_SERVER,
  SCREEN_ACT_TOOL,
  SCREEN_LOOK_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
  PROOF_MISSING_TOOL,
} from "@mend/domain/workbench";

import { MEND_HELPER_PATH } from "../session-socket.ts";
import { MEND_AGENT_PROCESS_ENV, MEND_MCP_TOOL_TIMEOUT_SECONDS } from "./caller.ts";

// Attached with `=`: `--mcp-config` takes any number of values, so a separate value would take the
// prompt after it as a second config (Claude 2.1.308).
const CLAUDE_MCP_CONFIG = `--mcp-config=${JSON.stringify({
  mcpServers: {
    [MEND_MCP_SERVER]: { type: "stdio", command: MEND_HELPER_PATH, args: ["mcp"] },
  },
})}`;

// D9: the screen tools run without asking; a person watching takes over instead. Rules given on
// the command line sit beside the settings' own, so a launch's `--settings` keeps its rules.
const CLAUDE_SCREEN_TOOLS_ALLOWED = `--allowedTools=${[
  SCREEN_LOOK_TOOL,
  SCREEN_ACT_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
  PROOF_MISSING_TOOL,
]
  .map((tool) => `mcp__${MEND_MCP_SERVER}__${tool}`)
  .join(",")}`;

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

/** Each group is added whole unless the command line already has it. */
const mendMcpGroups = (harness: string): ReadonlyArray<ReadonlyArray<string>> =>
  harness === "claude"
    ? [[CLAUDE_MCP_CONFIG], [CLAUDE_SCREEN_TOOLS_ALLOWED]]
    : harness === "codex"
      ? [CODEX_MCP_CONFIG]
      : [];

export const mendMcpFlags = (harness: string): ReadonlyArray<string> =>
  mendMcpGroups(harness).flat();

const namesMendMcp = (argv: ReadonlyArray<string>, flags: ReadonlyArray<string>): boolean =>
  argv.some((_, at) => flags.every((flag, offset) => argv[at + offset] === flag));

export const withMendMcp = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  if (head === undefined) return argv;
  const missing = mendMcpGroups(head)
    .filter((flags) => !namesMendMcp(argv, flags))
    .flat();
  return missing.length === 0 ? argv : [head, ...missing, ...rest];
};
