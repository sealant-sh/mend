import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { NETWORK_GUARD_IMAGE, serverCommand } from "./server-setup.ts";
import { describeUninstall, executeUninstall, planLines } from "./uninstall.ts";

const { cleanups, fixture, seedDaemon, daemonNames, liveWorkspace, uninstallRuntime } =
  lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("server uninstall with live sessions", { timeout: 60_000 }, () => {
  it("everything also removes Mend's images and the sysctl file setup wrote, restoring the default", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({ sysctl: "mend", buildCache: "5.075GB", edgeImage: false });
    const runtime = uninstallRuntime(f);
    const plan = await describeUninstall(runtime, "all");
    expect(plan.server).toMatchObject({
      extras: {
        images: ["postgres:17-alpine", "dxflrs/garage:v2.4.1", "nginx:1.29-alpine", "registry:3.1"],
        imageBytes: 400_000_000,
        buildCache: "5.075GB",
        sysctl: {
          state: "mend",
          restore: { key: "kernel.apparmor_restrict_unprivileged_userns", value: "1" },
        },
      },
    });
    expect(planLines(plan, f.configDir)).toEqual(
      expect.arrayContaining([
        "images   4 images Mend pulled or built, 400 MB: postgres:17-alpine, dxflrs/garage:v2.4.1, nginx:1.29-alpine, registry:3.1",
        "         Docker's build cache, 5.075GB: shared by every build on this daemon, so uninstall asks about it separately",
        "host     /etc/sysctl.d/60-mend-rootless-docker.conf, which setup wrote; kernel.apparmor_restrict_unprivileged_userns goes back to 1",
      ]),
    );
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome).toEqual({ failures: [], leftovers: [], remaining: [] });
    const state = f.state();
    expect(state.sysctl).toBe("absent");
    expect(state.sysctlRestored).toEqual(["kernel/apparmor_restrict_unprivileged_userns", "1"]);
    expect(state.removedImages).toEqual([
      "postgres:17-alpine",
      "dxflrs/garage:v2.4.1",
      "nginx:1.29-alpine",
      "registry:3.1",
    ]);
    // The build cache is the caller's separate question: executeUninstall never prunes it.
    expect(state.prunedBuildCache).toBeUndefined();
    expect(f.lines).toEqual(
      expect.arrayContaining([
        "removed /etc/sysctl.d/60-mend-rootless-docker.conf and set kernel.apparmor_restrict_unprivileged_userns back to 1",
        "removed 4 images (postgres:17-alpine, dxflrs/garage:v2.4.1, nginx:1.29-alpine, registry:3.1)",
      ]),
    );
  });

  it("everything removes the edge's image too, after --no-edge took the edge away", async () => {
    // The overlay no longer names Caddy, and uninstall left its image without a word
    // (RC 0.36.0-next.754, D-F4).
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const runtime = uninstallRuntime(f);
    const plan = await describeUninstall(runtime, "all");
    expect(plan.server).toMatchObject({
      extras: { images: expect.arrayContaining(["caddy:2.10-alpine"]) },
    });
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    expect(f.state().removedImages).toContain("caddy:2.10-alpine");
  });

  it("counts an image Docker refused once and then removed with another as removed, and names one it kept", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.update({
      imagesRefusedOnce: ["postgres:17-alpine"],
      imagesInUse: ["registry:3.1"],
      edgeImage: false,
    });
    const runtime = uninstallRuntime(f);
    const outcome = await executeUninstall(runtime, await describeUninstall(runtime, "all"));
    expect(outcome.failures).toEqual([]);
    expect(f.lines).toContain(
      "removed 3 images (dxflrs/garage:v2.4.1, nginx:1.29-alpine, postgres:17-alpine)",
    );
    expect(outcome.leftovers).toEqual([
      "image registry:3.1: Error response from daemon: conflict: unable to remove registry:3.1. To remove it: docker --context saved-local image rm registry:3.1",
    ]);
    expect(outcome.remaining).toEqual(["1 image"]);
  });

  it("everything finishes in one run with a live session and the Docker mirror on its network, the guard image included (RC 761, Mac)", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    f.update({ sysctl: "mend", edgeImage: false, guardImagePresent: true });
    liveWorkspace(f);
    seedDaemon(f, {
      containers: [["mend-docker-mirror", { "com.docker.compose.project": "mend" }]],
      facts: [["mend-docker-mirror", { networks: ["mend_default", "sealant-w1-network"] }]],
    });
    const runtime = uninstallRuntime(f);
    const plan = await describeUninstall(runtime, "all");
    expect(plan.server).toMatchObject({
      extras: { images: expect.arrayContaining([NETWORK_GUARD_IMAGE]) },
    });
    const outcome = await executeUninstall(runtime, plan);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notReached).toBeUndefined();
    expect(daemonNames(f, "networks")).toEqual([]);
    expect(daemonNames(f, "volumes")).toEqual([]);
    expect(f.state().sysctl).toBe("absent");
    expect(f.state().removedImages).toContain(NETWORK_GUARD_IMAGE);
  });
});
