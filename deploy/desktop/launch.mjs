import { spawn } from "node:child_process";

// Core installs the native CLIs here after building the custom base image.
const [harness, ...original] = process.argv.slice(2);
if (!["codex", "claude"].includes(harness)) throw new Error("Unsupported desktop harness");
const mcp = "/opt/mend-desktop/mcp.mjs";
const args =
  harness === "codex"
    ? [
        "-c",
        'mcp_servers.desktop.command="node"',
        "-c",
        `mcp_servers.desktop.args=${JSON.stringify([mcp, "--session", harness])}`,
        "-c",
        'mcp_servers.desktop.env_vars=["MEND_SESSION_ID","MEND_SESSION_ENDPOINT","MEND_SESSION_TOKEN_FILE","MEND_SESSION_TOKEN"]',
        ...original,
      ]
    : [
        "--mcp-config",
        "/opt/mend-desktop/agent-mcp.json",
        "--allowedTools",
        "mcp__desktop__*",
        ...original,
      ];
const child = spawn(`/usr/local/bin/${harness}`, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  else process.exit(code ?? 1);
});
