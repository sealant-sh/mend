import { describe, expect, it } from "vitest";

import { desktopByteRange } from "./desktop-capture.ts";

describe("captured desktop media ranges", () => {
  it("serves complete files and bounded browser seek ranges", () => {
    expect(desktopByteRange(undefined, 0)).toEqual({ start: 0, end: -1, partial: false });
    expect(desktopByteRange(undefined, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(desktopByteRange("bytes=12-30", 100)).toEqual({ start: 12, end: 30, partial: true });
    expect(desktopByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(desktopByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99, partial: true });
  });

  it("refuses unsatisfiable, imprecise and unsupported ranges", () => {
    for (const range of [
      "bytes=100-",
      "bytes=30-12",
      "bytes=-2",
      "bytes=0-2,4-6",
      "bytes=9007199254740993-",
      "items=0-1",
    ])
      expect(desktopByteRange(range, 100)).toBeNull();
    expect(desktopByteRange("bytes=0-", 0)).toBeNull();
  });
});
