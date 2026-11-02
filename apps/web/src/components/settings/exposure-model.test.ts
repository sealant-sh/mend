import { describe, expect, it } from "vitest";

import { establishedTone, establishedWord, exposureCounts } from "./exposure-model";

describe("exposure words", () => {
  it("dots only what was observed or left open", () => {
    expect(establishedTone({ established: "observed", blocksStart: true })).toBe("ok");
    expect(establishedTone({ established: "carried", blocksStart: false })).toBeNull();
    expect(establishedTone({ established: "declared", blocksStart: false })).toBeNull();
    expect(establishedTone({ established: "open", blocksStart: true })).toBe("bad");
    expect(establishedTone({ established: "open", blocksStart: false })).toBe("wait");
  });

  it("says when an open item refuses a public start", () => {
    expect(establishedWord({ established: "open", blocksStart: true })).toBe(
      "open · refuses a public start",
    );
    expect(establishedWord({ established: "open", blocksStart: false })).toBe("open");
  });

  it("counts items by how they were established, never as a verdict", () => {
    const line = exposureCounts([
      { established: "observed", blocksStart: true },
      { established: "declared", blocksStart: false },
      { established: "open", blocksStart: false },
    ]);
    expect(line).toBe("1 observed · 1 declared · 0 carried · 1 open");
    expect(line).not.toMatch(/safe|pass|reachable/i);
    expect(exposureCounts([])).toBe("0 observed · 0 declared · 0 carried · none open");
  });
});
