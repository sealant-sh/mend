import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { piMcpExtensionSource } from "./pi-extension.ts";

const exec = promisify(execFile);

it("registers every server tool in pi, carries the channel environment, and preserves image results and refusals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-pi-mcp-"));
  try {
    const helper = path.join(dir, "mend");
    await fs.writeFile(
      helper,
      `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } :
    m.method === "tools/list" ? { tools: ["screen_look", "proof_screenshot", "later_tool"].map(name => ({ name, description: name + " description", inputSchema: { type: "object", properties: { fail: { type: "boolean" } } } })) } :
    m.params.arguments.fail ? { isError: true, content: [{ type: "text", text: "Mend refused this call" }] } :
    { content: [{ type: "text", text: process.env.MEND_SESSION_ID }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], structuredContent: { tool: m.params.name, input: m.params.arguments, process: process.env.MEND_AGENT_PROCESS_ID } };
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n"), m.id % 2);
});
`,
      { mode: 0o755 },
    );
    const extension = path.join(dir, "extension.mjs");
    await fs.writeFile(extension, piMcpExtensionSource(helper, 2000));
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const tools = new Map(); let shutdown;
      const { default: load } = await import(${JSON.stringify(extension)});
      await load({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { assert.equal(name, "session_shutdown"); shutdown = handler; } });
      try {
        assert.deepEqual([...tools.keys()], ["mcp__mend__screen_look", "mcp__mend__proof_screenshot", "mcp__mend__later_tool"]);
        const [look, proof] = await Promise.all([tools.get("mcp__mend__screen_look").execute("1", { value: 1 }), tools.get("mcp__mend__proof_screenshot").execute("2", { value: 2 })]);
        assert.deepEqual(look.content, [{ type: "text", text: "fixture-session" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
        assert.deepEqual(proof.details.structuredContent, { tool: "proof_screenshot", input: { value: 2 }, process: "fixture-process" });
        await assert.rejects(tools.get("mcp__mend__later_tool").execute("3", { fail: true }), /Mend refused this call/);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(tools.get("mcp__mend__screen_look").execute("4", {}, cancelled.signal), /cancelled/);
        console.log("registered, called, refused, cancelled");
      } finally { shutdown(); }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          MEND_SESSION_ID: "fixture-session",
          MEND_AGENT_PROCESS_ID: "fixture-process",
        },
        timeout: 10_000,
      },
    );
    expect(stdout.trim()).toBe("registered, called, refused, cancelled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("reports a server that cannot start instead of hanging pi's launch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-pi-mcp-"));
  try {
    const extension = path.join(dir, "extension.mjs");
    await fs.writeFile(extension, piMcpExtensionSource(path.join(dir, "missing"), 2000));
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const { default: load } = await import(${JSON.stringify(extension)});
      await assert.rejects(load({ on() {}, registerTool() {} }), /could not start/);
      console.log("start refused");
    `,
      ],
      { timeout: 10_000 },
    );
    expect(stdout.trim()).toBe("start refused");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
