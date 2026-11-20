import { describe, expect, it } from "vitest";

import { TOAST_GAP, toastClearance } from "./toast-clearance.ts";

const desk = { width: 1280, height: 800, phone: false, bottom: 24 };
const phone = { width: 390, height: 844, phone: true, bottom: 72 };

describe("where toasts sit beside a composer", () => {
  it("keeps the corner when no composer reaches it", () => {
    expect(toastClearance([], desk)).toBeNull();
    // A wide window: the composer's column ends well left of the corner.
    expect(
      toastClearance([{ top: 640, bottom: 776, left: 500, right: 1200 }], {
        ...desk,
        width: 1920,
      }),
    ).toBeNull();
    // Home's composer, in the middle of the sheet, is above the toasts.
    expect(toastClearance([{ top: 300, bottom: 440, left: 400, right: 1180 }], desk)).toBeNull();
  });

  it("sits just above a composer at the foot of the sheet that reaches into the corner", () => {
    const composer = { top: 640, bottom: 776, left: 400, right: 1180 };
    expect(toastClearance([composer], desk)).toBe(800 - 640 + TOAST_GAP);
  });

  it("clears the tallest of several composers in the way", () => {
    const left = { top: 600, bottom: 776, left: 300, right: 830 };
    const middle = { top: 700, bottom: 776, left: 600, right: 900 };
    const right = { top: 660, bottom: 776, left: 880, right: 1250 };
    expect(toastClearance([left, middle, right], desk)).toBe(800 - 660 + TOAST_GAP);
  });

  it("on a phone, clears any composer at the bottom, whatever its width", () => {
    const composer = { top: 700, bottom: 828, left: 16, right: 200 };
    expect(toastClearance([composer], phone)).toBe(844 - 700 + TOAST_GAP);
  });

  it("ignores a composer that isn't on screen", () => {
    expect(toastClearance([{ top: 0, bottom: 0, left: 0, right: 0 }], desk)).toBeNull();
    expect(toastClearance([{ top: 900, bottom: 1000, left: 400, right: 1180 }], desk)).toBeNull();
  });
});
