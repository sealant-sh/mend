import { describe, expect, it } from "vitest";

import { missingRecipeLine } from "./recipe-refusals.ts";

describe("mend service run <name> with no recipe to run", () => {
  it("says why mend.toml refuses it, key by key", () => {
    expect(
      missingRecipeLine("web", [{ name: "api" }], {
        refused: [
          {
            name: "web",
            key: "cwd",
            message: "is absolute; name a directory inside the repository",
          },
          { name: "web", key: "depends", message: "@db · shared services are not available yet" },
          { name: "api", key: "port", message: "must be a port in 1..65535" },
        ],
      }),
    ).toBe(
      "web is refused by mend.toml · cwd is absolute; name a directory inside the repository · depends @db · shared services are not available yet",
    );
  });

  it("says what is declared when nothing refuses the name, or the server reads no refusals", () => {
    expect(missingRecipeLine("web", [{ name: "api" }], { refused: [] })).toBe(
      'no recipe named "web" — declared: api',
    );
    expect(missingRecipeLine("web", [], null)).toBe(
      "no mend.toml recipes in this worktree — declare [service.web] first",
    );
  });
});
