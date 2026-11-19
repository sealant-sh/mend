import { createCookieStore } from "./cookie-store.ts";

/**
 * Settings → This device → Appearance (docs/adr/0025: theme, text size and terminal font belong to
 * the browser). Each is kept in a cookie, as the sidebar's state is, so the server renders the page
 * with it and nothing jumps as the page hydrates. The theme is `theme.ts`'s, the same choice the
 * account menu sets.
 */

export type TextSize = "small" | "default" | "large";

export const TEXT_SIZES: ReadonlyArray<{ readonly value: TextSize; readonly label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

export const parseTextSize = (stored: unknown): TextSize =>
  stored === "small" || stored === "large" ? stored : "default";

/**
 * The size of text across Mend in this browser. The kit sizes type in rem, so the root's size
 * (`styles.css`, `html[data-text-size]`) scales every line and the spacing around it together.
 */
export const textSize = createCookieStore<TextSize>("mend-text-size", parseTextSize, "default");

/** A face a terminal can be drawn in; the browser must have it, or Geist Mono stands in. */
export interface TerminalFace {
  readonly id: string;
  readonly label: string;
  /** The CSS family, as the browser knows the face. */
  readonly family: string;
}

/** The kit's mono face, which Mend ships: every other face falls back to it. */
const GEIST_MONO = '"Geist Mono Variable"';

export const TERMINAL_FACES: ReadonlyArray<TerminalFace> = [
  { id: "geist-mono", label: "Geist Mono", family: GEIST_MONO },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: '"JetBrains Mono"' },
  { id: "fira-code", label: "Fira Code", family: '"Fira Code"' },
  { id: "cascadia-code", label: "Cascadia Code", family: '"Cascadia Code"' },
  { id: "sf-mono", label: "SF Mono", family: '"SF Mono", "SFMono-Regular"' },
  { id: "menlo", label: "Menlo", family: "Menlo" },
  { id: "consolas", label: "Consolas", family: "Consolas" },
];

export const TERMINAL_SIZES: ReadonlyArray<number> = [11, 12, 13, 14, 15, 16, 18];

export interface TerminalFont {
  readonly face: string;
  readonly size: number;
}

export const DEFAULT_TERMINAL_FONT: TerminalFont = { face: "geist-mono", size: 13 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** What this browser kept for its terminals; a face or size Mend doesn't offer is the default. */
export const parseTerminalFont = (stored: unknown): TerminalFont => {
  if (!isRecord(stored)) return DEFAULT_TERMINAL_FONT;
  const { face, size } = stored;
  return {
    face: TERMINAL_FACES.some((candidate) => candidate.id === face)
      ? String(face)
      : DEFAULT_TERMINAL_FONT.face,
    size:
      typeof size === "number" && TERMINAL_SIZES.includes(size) ? size : DEFAULT_TERMINAL_FONT.size,
  };
};

/** The face and size of terminals in this browser. */
export const terminalFont = createCookieStore<TerminalFont>(
  "mend-terminal-font",
  parseTerminalFont,
  DEFAULT_TERMINAL_FONT,
);

/** The CSS font family for a terminal: the chosen face, then Geist Mono, then the system's mono. */
export const terminalFamily = (font: TerminalFont): string => {
  const face = TERMINAL_FACES.find((candidate) => candidate.id === font.face);
  const chosen = face === undefined || face.family === GEIST_MONO ? [] : [face.family];
  return [...chosen, GEIST_MONO, "ui-monospace", "monospace"].join(", ");
};

export const terminalFaceLabel = (font: TerminalFont): string =>
  TERMINAL_FACES.find((candidate) => candidate.id === font.face)?.label ?? "Geist Mono";
