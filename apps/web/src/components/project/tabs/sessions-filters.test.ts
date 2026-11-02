import { describe, expect, it } from "vitest";

import { filtersOfSearch, parseSessionSearch, searchOfFilters } from "./sessions-filters";

describe("the Sessions tab's filters in the URL", () => {
  it("opens on your own sessions when the URL says nothing", () => {
    expect(filtersOfSearch(parseSessionSearch({}))).toEqual({
      startedBy: "me",
      agent: null,
      branch: null,
    });
  });

  it("keeps only what differs from the default", () => {
    expect(searchOfFilters({ startedBy: "me", agent: null, branch: null })).toEqual({});
    expect(searchOfFilters({ startedBy: "anyone", agent: "codex", branch: "t3/tabs" })).toEqual({
      who: "anyone",
      agent: "codex",
      branch: "t3/tabs",
    });
  });

  it("survives a round trip and ignores values it does not know", () => {
    const search = parseSessionSearch({ who: "anyone", agent: "claude", branch: "", extra: 1 });
    expect(search).toEqual({ who: "anyone", agent: "claude" });
    expect(searchOfFilters(filtersOfSearch(search))).toEqual(search);
    expect(parseSessionSearch({ who: "someone", agent: 3 })).toEqual({});
  });
});
