import {
  ProjectEnvironmentDuplicateNameError,
  ProjectEnvironmentInvalidInputError,
  ProjectEnvironmentLimitError,
} from "@mend/db";
import { describe, expect, it } from "vitest";

import { rejectEnvironment } from "../src/routes/workbench.ts";

describe("rejectEnvironment", () => {
  it("passes validation issues through with field, rule, and wording", () => {
    const rejected = rejectEnvironment(
      new ProjectEnvironmentInvalidInputError({
        issues: [
          { field: "name", rule: "name-reserved", message: "This name is owned by the platform." },
          { field: "value", rule: "value-size", message: "Too big." },
        ],
      }),
    );
    expect(rejected.issues).toEqual([
      { field: "name", rule: "name-reserved", message: "This name is owned by the platform." },
      { field: "value", rule: "value-size", message: "Too big." },
    ]);
  });

  it("renders a duplicate as a name-field issue naming only the NAME", () => {
    const rejected = rejectEnvironment(
      new ProjectEnvironmentDuplicateNameError({ name: "APP_MODE" }),
    );
    expect(rejected.issues).toEqual([
      {
        field: "name",
        rule: "duplicate-name",
        message: "A variable named APP_MODE already exists on this project.",
      },
    ]);
  });

  it("renders limits as aggregate issues with no field", () => {
    const entries = rejectEnvironment(
      new ProjectEnvironmentLimitError({ kind: "entries", limit: 128 }),
    );
    expect(entries.issues[0]).toMatchObject({ field: null, rule: "entry-count" });
    const bytes = rejectEnvironment(
      new ProjectEnvironmentLimitError({ kind: "bytes", limit: 32768 }),
    );
    expect(bytes.issues[0]).toMatchObject({ field: null, rule: "total-size" });
    expect(bytes.issues[0]?.message).toContain("32768");
  });
});
