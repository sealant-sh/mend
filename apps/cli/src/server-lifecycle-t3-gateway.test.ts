import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the t3code gateway overlay", { timeout: 120_000 }, () => {
  it("the t3code gateway's overlay runs with every start, and status says what this machine observed at its port", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    let answering = true;
    const gatewayProbes: Array<string> = [];
    const runtime = {
      ...f.runtime,
      fetchText: async (
        url: string,
        timeout: number,
        headers?: Readonly<Record<string, string>>,
      ) => {
        if (url.startsWith("http://127.0.0.1:3120/")) {
          gatewayProbes.push(url);
          return answering
            ? { status: 200, body: '{"environmentId":"e"}' }
            : { status: 0, body: "", error: "connect ECONNREFUSED" };
        }
        return f.runtime.fetchText(url, timeout, headers);
      },
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toEqual({
      _tag: "ok",
    });
    // Setup looked at the port once Mend answered, and said what it saw.
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    expect(
      f.lines.some((line) => line.startsWith("The t3code gateway answered at 127.0.0.1:3120")),
    ).toBe(true);
    gatewayProbes.length = 0;
    expect(f.state().upFiles).toEqual([
      "compose.yaml",
      "compose.posture.yaml",
      "compose.mirrors.yaml",
      "compose.t3.yaml",
    ]);
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles).toEqual([
        "compose.yaml",
        "compose.posture.yaml",
        "compose.mirrors.yaml",
        "compose.t3.yaml",
      ]);
    }
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · on · published on 127.0.0.1:3120 only · reached from this machine",
    );
    expect(f.lines).toContain(
      "t3code gateway · observed answering at 127.0.0.1:3120 from this machine · T3 Code's Remote link takes http://127.0.0.1:3120",
    );
    expect(gatewayProbes).toEqual(["http://127.0.0.1:3120/.well-known/t3/environment"]);
    answering = false;
    f.lines.length = 0;
    expect(await serverCommand(["status"], runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "t3code gateway · not observed at 127.0.0.1:3120 from this machine · mend server logs shows what it said",
    );
    for (const line of f.lines) expect(line).not.toMatch(/\bsafe\b|gate passed/i);
  });

  it("refuses an upgrade that carries the gateway onto an image without it, and keeps the pin (644-1)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ gatewayImages: ["0.23.0"] });
    const runtime = {
      ...f.runtime,
      fetchText: async (url: string, timeout: number, headers?: Readonly<Record<string, string>>) =>
        url.startsWith("http://127.0.0.1:3120/")
          ? { status: 200, body: '{"environmentId":"e"}' }
          : f.runtime.fetchText(url, timeout, headers),
    };
    expect(await serverCommand(["setup", "--offline", "--t3-gateway"], runtime)).toMatchObject({
      _tag: "ok",
    });
    const old = f.active();
    // 0.24.0's image has no gateway: the carried setting is refused before anything stops.
    expect(await f.upgrade()).toMatchObject({
      _tag: "error",
      message: expect.stringContaining("Mend 0.24.0 has no t3code gateway"),
    });
    expect(f.active()).toBe(old);
    expect(f.state().appRunning).toBe(true);
    expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    // An image that carries it upgrades as before.
    f.update({ gatewayImages: ["0.23.0", "0.24.0"] });
    expect(await f.upgrade()).toMatchObject({ _tag: "ok" });
  });
});
