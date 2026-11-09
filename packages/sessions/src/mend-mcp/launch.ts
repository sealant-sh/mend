import {
  MEND_MCP_SERVER,
  SCREEN_ACT_TOOL,
  SCREEN_LOOK_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
  PROOF_MISSING_TOOL,
} from "@mend/domain/workbench";

import { mapAgentCommand } from "../agent-command.ts";
import { MEND_HELPER_PATH, MEND_PI_MCP_EXTENSION_PATH } from "../session-socket.ts";
import { MEND_AGENT_PROCESS_ENV, MEND_MCP_TOOL_TIMEOUT_SECONDS } from "./caller.ts";

// Attached with `=`: `--mcp-config` takes any number of values, so a separate value would take the
// prompt after it as a second config (Claude 2.1.308).
const CLAUDE_MCP_CONFIG = `--mcp-config=${JSON.stringify({
  mcpServers: {
    [MEND_MCP_SERVER]: { type: "stdio", command: MEND_HELPER_PATH, args: ["mcp"] },
  },
})}`;

// Screen and proof calls run without a harness prompt. Executor holds its approvals in Mend.
// Rules given on
// the command line sit beside the settings' own, so a launch's `--settings` keeps its rules.
const CLAUDE_TOOLS_ALLOWED = `--allowedTools=${[
  SCREEN_LOOK_TOOL,
  SCREEN_ACT_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
  PROOF_MISSING_TOOL,
  "executor_skills",
  "executor_search",
  "executor_describe",
  "executor_call",
  "executor_execute",
  "executor_resume",
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

// OpenCode merges this environment overlay after its files. Preserve every entry of an existing
// inline overlay too. Refuse an unreadable overlay instead of silently discarding a person's config.
const OPENCODE_MCP_PROGRAM = `
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
if (!config || typeof config !== "object" || Array.isArray(config) ||
    config.mcp !== undefined && (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp))) {
  throw new Error("OpenCode inline config must be an object, with an object for mcp");
}
process.stdout.write(JSON.stringify({ ...config, mcp: { ...config.mcp,
  mend: { type: "local", command: [${JSON.stringify(MEND_HELPER_PATH)}, "mcp"], enabled: true,
    timeout: ${MEND_MCP_TOOL_TIMEOUT_SECONDS * 1000} }
} }));
`;

const OPENCODE_MCP_LAUNCH =
  `config=$(node -e '${OPENCODE_MCP_PROGRAM}') || ` +
  `{ echo "mend: OpenCode's inline config could not be read; not starting OpenCode" >&2; exit 1; }; ` +
  `export OPENCODE_CONFIG_CONTENT="$config"; exec "$@"`;

/** Each group is added whole unless the command line already has it. */
const mendMcpGroups = (harness: string): ReadonlyArray<ReadonlyArray<string>> =>
  harness === "claude"
    ? [[CLAUDE_MCP_CONFIG], [CLAUDE_TOOLS_ALLOWED]]
    : harness === "codex"
      ? [CODEX_MCP_CONFIG]
      : harness === "pi"
        ? [["--extension", MEND_PI_MCP_EXTENSION_PATH]]
        : [];

/** Harness flags that add Mend beside the person's own servers and extensions. */
export const mendMcpFlags = (harness: string): ReadonlyArray<string> =>
  mendMcpGroups(harness).flat();

const namesMendMcp = (argv: ReadonlyArray<string>, flags: ReadonlyArray<string>): boolean =>
  argv.some((_, at) => flags.every((flag, offset) => argv[at + offset] === flag));

/**
 * Add the session's MCP server without writing any harness configuration file: to the agent's
 * command inside Mend's wrappers (`mapAgentCommand`).
 */
export const withMendMcp = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  mapAgentCommand(argv, (command) => {
    const [head, ...rest] = command;
    if (head === undefined) return command;
    if (head === "opencode") return ["sh", "-c", OPENCODE_MCP_LAUNCH, "mend-opencode", ...command];
    const missing = mendMcpGroups(head)
      .filter((flags) => !namesMendMcp(command, flags))
      .flat();
    return missing.length === 0 ? command : [head, ...missing, ...rest];
  });
