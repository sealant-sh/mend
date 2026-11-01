import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { mergeArchivedVolumes, ResourceArchive } from "./resource-removal.ts";
import { resourceStatusLine } from "./resource-status.ts";
import { presetDefinition, PresetVersion, ResourceName } from "./resource.ts";

const volume = fc.record({
  instanceKey: fc.string(),
  resourceName: fc.string(),
  name: fc.string(),
  dockerName: fc.string(),
  bytes: fc.option(fc.nat(), { nil: null }),
});

describe("a resource archive", () => {
  it("never loses a volume when a repeated archive returns no volumes", () => {
    fc.assert(
      fc.property(fc.array(volume), (held) => {
        const first = mergeArchivedVolumes([], held);
        expect(mergeArchivedVolumes(first, [])).toEqual(first);
        expect(mergeArchivedVolumes(first, held)).toEqual(first);
      }),
    );
  });
  it("keeps a known size when a retry could not measure it", () => {
    const held = {
      instanceKey: "db",
      resourceName: "db",
      name: "data",
      dockerName: "db-data",
      bytes: 8192,
    };
    expect(mergeArchivedVolumes([held], [{ ...held, bytes: null }])).toEqual([held]);
  });
  it("decodes archive dates across the API boundary", () => {
    const value = Schema.decodeUnknownSync(ResourceArchive)({
      projectId: "p-old",
      organizationId: "org-a",
      projectName: "old",
      createdByUserId: null,
      archivedAt: "2026-10-31T14:02:00Z",
      volumes: [],
    });
    expect(value.archivedAt).toEqual(new Date("2026-10-31T14:02:00Z"));
  });
  it("names the dump time and why a stopped server was started", () => {
    const at = new Date("2026-10-31T14:02:00Z");
    const definition = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("17"),
      scope: "project",
    });
    expect(
      resourceStatusLine(
        { kind: "own-removed", definition, savedAt: at, startedForRemoval: true },
        { now: at, timeZone: "UTC" },
      ),
    ).toBe("@db · its own database saved as a dump 14:02 and dropped · removal started its server");
  });
});
