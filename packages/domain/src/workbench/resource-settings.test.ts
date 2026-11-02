import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  resourceListEntries,
  ResourcesPage,
  type ResourceSettingEntry,
} from "./resource-settings.ts";
import { presetDefinition, PresetVersion, ResourceName, resourceSpecDigest } from "./resource.ts";

const instance = (
  name: string,
  level: "project" | "worktree" = "project",
): ResourceSettingEntry => {
  const spec = presetDefinition({
    name: ResourceName.make(name),
    preset: "redis",
    version: PresetVersion.make("8"),
  });
  return {
    id: ResourceDefinitionId.make(name),
    spec,
    digest: resourceSpecDigest(spec),
    image: spec.image,
    addedBy: "alice",
    level,
    worktreeId: level === "project" ? null : WorktreeId.make("wt"),
    choice: "project",
    canRemove: true,
    canChoose: true,
    canLoadOwn: false,
    instance: "running",
    statusLine: `@${name} · running · ${level} · observed 3 s ago`,
  };
};
const pageOf = (
  defined: ReadonlyArray<string>,
  instances: ReadonlyArray<ResourceSettingEntry>,
): ResourcesPage => ({
  settings: instances,
  file: {
    kind: "read",
    worktreeId: null,
    observed: "default branch",
    refused: [],
    ignored: [],
    tables: defined.map((name) => {
      const { spec, digest } = instance(name);
      return { spec, digest, statusLine: `@${name} · redis:8 · in .mend/mend.toml · not started` };
    }),
  },
});

describe("resource names in a list", () => {
  it("keeps each level's observations under its definition, and retains instances whose table was removed", () => {
    const project = instance("cache");
    const own = instance("cache", "worktree");
    const removed = instance("mail");
    const entries = resourceListEntries(pageOf(["cache", "unused"], [project, own, removed]));
    expect(entries.map((entry) => entry.name)).toEqual(["cache", "unused", "mail"]);
    expect(entries[0]).toMatchObject({
      statusLine: "@cache · redis:8 · in .mend/mend.toml",
      instances: [project, own],
    });
    expect(entries[1]?.statusLine).toContain("not started");
    expect(entries[2]).toMatchObject({ definition: null, instances: [removed] });
  });
  it("groups every name once and preserves every instance for arbitrary definition and instance order", () => {
    const names = fc.uniqueArray(fc.constantFrom("db", "cache", "mail"));
    fc.assert(
      fc.property(
        names,
        fc.array(
          fc.tuple(fc.constantFrom("db", "cache", "mail"), fc.constantFrom("project", "worktree")),
        ),
        (defined, running) => {
          const page = Schema.decodeUnknownSync(ResourcesPage)(
            pageOf(
              defined,
              running.map(([name, level]) => instance(name, level)),
            ),
          );
          const entries = resourceListEntries(page);
          expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);
          expect(entries.flatMap((entry) => entry.instances)).toHaveLength(running.length);
          for (const entry of entries) {
            expect(entry.instances).toEqual(
              page.settings.filter((row) => row.spec.name === entry.name),
            );
            if (entry.instances.length > 0) expect(entry.statusLine).not.toContain("not started");
          }
        },
      ),
    );
  });
});
