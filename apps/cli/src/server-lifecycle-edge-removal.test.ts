import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, host } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it("--no-edge takes the edge away, removes its container by label and returns to the localhost origin", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    expect(f.state().edgeRunning).toBe(true);
    // Without --url the origin would return to http://localhost; the fixture's health answers on
    // 127.0.0.1, so the loopback origin is stated.
    expect(
      await serverCommand(["setup", "--no-edge", "--url", `http://127.0.0.1:${f.port}`], f.runtime),
    ).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files["compose.edge.yaml"]).toBeUndefined();
    expect(files["Caddyfile"]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}")).not.toHaveProperty("edgeHost");
    expect(files["server.env"]).toContain(`APP_URL=http://127.0.0.1:${f.port}\n`);
    expect(files["server.env"]).not.toContain("MEND_EDGE_HOST");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    // The edge's container went by its labels, before the edge-less `up`; nothing else was removed.
    const removal = f.runCalls.findIndex(
      (call) => call.args[2] === "container" && call.args[3] === "rm",
    );
    expect(f.runCalls[removal]?.args.slice(2)).toEqual([
      "container",
      "rm",
      "--force",
      "mend-edge-1",
    ]);
    expect(removal).toBeLessThan(
      f.runCalls.findIndex((call, index) => index > removal && call.args.includes("up")),
    );
    expect(f.state().edgeRunning).toBe(false);
    expect(f.state().removedEdge).toBe(1);
    expect(f.lines).toContain(
      "Removed the edge container mend-edge-1, which this generation does not run.",
    );
    expect(
      f.lines.some((line) =>
        line.startsWith(`The edge for ${host} is gone. Its certificate volumes stay`),
      ),
    ).toBe(true);
    // Without a stray edge, a start lists and removes nothing; nothing ever passes --remove-orphans.
    expect(await serverCommand(["setup", "--yes"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    expect(f.runCalls.some((call) => call.args.includes("--remove-orphans"))).toBe(false);
  });

  it("an edge of another compose directory stays, and a refused listing never keeps Mend down", async () => {
    const f = await fixture();
    expect(await f.setupEdge(host)).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--no-edge", "--url", `http://127.0.0.1:${f.port}`], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    // A project of the same name run by hand from another directory has an edge of its own.
    f.update({ edgeRunning: true, edgeDirectory: "/opt/other-mend" });
    f.lines.length = 0;
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().removedEdge).toBe(1);
    expect(f.state().edgeRunning).toBe(true);
    expect(f.lines).toContain(
      "Edge container mend-edge-1 was started from /opt/other-mend, not from this installation's generations. It stays.",
    );
    expect(f.runCalls.some((call) => call.args[2] === "container" && call.args[3] === "rm")).toBe(
      true,
    );
    // The daemon refuses the listing: Mend restarts all the same, and the line says what was not done.
    f.update({ fail: "container-ls" });
    f.lines.length = 0;
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.state().appRunning).toBe(true);
    expect(
      f.lines.some((line) => line.startsWith("Could not list this project's containers:")),
    ).toBe(true);
    expect(f.lines.some((line) => line.includes("stays until the next start"))).toBe(true);
  });
});
