import { describe, expect, it } from "vitest";

import { parseProjectSessionsSearch } from "./project-sessions-search.ts";

describe("a project's Sessions tab address", () => {
  it("reads its filters from the address and drops what it doesn't know", () => {
    expect(
      parseProjectSessionsSearch({
        q: "retry",
        who: "mine",
        show: "stopped",
        agent: "codex",
        branch: "",
        page: 2,
      }),
    ).toEqual({ q: "retry", who: "mine", show: "stopped", agent: "codex" });
    expect(parseProjectSessionsSearch({ who: "everyone", show: "open", q: "  " })).toEqual({});
  });
});
