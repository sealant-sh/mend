import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverProcessDeadlines } from "./server-runtime.ts";
import { serverCommand, type ServerSetupRuntime } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("server lifecycle", { timeout: 30_000 }, () => {
  it("resolves latest only on explicit online upgrade", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ images: { "0.23.0": "0.23.0" } });
    const requests: Array<string> = [];
    const runtime: ServerSetupRuntime = {
      ...f.runtime,
      fetchText: async (url, timeout) => {
        requests.push(url);
        if (url === "https://api.github.com/repos/sealant-sh/Mend/releases/latest") {
          return { status: 200, body: '{"tag_name":"v0.24.0"}' };
        }
        return f.runtime.fetchText(url, timeout);
      },
    };
    expect(
      await serverCommand(["upgrade", "--version", "latest", "--assets-dir", f.assets], runtime),
    ).toEqual({ _tag: "ok" });
    expect(requests.filter((url) => !url.endsWith("/api/health"))).toEqual([
      "https://api.github.com/repos/sealant-sh/Mend/releases/latest",
    ]);
    expect(f.state().version).toBe("0.24.0");
    // The pull shows Docker's own progress on the terminal instead of a captured, silent wait.
    expect(f.runCalls.find((call) => call.args[2] === "pull")?.options).toEqual({
      timeoutMs: serverProcessDeadlines.pull,
      stdout: "inherit",
    });
    expect(f.lines).toContain("Pulling ghcr.io/sealant-sh/mend:0.24.0");
  });
});
