import { describe, expect, it } from "vitest";

import { conversationArgv } from "../conversation-home.ts";
import { MEND_HELPER_PATH } from "../session-socket.ts";
import { mendMcpFlags, withMendMcp } from "./launch.ts";

describe("withMendMcp", () => {
  it("gives Claude the helper as an inline stdio server, attached to its flag so the prompt stays the prompt", () => {
    const argv = withMendMcp(["claude", "--model", "opus", "fix the build", "--settings", "{}"]);
    expect(argv).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      "--model",
      "opus",
      "fix the build",
      "--settings",
      "{}",
    ]);
    const [flag] = mendMcpFlags("claude");
    expect(flag?.startsWith("--mcp-config=")).toBe(true);
    expect(JSON.parse(flag?.slice("--mcp-config=".length) ?? "")).toEqual({
      mcpServers: { mend: { type: "stdio", command: MEND_HELPER_PATH, args: ["mcp"] } },
    });
    expect(argv.join(" ")).not.toContain("--strict-mcp-config");
  });

  it("gives Codex root overrides naming the helper and the channel's variables", () => {
    expect(withMendMcp(["codex", "app-server"])).toEqual([
      "codex",
      "-c",
      'mcp_servers.mend.command="/run/mend/bin/mend"',
      "-c",
      'mcp_servers.mend.args=["mcp"]',
      "-c",
      'mcp_servers.mend.env_vars=["MEND_SESSION_ENDPOINT","MEND_SESSION_ID","MEND_SESSION_TOKEN","MEND_SESSION_TOKEN_FILE","MEND_AGENT_PROCESS_ID"]',
      "-c",
      "mcp_servers.mend.tool_timeout_sec=120",
      "app-server",
    ]);
  });

  it("adds the server however a prompt or a partial override reads", () => {
    expect(withMendMcp(["claude", "mcp_servers.mend.command=foo"])).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      "mcp_servers.mend.command=foo",
    ]);
    const prompt = `use ${mendMcpFlags("claude")[0] ?? ""} for this`;
    expect(withMendMcp(["claude", prompt])).toEqual(["claude", ...mendMcpFlags("claude"), prompt]);
    const partial = ["codex", "-c", 'mcp_servers.mend.command="/run/mend/bin/mend"', "exec"];
    expect(withMendMcp(partial)).toEqual(["codex", ...mendMcpFlags("codex"), ...partial.slice(1)]);
    expect(withMendMcp(["codex", mendMcpFlags("claude")[0] ?? ""])).toEqual([
      "codex",
      ...mendMcpFlags("codex"),
      mendMcpFlags("claude")[0],
    ]);
  });

  it("lets every Claude launch call the screen tools without asking, beside its own --settings", () => {
    const allowed =
      "--allowedTools=mcp__mend__screen_look,mcp__mend__screen_act,mcp__mend__proof_screenshot,mcp__mend__proof_video_start,mcp__mend__proof_video_stop,mcp__mend__proof_missing";
    const settings = JSON.stringify({ permissions: { allow: ["Bash(git status)"] } });
    expect(withMendMcp(["claude", "-p", "--settings", settings])).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      "-p",
      "--settings",
      settings,
    ]);
    expect(mendMcpFlags("claude")).toContain(allowed);
    for (const terminal of [false, true]) {
      const argv = conversationArgv({
        harness: "claude",
        argv: ["claude", "fix the build"],
        resumePath: null,
        terminal,
      });
      expect(argv.filter((arg) => arg === allowed)).toHaveLength(1);
      expect(argv).toContain("--settings");
    }
    const [config] = mendMcpFlags("claude");
    const before = ["claude", config ?? "", "-p"];
    expect(withMendMcp(before)).toEqual(["claude", allowed, config, "-p"]);
    expect(withMendMcp(["codex", "app-server"]).join(" ")).not.toContain("allowedTools");
  });

  it("is idempotent, and leaves every other command as it is", () => {
    for (const argv of [
      ["claude", "-p"],
      ["codex", "resume", "abc"],
    ]) {
      expect(withMendMcp(withMendMcp(argv))).toEqual(withMendMcp(argv));
    }
    for (const argv of [["opencode"], ["pi", "--approve"], ["bash", "-l"], []]) {
      expect(withMendMcp(argv)).toEqual(argv);
    }
  });
});
