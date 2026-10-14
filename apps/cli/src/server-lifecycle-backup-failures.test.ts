import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VOLUME_OWNER_LABEL } from "./server-docker-volumes.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture, versions, withVersions } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  describe("upgrade backups", () => {
    it.each(["backup", "target-start"])(
      "prunes nothing when the upgrade fails at %s, and keeps that backup on the next healthy one",
      async (failure) => {
        const f = await withVersions();
        for (const version of versions.slice(0, 2))
          expect(await f.upgradeKeeping(version, "0")).toEqual({ _tag: "ok" });
        const healthy = f.backups();
        f.update({ fail: failure });
        expect((await f.upgradeKeeping(versions[2], "1"))._tag).toBe("error");
        const failed = f.backups().filter((name) => !healthy.includes(name));
        expect(failed).toHaveLength(1);
        expect(f.backups()).toHaveLength(3);
        expect(f.lines.some((line) => line.startsWith("Removed upgrade backup "))).toBe(false);
        f.update({ fail: "" });
        // After a failed target start the target pin stays; start it, then upgrade past it.
        if (failure === "target-start")
          expect(await serverCommand(["start", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
        expect(await f.upgradeKeeping(versions[3], "1")).toEqual({ _tag: "ok" });
        // The healthy ones went; the failed upgrade's record says pending or unfinished, and stays.
        expect(f.backups()).toHaveLength(2);
        expect(f.backups()).toContain(failed[0]);
        expect(f.lines).toContain(
          `Kept upgrade backup ${path.join(f.configDir, "backups", failed[0] ?? "")} · ${
            failure === "backup"
              ? "unfinished: no complete database dump"
              : "pending: its upgrade never recorded a healthy target"
          }`,
        );
      },
    );
  });

  it("an upgrade from a generation without Garage claims mend-garage under the unchanged identity and lays the bucket out", async () => {
    const f = await fixture();
    const composeWithGarage = fs.readFileSync(path.join(f.assets, "compose.v2.yaml"), "utf8");
    fs.copyFileSync(
      new URL("../test-fixtures/docker/compose.v2.before-garage.yaml", import.meta.url),
      path.join(f.assets, "compose.v2.yaml"),
    );
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(JSON.parse(before["server.json"] ?? "{}")).not.toHaveProperty("bucket");
    expect([...f.volumes().keys()]).toEqual(["mend-store", "mend-control"]);
    expect(f.calls().some((call) => call.command.includes("garage"))).toBe(false);
    // Lifecycle commands verify the two volumes the generation owns; none asks for the bucket.
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    fs.writeFileSync(path.join(f.assets, "compose.v2.yaml"), composeWithGarage);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const after = f.files();
    expect(after["identity.env"]).toBe(before["identity.env"]);
    expect(JSON.parse(after["server.json"] ?? "{}")).toMatchObject({
      serverVersion: "0.24.0",
      bucket: "garage",
    });
    const owner = createHash("sha256")
      .update(before["identity.env"] ?? "")
      .digest("hex");
    expect([...f.volumes()]).toEqual([
      ["mend-store", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
      ["mend-control", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
      ["mend-garage", { [SERVER_VOLUME_OWNER_LABEL]: owner }],
    ]);
    const calls = f.calls();
    const claim = f.runCalls.findIndex(
      (call) =>
        call.args[2] === "volume" &&
        call.args[3] === "create" &&
        call.args.at(-1) === "mend-garage",
    );
    const stop = f.runCalls.findIndex((call) => call.args.includes("stop"));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(stop);
    const garageInit = calls
      .filter((call) => call.command[0] === "exec" && call.command.includes("garage"))
      .map((call) =>
        call.command
          .slice(
            call.command.indexOf("/etc/garage.toml") + 1,
            call.command.indexOf("/etc/garage.toml") + 3,
          )
          .join(" "),
      );
    expect(garageInit).toEqual([
      "status",
      "layout assign",
      "layout apply",
      "bucket create",
      "key import",
      "bucket allow",
      "bucket info",
    ]);
    expect(f.lines).toContain("Capture store bucket mend is laid out in Garage");
    // The upgraded generation verifies all three; a rerun claims nothing again.
    const mutations = f.runCalls.filter((call) => call.args[3] === "create").length;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.runCalls.filter((call) => call.args[3] === "create")).toHaveLength(mutations);
  });
});
