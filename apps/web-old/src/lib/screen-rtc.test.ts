import { describe, expect, it } from "vitest";

import { screenKeysym } from "./screen-rtc.ts";

const key = (value: string, location = 0) => screenKeysym({ key: value, code: value, location });

describe("screen input keysyms", () => {
  it("maps navigation, function keys, Unicode, and left/right modifiers to X11", () => {
    expect(key("a")).toBe(0x61);
    expect(key("é")).toBe(0xe9);
    expect(key("λ")).toBe(0x010003bb);
    expect(key("😀")).toBe(0x0101f600);
    expect(key("ArrowLeft")).toBe(0xff51);
    expect(key("Enter")).toBe(0xff0d);
    expect(key("F1")).toBe(0xffbe);
    expect(key("F12")).toBe(0xffc9);
    expect(key("Shift", 1)).toBe(0xffe1);
    expect(key("Shift", 2)).toBe(0xffe2);
    expect(key("Alt", 2)).toBe(0xffea);
    expect(key("Unidentified")).toBeUndefined();
    expect(key("Dead")).toBeUndefined();
    expect(key("toString")).toBeUndefined();
  });
});
