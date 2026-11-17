import { describe, expect, it } from "vitest";

import { projectSkillNameIssue } from "./skills-add-dialog";
import { libraryStanding } from "./skills-tab";

describe("project skills", () => {
  it("says what each library skill does here", () => {
    const local = new Set(["effect-v4"]);
    expect(libraryStanding({ name: "review-pr" }, local, true)).toBe("inherited");
    expect(libraryStanding({ name: "effect-v4" }, local, true)).toBe("overridden here");
    expect(libraryStanding({ name: "review-pr" }, local, false)).toBe("off");
  });

  it("refuses a name the API would, and one the project already has", () => {
    const existing = [{ name: "verify" }];
    expect(projectSkillNameIssue("verify", existing, "mend")).toBe(
      "mend already has a skill named verify",
    );
    expect(projectSkillNameIssue("Bad Name", existing, "mend")).not.toBeNull();
    expect(projectSkillNameIssue("", existing, "mend")).toBe("name is required");
    expect(projectSkillNameIssue("figma-handoff", existing, "mend")).toBeNull();
  });
});
