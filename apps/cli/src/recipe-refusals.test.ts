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
            message: "is absolute; name a path inside the repository",
          },
          { name: "web", key: "depends", message: "@db · shared services are not available yet" },
          { name: "api", key: "port", message: "must be a port in 1..65535" },
        ],
        ignored: [],
      }),
    ).toBe(
      "web is refused by mend.toml · cwd is absolute; name a path inside the repository · depends @db · shared services are not available yet",
    );
  });

  it("says what is declared when nothing refuses the name, or the server reads no refusals", () => {
    expect(missingRecipeLine("web", [{ name: "api" }], { refused: [], ignored: [] })).toBe(
      'no recipe named "web" — declared: api',
    );
    expect(missingRecipeLine("web", [], null)).toBe(
      "no mend.toml recipes in this worktree — declare [service.web] first",
    );
  });

  it("lists the file's resource proposals that are refused or carry ignored keys, under their own heading", () => {
    expect(
      missingRecipeLine("web", [{ name: "api" }], {
        refused: [
          { name: null, key: "resource.web.ports.http", message: "must be a port in 1..65535" },
          { name: null, key: "preview.service", message: "names web, which no recipe declares" },
        ],
        ignored: [
          { name: null, key: "resource.web.healthcheck" },
          { name: null, key: "future" },
        ],
      }),
    ).toBe(
      'no recipe named "web" — declared: api\n' +
        "Resource proposals in mend.toml (none runs from the file; a manager approves each in project settings):\n" +
        "  resource.web.ports.http · must be a port in 1..65535\n" +
        "  resource.web.healthcheck · is ignored: this Mend does not read it",
    );
  });
});
