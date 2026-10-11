import { spawn, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const binaryExists = (command: string): boolean => {
  const error = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  }).error;
  if (error === undefined || !("code" in error)) return true;
  const code: unknown = error["code"];
  return code !== "ENOENT";
};

const hasCodex = binaryExists("codex");
const hasClaude = binaryExists("claude");

describe.skipIf(!hasCodex)("codex app-server conformance", () => {
  it("accepts initialization and ask-mode thread settings", async () => {
    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const threadResponse = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error("codex thread/start timed out")), 10_000);
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message: unknown = JSON.parse(line);
            if (
              typeof message === "object" &&
              message !== null &&
              "id" in message &&
              message.id === 1
            ) {
              clearTimeout(timeout);
              resolve(message);
              return;
            }
          } catch {
            // A changed binary should fail by timeout or by returning a JSON-RPC error.
          }
        }
      });
    });
    child.stdin.write(
      '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"mend","version":"0.0.0"}}}\n',
    );
    child.stdin.write('{"method":"initialized"}\n');
    child.stdin.write(
      '{"method":"thread/start","id":1,"params":{"cwd":"/tmp","approvalPolicy":"on-request","sandbox":"danger-full-access","ephemeral":true}}\n',
    );
    const response = await threadResponse;
    child.stdin.end();
    expect(response).toHaveProperty("result");
    expect(response).not.toHaveProperty("error");
  });
});

describe.skipIf(!hasClaude)("claude stream-json conformance", () => {
  it("accepts the pinned protocol launch flags with an empty input stream", () => {
    const result = spawnSync(
      "claude",
      [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--session-id",
        "11111111-1111-4111-8111-111111111111",
        "--permission-mode",
        "bypassPermissions",
      ],
      { input: "", encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
