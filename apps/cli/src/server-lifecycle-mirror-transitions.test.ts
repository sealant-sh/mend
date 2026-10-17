import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, withoutMirrors } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the mirrors", { timeout: 120_000 }, () => {
  it("runs both on a new install, and status reports each as observed", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").mirrors).toEqual({
      npm: { maxSize: "10g" },
      docker: { maxSize: "20g" },
    });
    expect(files["compose.mirrors.yaml"]).toContain("\n  npm-mirror:\n");
    expect(files["compose.mirrors.yaml"]).toContain("\n  docker-mirror:\n");
    expect(files["npm-mirror.conf"]).toContain("proxy_cache npm;");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    // Both images are checked beside the bundle's.
    expect(f.runCalls.some((call) => call.args.includes("nginx:1.29-alpine"))).toBe(true);
    expect(f.runCalls.some((call) => call.args.includes("registry:3.1"))).toBe(true);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "npm mirror · running · 2.0 MiB cached of 10 GiB · 1.0 GiB free on its disk · last 24 h: 2 tarball requests · 1 served from the cache (50%) · 1 fetched from registry.npmjs.org · observed",
    );
    expect(f.lines).toContain(
      "docker mirror · running · 2.0 MiB cached of 20 GiB · 1.0 GiB free on its disk · layers evicted 7 days after each fetch · since 2026-10-10T08:00:00Z: layers 4 requested · 3 from the cache (75%) · manifests 4 · 2 from the cache · pulls from Docker Hub anonymously · observed",
    );
  });

  it("an upgrade adds them to an install from before them, and says so", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    withoutMirrors(f.active());
    f.update({ mirrorContainers: {} });
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").mirrors).toEqual({
      npm: { maxSize: "10g" },
      docker: { maxSize: "20g" },
    });
    expect(f.files()["server.env"]).toContain("MEND_NPM_MIRROR_MAX_SIZE=10g\n");
    expect(f.state().upFiles).toEqual(["compose.yaml", "compose.mirrors.yaml"]);
    expect(f.lines).toContain(
      "The npm mirror runs on this install. New sessions install npm packages through it, capped at 10g.",
    );
    expect(f.lines).toContain(
      "The Docker mirror runs on this install. New sessions' Docker daemons pull Docker Hub images through it (mend-docker-mirror).",
    );
  });

  it("turned off, a mirror leaves the generation, its container is removed by label, and its cache stays", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--no-npm-mirror"], f.runtime)).toEqual({
      _tag: "ok",
    });
    const files = f.files();
    expect(files["npm-mirror.conf"]).toBeUndefined();
    expect(files["compose.mirrors.yaml"]).not.toContain("npm-mirror");
    expect(files["server.env"]).not.toContain("MEND_NPM_MIRROR_MAX_SIZE");
    expect(f.state().mirrorContainers).toEqual({ "docker-mirror": expect.any(String) });
    expect(f.lines).toContain(
      "Removed the npm mirror container mend-npm-mirror-1, which this generation does not run.",
    );
    expect(f.lines).toContain(
      "The npm mirror is off. Its cache stays until you remove it: docker --context saved-local volume rm mend_mend-npm-mirror",
    );
    // Kept off across a rerun and an upgrade.
    expect(await serverCommand(["setup", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").mirrors).toEqual({
      npm: null,
      docker: { maxSize: "20g" },
    });
    // Both off: no overlay at all, and the generation reads as one from before the mirrors.
    expect(await serverCommand(["setup", "--offline", "--no-docker-mirror"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.files()["compose.mirrors.yaml"]).toBeUndefined();
    expect(f.state().upFiles).toEqual(["compose.yaml"]);
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "npm mirror · off on this install · mend server setup --npm-mirror turns it on",
    );
    // On again, with a cap of its own.
    expect(
      await serverCommand(
        ["setup", "--offline", "--npm-mirror", "--npm-mirror-max-size", "25G"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_NPM_MIRROR_MAX_SIZE=25g\n");
  });
});
