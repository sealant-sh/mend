import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ENDPOINTS, GATEWAY } from "./server-lifecycle-boat-test-fixtures.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OVERLAY = "compose.boat-images.yaml";
const ON_LINE =
  "boat images · once an hour the worker removes each one no session can start from and nothing used in the last day · sealant's default, not set on this install";
const OFF_LINE =
  "boat images · the worker removes none, whatever no session can start from · set on this install (--no-boat-image-retention)";
const BOAT = ["setup", "--offline", "--session-runtimes", "docker,boat", ...ENDPOINTS];

const boatFixture = async () => {
  const f = await fixture();
  f.update({ boatGatewayImage: GATEWAY });
  expect(await f.setup()).toEqual({ _tag: "ok" });
  return f;
};

describe("Boat image retention", { timeout: 120_000 }, () => {
  it("is sealant's default once Boat is set up, and writes nothing for it", async () => {
    const f = await boatFixture();
    expect(await serverCommand(BOAT, f.runtime)).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files[OVERLAY]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}").boat).not.toHaveProperty("imageRetention");
    expect(files["compose.boat.yaml"]).not.toContain("IMAGE_GC");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(ON_LINE);
  });

  it("off reaches the mend container from the config, survives a rerun and an upgrade, and turns back on", async () => {
    const f = await boatFixture();
    f.lines.length = 0;
    // As a check VM copy sets Boat up: in the same run as the rest of Boat.
    expect(await serverCommand([...BOAT, "--no-boat-image-retention"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines).toContain(OFF_LINE);
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").boat).toMatchObject({ imageRetention: false });
    expect(files[OVERLAY]).toContain(
      '  mend:\n    environment:\n      SEALANT_BOAT_IMAGE_GC_ENABLED: "false"\n',
    );
    // server.env and compose.boat.yaml are what they were without it: a CLI from before the
    // setting still reads the install, and drops the setting when it writes one.
    expect(files["server.env"]).not.toContain("IMAGE_GC");
    expect(files["compose.boat.yaml"]).not.toContain("IMAGE_GC");
    expect(f.state().upFiles).toContain(OVERLAY);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(OFF_LINE);

    // A rerun that does not name it keeps it, and says nothing about it.
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--yes"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines.some((line) => line.startsWith("boat images"))).toBe(false);
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);

    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);
    expect(f.state().upFiles).toContain(OVERLAY);

    f.lines.length = 0;
    expect(
      await serverCommand(["setup", "--offline", "--boat-image-retention"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(ON_LINE);
    expect(f.files()[OVERLAY]).toBeUndefined();
    expect(JSON.parse(f.files()["server.json"] ?? "{}").boat).not.toHaveProperty("imageRetention");
    expect(f.state().upFiles).not.toContain(OVERLAY);
  });

  it("goes with Boat, and contradicts --no-boat and itself", async () => {
    const f = await boatFixture();
    expect(await serverCommand([...BOAT, "--no-boat-image-retention"], f.runtime)).toEqual({
      _tag: "ok",
    });
    for (const [flags, refusal] of [
      [["--no-boat", "--no-boat-image-retention"], "--no-boat contradicts the other --boat flags."],
      [
        ["--boat-image-retention", "--no-boat-image-retention"],
        "--boat-image-retention and --no-boat-image-retention contradict each other.",
      ],
    ] as const) {
      const result = await serverCommand(["setup", "--offline", ...flags], f.runtime);
      expect(result._tag === "error" ? result.message : result._tag).toBe(refusal);
    }
    expect(await serverCommand(["setup", "--offline", "--no-boat"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.files()[OVERLAY]).toBeUndefined();
    expect(f.state().upFiles).not.toContain(OVERLAY);
  });

  it("refuses a generation whose overlay does not match its config", async () => {
    const f = await boatFixture();
    expect(await serverCommand([...BOAT, "--no-boat-image-retention"], f.runtime)).toEqual({
      _tag: "ok",
    });
    const overlay = path.join(f.active(), OVERLAY);
    fs.writeFileSync(overlay, fs.readFileSync(overlay, "utf8").replace('"false"', '"true"'));
    const result = await serverCommand(["status"], f.runtime);
    expect(result._tag === "error" ? result.message : result._tag).toContain(
      `${OVERLAY} does not match the saved Boat image retention`,
    );
  });
});
