import { describe, expect, it } from "vitest";

import { DEFAULT_WINDOW_SIZE, resolveInitialBounds, windowFitsDisplay } from "./bounds.ts";

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const EXTERNAL = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("resolveInitialBounds", () => {
  it("restores saved bounds when they fit on a connected display, including 1px snapped edges", () => {
    const snapped = { x: -1, y: 0, width: 1921, height: 1080 };
    expect(windowFitsDisplay(snapped, PRIMARY)).toBe(true);
    expect(resolveInitialBounds(snapped, [PRIMARY])).toEqual(snapped);
  });

  it("falls back to default size when the display holding the saved bounds is disconnected", () => {
    const onExternal = { x: 2100, y: 100, width: 1400, height: 900 };
    expect(resolveInitialBounds(onExternal, [PRIMARY, EXTERNAL])).toEqual(onExternal);
    expect(resolveInitialBounds(onExternal, [PRIMARY])).toEqual(DEFAULT_WINDOW_SIZE);
  });

  it("rejects saved bounds smaller than the minimum window dimensions", () => {
    const tooSmall = { x: 100, y: 100, width: 640, height: 480 };
    expect(resolveInitialBounds(tooSmall, [PRIMARY])).toEqual(DEFAULT_WINDOW_SIZE);
  });
});
