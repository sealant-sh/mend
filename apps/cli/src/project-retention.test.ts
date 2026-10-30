import { describe, expect, it } from "vitest";

import { parseProjectRetentionArgs } from "./project-retention.ts";

describe("mend projects retention commands", () => {
  it("requires the project id and explicit name confirmation for purge", () => {
    expect(parseProjectRetentionArgs(["purge", "p1"])).toEqual({
      error: "Purge requires --confirm <project-name>.",
    });
    expect(parseProjectRetentionArgs(["purge", "p1", "--confirm", "api"])).toEqual({
      command: "purge",
      id: "p1",
      confirm: "api",
      json: false,
    });
  });
  it("accepts Restore with a new name and refuses force", () => {
    expect(parseProjectRetentionArgs(["restore", "p1", "--name", "api-old", "--json"])).toEqual({
      command: "restore",
      id: "p1",
      name: "api-old",
      json: true,
    });
    expect(parseProjectRetentionArgs(["rm", "p1", "--force"])).toEqual({
      error: "Unknown argument --force.",
    });
  });
});
