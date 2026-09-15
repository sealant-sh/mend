import { describe, expect, it } from "vitest";

import * as theme from "./tui-theme.ts";

/**
 * Keep Ayu's backgrounds and accents while enforcing readable terminal text.
 * Contrast checks protect the brighter text ramp from reverting to UI greys.
 */

/** Upstream ayu-theme/vscode-ayu `ayu-mirage.json`, verbatim. */
const AYU = {
  sideBarBackground: "#1f2430",
  editorBackground: "#242936",
  editorWidgetBackground: "#282e3b",
  focusBorder: "#ffcc66",
  listActiveSelectionBackground: "#63759926",
  added: "#87d96c",
  deleted: "#f27983",
  error: "#ff6666",
} as const;

const channels = (hex: string): readonly [number, number, number] => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (match === null) throw new Error(`not a 6-digit hex color: ${hex}`);
  return [
    Number.parseInt(match[1] ?? "", 16),
    Number.parseInt(match[2] ?? "", 16),
    Number.parseInt(match[3] ?? "", 16),
  ];
};

/** `over` painted under `top` at `alpha`, rounded the way the theme file is written. */
const composite = (top: string, alpha: number, over: string): string => {
  const [tr, tg, tb] = channels(top);
  const [br, bg, bb] = channels(over);
  const mix = (t: number, b: number): string =>
    Math.round(b + alpha * (t - b))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(tr, br)}${mix(tg, bg)}${mix(tb, bb)}`;
};

const linearize = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, used only to order the ramps. */
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
};

const contrast = (foreground: string, background: string): number => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe("tui-theme", () => {
  it("is all 6-digit hex, so opentui never sees a color it has to guess at", () => {
    for (const [name, value] of Object.entries(theme)) {
      expect(`${name}=${value}`).toMatch(/=#[0-9a-f]{6}$/);
    }
  });

  it("takes its grounds straight from Ayu Mirage", () => {
    expect(theme.CANVAS).toBe(AYU.sideBarBackground);
    expect(theme.PANEL).toBe(AYU.editorBackground);
    expect(theme.SURFACE).toBe(AYU.editorWidgetBackground);
  });

  it("stacks the three grounds, each one lighter than the one below", () => {
    expect(luminance(theme.CANVAS)).toBeLessThan(luminance(theme.PANEL));
    expect(luminance(theme.PANEL)).toBeLessThan(luminance(theme.SURFACE));
  });

  it("steps the text ramp down, with no two steps reading the same", () => {
    const ramp = [theme.INK, theme.INK_2, theme.MUTED, theme.FAINT];
    const levels = ramp.map(luminance);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i - 1]).toBeGreaterThan(levels[i] ?? 0);
    }
  });

  it("keeps every text role at least 7:1 against the working backgrounds", () => {
    for (const foreground of [theme.INK, theme.INK_2, theme.MUTED, theme.FAINT]) {
      for (const background of [theme.CANVAS, theme.PANEL, theme.SURFACE]) {
        expect(
          contrast(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(7);
      }
      expect(contrast(foreground, theme.WASH)).toBeGreaterThanOrEqual(6);
      for (const background of [theme.ADD_WASH, theme.DELETE_WASH]) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps inactive borders visible without using their color for titles", () => {
    expect(contrast(theme.RULE, theme.PANEL)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.INK, theme.PANEL)).toBeGreaterThan(contrast(theme.RULE, theme.PANEL));
  });

  it("composites the selection wash from Ayu's translucent selection", () => {
    expect(theme.WASH).toBe(
      composite(AYU.listActiveSelectionBackground.slice(0, 7), 0x26 / 255, theme.PANEL),
    );
  });

  it("composites the diff washes from the diff foregrounds at 20%", () => {
    expect(theme.GREEN).toBe(AYU.added);
    expect(theme.RED).toBe(AYU.deleted);
    expect(theme.ADD_WASH).toBe(composite(theme.GREEN, 0.2, theme.PANEL));
    expect(theme.DELETE_WASH).toBe(composite(theme.RED, 0.2, theme.PANEL));
  });

  it("keeps the diff washes quieter than the ink they sit under", () => {
    for (const wash of [theme.ADD_WASH, theme.DELETE_WASH, theme.WASH]) {
      expect(luminance(wash)).toBeLessThan(luminance(theme.FAINT));
      expect(luminance(wash)).toBeGreaterThan(luminance(theme.PANEL));
    }
  });

  it("accents in Ayu's focus yellow and fails in Ayu's error red", () => {
    expect(theme.ACCENT).toBe(AYU.focusBorder);
    expect(theme.ERROR).toBe(AYU.error);
    expect(theme.ERROR).not.toBe(theme.RED);
  });
});
