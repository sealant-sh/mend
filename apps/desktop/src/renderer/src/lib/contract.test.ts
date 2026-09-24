import { describe, expect, it } from "vitest";

import { fillPath, rawInput } from "#/lib/contract";

describe("contract paths", () => {
  it("fills every template parameter, encoded", () => {
    expect(
      fillPath(
        "/api/changes/:id/reviews/:sliceId/diff",
        rawInput({ params: { id: "c/1", sliceId: "s 1" } }),
      ),
    ).toBe("/api/changes/c%2F1/reviews/s%201/diff");
  });

  it("appends only the query fields that carry a value", () => {
    expect(
      fillPath(
        "/api/processes/:id/logs",
        rawInput({ params: { id: "p" }, query: { from: "0", limit: undefined } }),
      ),
    ).toBe("/api/processes/p/logs?from=0");
    expect(fillPath("/api/projects", rawInput(undefined))).toBe("/api/projects");
  });

  it("refuses a template whose parameter has no value", () => {
    expect(() => fillPath("/api/sessions/:id", rawInput({ params: {} }))).toThrow(":id");
  });

  it("keeps an explicit body and tells an absent one apart", () => {
    expect(rawInput({ body: { enabled: false } }).body).toEqual({ enabled: false });
    expect(rawInput({ params: { id: "s" } }).body).toBeUndefined();
  });
});
