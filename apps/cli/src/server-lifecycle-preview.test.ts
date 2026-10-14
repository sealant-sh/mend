import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { isPreviewToNext, serverCommand } from "./server-setup.ts";

const { cleanups, fixture, preview, next, onPreview, everything } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  describe("from a preview numbered before the next channel", () => {
    it("refuses the move as a downgrade and names the one-time way", async () => {
      const f = await onPreview(everything);
      expect(await f.upgrade(next)).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(`mend server upgrade --version ${next} --from-preview`),
      });
      expect(f.state().version).toBe(preview);
    });

    it("moves once with --from-preview when the target carries every applied migration", async () => {
      const f = await onPreview(everything);
      const old = f.active();
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toEqual({ _tag: "ok" });
      expect(f.state().version).toBe(next);
      expect(f.active()).not.toBe(old);
      expect(f.lines).toContain(
        `ghcr.io/sealant-sh/mend:${next} carries all 4 migrations this server applied.`,
      );
      // Read before anything stops.
      const calls = f.calls();
      const stop = calls.findIndex((call) => call.command[0] === "stop");
      const reads = calls.filter(
        (call) => call.command.includes("psql") || call.args.includes("/app/migrations.txt"),
      );
      expect(reads).toHaveLength(3);
      expect(calls.findIndex((call) => call.command.includes("psql"))).toBeLessThan(stop);
      // After the move, ordinary upgrades follow the next channel.
      expect(await f.upgrade("0.36.0-next.61")).toEqual({ _tag: "ok" });
    });

    it("refuses, naming them, when the target lacks a migration the server applied", async () => {
      const f = await onPreview({
        mend: ["1|init", "107|turn_payer", "108|opencode_models"],
        sealant_control_plane: [
          ...everything.sealant_control_plane,
          `20261004000000_unmerged|1|${"c".repeat(64)}`,
        ],
      });
      const old = f.active();
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining(
          "cannot take this server's databases (2): mend 0108_opencode_models is applied here and not in the target; sealant 20261004000000_unmerged is applied here and not in the target",
        ),
      });
      expect(f.active()).toBe(old);
      expect(f.state().version).toBe(preview);
      expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    });

    it("recovers the preview's own image when the backup fails", async () => {
      const f = await onPreview(everything);
      const old = f.active();
      f.update({ fail: "backup" });
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({ _tag: "error", message: expect.stringContaining("app recovered") });
      expect(f.active()).toBe(old);
      expect(f.state()).toMatchObject({ version: preview, appRunning: true });
    });

    it("refuses a target that does not list its migrations", async () => {
      const f = await onPreview(everything);
      f.update({ manifests: {} });
      expect(
        await serverCommand(
          ["upgrade", "--version", next, "--from-preview", "--assets-dir", f.assets, "--offline"],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("does not list its migrations"),
      });
      expect(f.state().version).toBe(preview);
    });

    it("refuses --from-preview for anything but X.Y.Z-preview.K to X.Y.Z-next.N", async () => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      expect(
        await serverCommand(
          [
            "upgrade",
            "--version",
            "0.24.0",
            "--from-preview",
            "--assets-dir",
            f.assets,
            "--offline",
          ],
          f.runtime,
        ),
      ).toMatchObject({
        _tag: "error",
        message: expect.stringContaining("--from-preview moves a server"),
      });
      expect(isPreviewToNext("0.36.0-preview.17", "0.36.0-next.1")).toBe(true);
      // A new-style preview is a way off the old numbering too.
      expect(isPreviewToNext("0.36.0-preview.17", "0.36.0-next.584.preview.40")).toBe(true);
      expect(isPreviewToNext("0.36.0-preview.17", "0.37.0-next.1")).toBe(false);
      expect(isPreviewToNext("0.36.0-next.5.preview.17", "0.36.0-next.6")).toBe(false);
      expect(isPreviewToNext("0.36.0", "0.36.0-next.1")).toBe(false);
    });
  });
});
