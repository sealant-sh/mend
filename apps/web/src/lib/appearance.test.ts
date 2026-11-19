import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_FONT,
  parseTerminalFont,
  parseTextSize,
  terminalFamily,
  terminalFaceLabel,
} from "./appearance.ts";
import { parseTheme } from "./theme.ts";

describe("text size", () => {
  it("reads what this browser kept, and Default for anything else", () => {
    expect(parseTextSize("small")).toBe("small");
    expect(parseTextSize("large")).toBe("large");
    expect(parseTextSize("huge")).toBe("default");
    expect(parseTextSize(undefined)).toBe("default");
  });
});

describe("terminal font", () => {
  it("keeps a face and size Mend offers", () => {
    expect(parseTerminalFont({ face: "jetbrains-mono", size: 15 })).toEqual({
      face: "jetbrains-mono",
      size: 15,
    });
  });

  it("falls back to Geist Mono at 13px for anything it can't read", () => {
    expect(parseTerminalFont({ face: "comic-sans", size: 13 }).face).toBe("geist-mono");
    expect(parseTerminalFont({ face: "menlo", size: 99 }).size).toBe(13);
    expect(parseTerminalFont("menlo")).toEqual(DEFAULT_TERMINAL_FONT);
  });

  it("draws in the chosen face, then Geist Mono when the browser lacks it", () => {
    expect(terminalFamily({ face: "fira-code", size: 13 })).toBe(
      '"Fira Code", "Geist Mono Variable", ui-monospace, monospace',
    );
    expect(terminalFamily(DEFAULT_TERMINAL_FONT)).toBe(
      '"Geist Mono Variable", ui-monospace, monospace',
    );
    expect(terminalFaceLabel({ face: "menlo", size: 13 })).toBe("Menlo");
  });
});

describe("theme cookie", () => {
  it("reads light or dark, and System for anything else", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("sepia")).toBe("system");
  });
});
