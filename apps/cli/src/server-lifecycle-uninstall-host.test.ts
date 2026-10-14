import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { NETWORK_GUARD_IMAGE, serverCommand } from "./server-setup.ts";
import { describeUninstall, executeUninstall, settleBuildCache } from "./uninstall.ts";

const { cleanups, fixture, seedDaemon, liveWorkspace, uninstallRuntime } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it("a stopped everything says what it did not reach, and a re-run still offers the guard image the Mend image named", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    f.update({ sysctl: "mend", edgeImage: false, guardImagePresent: true });
    liveWorkspace(f);
    seedDaemon(f, {
      containers: [["someone-else", {}]],
      facts: [["someone-else", { networks: ["sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const first = await executeUninstall(runtime, await describeUninstall(runtime, "all"));
    expect(first.failures).toHaveLength(2);
    expect(first.notReached).toEqual([
      expect.stringMatching(/^5 images \(postgres:17-alpine, /),
      "/etc/sysctl.d/60-mend-rootless-docker.conf",
    ]);
    expect(f.state().removedImages ?? []).not.toContain(NETWORK_GUARD_IMAGE);

    const file = path.join(f.root, "docker-protocol.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.facts = saved.facts.filter(([name]: [string]) => name !== "someone-else");
    fs.writeFileSync(file, JSON.stringify(saved));
    // The Mend image went with the first run: no label left to name the guard by.
    const again = await describeUninstall(runtime, "all");
    expect(again.server).toMatchObject({
      extras: { images: expect.arrayContaining([NETWORK_GUARD_IMAGE]) },
    });
    const outcome = await executeUninstall(runtime, again);
    expect(outcome.failures).toEqual([]);
    expect(f.state().removedImages).toContain(NETWORK_GUARD_IMAGE);
    expect(f.state().sysctl).toBe("absent");
  });

  it("carries out a yes to the build cache once the server is gone, and says 'not reached' when it stopped first", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ buildCache: "5.075GB" });
    const runtime = uninstallRuntime(f);
    const clean = { failures: [], leftovers: [], remaining: [] };
    expect(await settleBuildCache(runtime, "saved-local", "5.075GB", false, clean)).toEqual({
      kind: "kept",
      line: "Docker's build cache, 5.075GB: docker --context saved-local builder prune --all removes it",
    });
    expect(
      await settleBuildCache(runtime, "saved-local", "5.075GB", true, {
        ...clean,
        failures: ["the uninstall is not finished: …"],
      }),
    ).toEqual({
      kind: "not reached",
      line: "Docker's build cache, 5.075GB: the uninstall stopped before it; run mend uninstall again, or docker --context saved-local builder prune --all removes it",
    });
    expect(f.state().prunedBuildCache).toBeUndefined();
    expect(await settleBuildCache(runtime, "saved-local", "5.075GB", true, clean)).toEqual({
      kind: "removed",
      line: "removed Docker's build cache (5.075GB)",
    });
    expect(f.state().prunedBuildCache).toBe(true);
  });

  it("leaves a sysctl file written by hand, naming the command that removes it", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ sysctl: "by-hand" });
    const runtime = uninstallRuntime(f);
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "all"));
    expect(outcome.failures).toEqual([]);
    expect(outcome.leftovers).toEqual([
      "/etc/sysctl.d/60-mend-rootless-docker.conf: setup did not write it, so it stays. To restore the kernel's default: sudo rm /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1",
    ]);
    expect(outcome.remaining).toEqual(["/etc/sysctl.d/60-mend-rootless-docker.conf"]);
  });
});
