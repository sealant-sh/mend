import { describe, expect, it } from "vitest";

import { purgeKeys } from "./project-purge-blobs.ts";

describe("purge's blob inventory", () => {
  it("deletes exclusive objects while keeping another project's inherited pack and tree", () => {
    const entries = [
      "captures/w/1/own",
      "captures/w/1/shared",
      "captures/w/1/shared.idx",
      "captures/w/1/trees/child",
      "projects/p/cache/own",
    ];
    expect(
      purgeKeys(
        entries,
        new Set(["captures/w/1/shared", "captures/w/1/shared.idx"]),
        new Set(["captures/w/1/trees/"]),
      ),
    ).toEqual(["captures/w/1/own", "projects/p/cache/own"]);
  });
  it("a repeated purge deletes the remaining exclusive objects after a partial deletion", () => {
    expect(purgeKeys(["captures/w/1/remaining"], new Set(), new Set())).toEqual([
      "captures/w/1/remaining",
    ]);
  });
});
