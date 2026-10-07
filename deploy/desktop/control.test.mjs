import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { parseAction } from "./control.mjs";

test("rejects invalid coordinates, shell input and non-web URLs", () => {
  for (const action of [
    { name: "click", x: -1, y: 10 },
    { name: "click", x: 1440, y: 1 },
    { name: "click", x: "$(id)", y: 1 },
    { name: "key", keys: "Return;id" },
    { name: "open_browser", url: "file:///etc/passwd" },
    { name: "execute", code: "" },
  ])
    assert.throws(() => parseAction(action));
  assert.equal(parseAction({ name: "type", text: "$(id); hello" }).text, "$(id); hello");
});

test("MCP exposes only the selected execution style over its real stdio entrypoint", async () => {
  for (const mode of ["actions", "code"]) {
    const child = spawn(process.execPath, [new URL("./mcp.mjs", import.meta.url).pathname], {
      env: { ...process.env, MEND_DESKTOP_MODE: mode },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
        "\n",
    );
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages[0].result.protocolVersion, "2024-11-05");
    const names = messages[1].result.tools.map((tool) => tool.name);
    assert.deepEqual(
      names,
      mode === "code"
        ? ["screenshot", "execute"]
        : ["screenshot", "click", "type", "key", "scroll", "open_browser"],
    );
  }
});
