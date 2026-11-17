import { type EvidenceColors, type EvidenceScheme, evidenceColors } from "./tokens.ts";

export interface PageTheme {
  readonly appearance: EvidenceScheme;
  readonly variables: Readonly<Record<string, string>>;
}

const tint = (hex: string, alpha: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

const FONT_SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif';
const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

// Named as t3code names them (its `htmlRenderTheme`), so a page written for either host reads
// the same variables.
const variablesOf = (colors: EvidenceColors): Readonly<Record<string, string>> => ({
  "--background": colors.bg,
  "--foreground": colors.ink,
  "--muted": colors.sunken,
  "--muted-foreground": colors.muted,
  "--card": colors.panel,
  "--card-foreground": colors.ink,
  "--popover": colors.panel,
  "--popover-foreground": colors.ink,
  "--secondary": colors.sunken,
  "--secondary-foreground": colors.ink,
  "--border": colors.softRule,
  "--input": colors.rule,
  "--ring": colors.accent,
  "--primary": colors.accent,
  "--primary-foreground": colors.accentForeground,
  "--accent": colors.accent,
  "--accent-foreground": colors.accentForeground,
  "--accent-surface": colors.wash,
  "--accent-surface-foreground": colors.accent,
  "--destructive": colors.red,
  "--destructive-foreground": colors.redText,
  "--destructive-surface": colors.delBg,
  "--warning": colors.amber,
  "--warning-foreground": colors.amberText,
  "--warning-surface": tint(colors.amber, 0.1),
  "--success": colors.green,
  "--success-foreground": colors.green,
  "--info": colors.accent,
  "--info-foreground": colors.accent,
  "--code-background": colors.sunken,
  "--code-foreground": colors.ink,
  "--chart-1": colors.accent,
  "--chart-2": colors.green,
  "--chart-3": colors.amber,
  "--chart-4": colors.red,
  "--chart-5": colors.muted,
  "--chart-6": colors.ink2,
  "--radius": "0.75rem",
  "--font-sans": FONT_SANS,
  "--font-mono": FONT_MONO,
});

export const pageThemes: Readonly<Record<EvidenceScheme, PageTheme>> = {
  light: { appearance: "light", variables: variablesOf(evidenceColors.light) },
  dark: { appearance: "dark", variables: variablesOf(evidenceColors.dark) },
};
