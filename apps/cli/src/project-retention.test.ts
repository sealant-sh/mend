import { describe, expect, it } from "vitest";

import { removedDiskWords } from "./doctor.ts";
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
  it("says what removed projects keep on disk in sizes a person reads, and what purge would keep", () => {
    expect(removedDiskWords({ bytes: 3 * 1024 * 1024, sharedBytes: 1536 })).toBe(
      "3.0 MB on disk, 1.5 kB of it shared with other projects and kept by purge",
    );
    expect(removedDiskWords({ bytes: 512, sharedBytes: 0 })).toBe("512 B on disk");
    expect(removedDiskWords({ bytes: null, sharedBytes: null })).toBe("disk usage unread");
  });
});
