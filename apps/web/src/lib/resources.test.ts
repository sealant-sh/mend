import { presetDefinition, PresetVersion, ResourceName } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { choiceInUse, choiceWords } from "./resources.ts";
const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
});
const cache = presetDefinition({
  name: ResourceName.make("cache"),
  preset: "redis",
  version: PresetVersion.make("8"),
});
describe("resource choices", () => {
  it("uses database words for Postgres and level words for other images", () => {
    expect(
      ["project", "worktree", "off"].map((mode) =>
        mode === "project" || mode === "worktree" || mode === "off"
          ? choiceWords(db, mode).label
          : "",
      ),
    ).toEqual(["shared database", "own database", "off"]);
    expect(choiceWords(cache, "project").label).toBe("project");
    expect(choiceWords(cache, "worktree").label).toBe("worktree");
  });
  it("shows the effective choice supplied by the server", () => {
    expect(choiceInUse({ spec: db, choice: "off" })).toEqual({ choice: "off", stored: true });
    expect(choiceInUse({ spec: cache, choice: "worktree" })).toEqual({
      choice: "worktree",
      stored: true,
    });
  });
});
