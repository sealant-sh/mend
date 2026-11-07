/**
 * Pi's session-only extension. It uses the same stdio server as the other harnesses, including
 * when a person's pi-mcp-adapter replaces pi's built-in MCP extension. No profile file is changed.
 * Plain JSON schemas are accepted by pi's tool API; the staged module needs only Node built-ins.
 */
export const piMcpExtensionSource = (helper: string, timeoutMs: number): string => `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export default async function mendMcp(pi) {
  const child = spawn(${JSON.stringify(helper)}, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let ended = false;
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\n");
  const fail = (error) => {
    ended = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", () => fail(new Error("Mend's MCP server could not start")));
  child.on("exit", () => fail(new Error("Mend's MCP server ended")));
  child.stdin.on("error", () => fail(new Error("Mend's MCP input closed")));
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Mend's MCP server sent invalid JSON")); child.kill(); return; }
    if (message === null || typeof message !== "object") return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.error) request.reject(new Error(message.error.message || "Mend refused the MCP request"));
    else request.resolve(message.result);
  });
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error("Mend's MCP server is unavailable")); return; }
    if (signal?.aborted) { reject(new Error("Mend tool call cancelled")); return; }
    const id = ++nextId;
    const finish = (f) => (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pending.delete(id);
      f(value);
    };
    const cancel = () => {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
      entry.reject(new Error("Mend tool call cancelled"));
    };
    const timer = setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
      entry.reject(new Error("Mend's MCP request timed out"));
    }, ${timeoutMs});
    const entry = { resolve: finish(resolve), reject: finish(reject) };
    pending.set(id, entry);
    signal?.addEventListener("abort", cancel, { once: true });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const close = () => { fail(new Error("Mend's MCP session ended")); lines.close(); child.kill(); };
  pi.on("session_shutdown", close);
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mend-pi", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await request("tools/list", {});
    if (!Array.isArray(listed?.tools)) throw new Error("Mend's MCP server returned no tool list");
    for (const tool of listed.tools) {
      if (typeof tool.name !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object") {
        throw new Error("Mend's MCP server returned an invalid tool");
      }
      pi.registerTool({
        name: "mcp__mend__" + tool.name,
        label: tool.title || tool.name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema,
        async execute(_id, input, signal) {
          const result = await request("tools/call", { name: tool.name, arguments: input }, signal);
          const content = Array.isArray(result?.content) ? result.content.filter((block) =>
            block?.type === "text" && typeof block.text === "string" ||
            block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
          ) : [];
          if (result?.isError) throw new Error(content.filter((block) => block.type === "text").map((block) => block.text).join("\\n") || "Mend refused the tool call");
          return { content, details: { server: "mend", tool: tool.name, structuredContent: result?.structuredContent } };
        },
      });
    }
  } catch (error) { close(); throw error; }
}
`;
