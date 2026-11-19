import { describe, expect, it } from "vitest";

import { skillSearch } from "./skill-search.ts";

describe("the skill's URL", () => {
  it("opens the editor for ?edit=1 and names the file", () => {
    expect(skillSearch({ edit: 1, file: "notes.md" })).toEqual({ edit: 1, file: "notes.md" });
    expect(skillSearch({ edit: "1" })).toEqual({ edit: 1 });
    expect(skillSearch({ edit: 0 })).toEqual({});
  });
});
