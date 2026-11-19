import { describe, expect, it } from "vitest";

import {
  clientIssues,
  clientSecretIssues,
  issuesFor,
  loadSummary,
  secretSetLine,
} from "./project-environment.ts";

describe("clientIssues", () => {
  it("mirrors the server policy with the same wording, values never included", () => {
    const issues = clientIssues({ name: "DB_PASSWORD", value: "hunter2" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("name");
    expect(issues[0]?.rule).toBe("name-reserved");
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("accepts an ordinary pair, including an empty value", () => {
    expect(clientIssues({ name: "APP_MODE", value: "" })).toEqual([]);
  });

  it("splits issues by field for the two inputs", () => {
    const issues = clientIssues({ name: "BAD NAME", value: "x".repeat(5000) });
    expect(issuesFor(issues, "name")).toHaveLength(1);
    expect(issuesFor(issues, "value")).toHaveLength(1);
    expect(issuesFor(issues, null)).toHaveLength(0);
  });
});

describe("clientSecretIssues", () => {
  const codexWords =
    "OPENAI_API_KEY is a Codex login, not a project secret. Connect your Codex login in Settings → Connected accounts.";

  it("refuses a provider login name, for a new secret or a replaced value, pointing to Connected accounts", () => {
    expect(clientSecretIssues({ name: "OPENAI_API_KEY", value: "fake" })).toEqual([
      { field: "name", rule: "name-provider-login", message: codexWords },
    ]);
    expect(clientSecretIssues({ name: "OPENAI_API_KEY", value: null })).toEqual([
      { field: "name", rule: "name-provider-login", message: codexWords },
    ]);
  });
});

describe("the page's sentences", () => {
  it("says when a secret was set, not who (the server keeps only when)", () => {
    expect(secretSetLine(new Date(2026, 10, 2), new Date(2026, 10, 19))).toBe("Set on 2 November");
  });

  it("sums up an import by lane, with what was refused", () => {
    expect(
      loadSummary({
        loaded: [
          { name: "NODE_ENV", lane: "configuration", action: "created" },
          { name: "LOG_LEVEL", lane: "configuration", action: "updated" },
          { name: "STRIPE_SECRET_KEY", lane: "secret", action: "moved" },
        ],
        rejected: [{ name: "PATH", reason: "PATH is reserved." }],
        malformedLines: [],
      }),
    ).toBe("Saved 2 variables and 1 secret. 1 name was refused.");
    expect(loadSummary({ loaded: [], rejected: [], malformedLines: [3] })).toBe(
      "Nothing was saved.",
    );
  });
});
