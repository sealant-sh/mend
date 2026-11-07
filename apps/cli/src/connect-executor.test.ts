import { describe, expect, it } from "vitest";

import { connectExecutor } from "./connect-executor.ts";
describe("mend connect executor", () => {
  it("opens browser consent and leaves every grant at the server", async () => {
    const requests: unknown[] = [];
    const opened: string[] = [];
    const lines: string[] = [];
    await connectExecutor([], {
      request: async (method, path, body) => {
        requests.push({ method, path, body });
        return { url: "https://executor.example.invalid/authorize" };
      },
      open: (url) => opened.push(url),
      say: (line) => lines.push(line),
    });
    expect(requests).toEqual([
      { method: "POST", path: "/me/executor/link", body: { target: "person" } },
    ]);
    expect(opened).toEqual(["https://executor.example.invalid/authorize"]);
    expect(lines.join()).toContain("Consent at your organization's Executor");
  });
  it("unlinks Mend's member only through the owner's API path", async () => {
    const requests: unknown[] = [];
    await connectExecutor(["--member", "--remove"], {
      request: async (method, path) => {
        requests.push({ method, path });
      },
      open: () => {
        throw new Error("must not open");
      },
      say: () => undefined,
    });
    expect(requests).toEqual([{ method: "DELETE", path: "/me/executor/link/member" }]);
  });
});
