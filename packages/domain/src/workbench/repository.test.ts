import { describe, expect, it } from "vitest";

import {
  isRepositoryName,
  nestedRepositoryPath,
  repositoryPath,
  repositorySavedWords,
} from "./repository.ts";

describe("repositories in a session (docs/adr/0010)", () => {
  it("names a directory under /workspace/repos, and the nested place its files live today", () => {
    expect(repositoryPath("core")).toBe("/workspace/repos/core");
    expect(nestedRepositoryPath("core")).toBe("/workspace/repo/.mend/repos/core");
  });

  it("accepts store-shaped names and refuses anything that is not a plain directory name", () => {
    expect(isRepositoryName("core")).toBe(true);
    expect(isRepositoryName("sealantd-2.0")).toBe(true);
    expect(isRepositoryName("Core")).toBe(false);
    expect(isRepositoryName("../etc")).toBe(false);
    expect(isRepositoryName("a/b")).toBe(false);
    expect(isRepositoryName("")).toBe(false);
    expect(isRepositoryName(`${"x".repeat(65)}`)).toBe(false);
  });

  it("says how a repository is saved in the words every surface prints", () => {
    expect(repositorySavedWords({ capture: "nested" })).toBe("saved with the main repository");
    expect(repositorySavedWords({ capture: "own" })).toBe("saved under its own captures");
  });
});
