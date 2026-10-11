import { describe, expect, it } from "vitest";

import { agentLoginsLine, parseAgentLoginsArgs } from "./agent-logins.ts";

describe("mend agent-logins", () => {
  it("shows, and sets all or selected", () => {
    expect(parseAgentLoginsArgs([])).toEqual({ kind: "show" });
    expect(parseAgentLoginsArgs(["all"])).toEqual({ kind: "set", selectedOnly: false });
    expect(parseAgentLoginsArgs(["selected"])).toEqual({ kind: "set", selectedOnly: true });
  });

  it("refuses anything else before asking the server", () => {
    expect(parseAgentLoginsArgs(["some"])).toEqual({ kind: "usage" });
    expect(parseAgentLoginsArgs(["all", "selected"])).toEqual({ kind: "usage" });
  });

  it("says what a session of yours receives", () => {
    expect(agentLoginsLine({ selectedOnly: false })).toBe(
      "all · a Claude session also gets your Codex login, a Codex session your Claude login, when connected",
    );
    expect(agentLoginsLine({ selectedOnly: true })).toBe(
      "selected · a Claude or Codex session gets its own agent's login only",
    );
  });
});
