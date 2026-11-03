/*
  Evidence Review tokens as TypeScript, for surfaces that cannot consume the CSS
  sheet (React Native / Expo). Values are transcribed from ./styles/globals.css,
  which remains the authority — keep the two in sync when the vendored sheet
  changes.
*/

export interface EvidenceColors {
  /** Outer page gutter, behind sheets */
  readonly canvas: string;
  /** Primary working sheet — the dominant surface */
  readonly bg: string;
  /** Raised panels / overlays / drawers */
  readonly panel: string;
  /** Recessed bars, hovers, muted fills */
  readonly sunken: string;
  /** Cobalt wash — selection, active, info */
  readonly wash: string;

  /** Primary text */
  readonly ink: string;
  /** Secondary text */
  readonly ink2: string;
  /** Tertiary text & quiet actions */
  readonly muted: string;
  /** Section labels */
  readonly label: string;
  /** Mono dim / placeholders */
  readonly faint: string;

  /** Strong hairline / input border */
  readonly rule: string;
  /** Hairline — panel & divider rule */
  readonly softRule: string;
  /** Innermost row dividers */
  readonly faintRule: string;

  /** The only brand color — interaction & selection */
  readonly accent: string;
  readonly accentForeground: string;

  /** Unresolved judgment (dot) */
  readonly amber: string;
  readonly amberText: string;
  /** Demonstrated breakage (dot) */
  readonly red: string;
  readonly redText: string;
  /** Observed success (text) */
  readonly green: string;
  readonly greenDot: string;

  /** Diff tints — edge marks, never floods */
  readonly addEdge: string;
  readonly addBg: string;
  readonly delEdge: string;
  readonly delBg: string;
}

export const lightColors: EvidenceColors = {
  canvas: "#edeae4",
  bg: "#faf9f7",
  panel: "#ffffff",
  sunken: "#f1eee8",
  wash: "#f4f6fd",

  ink: "#1b1b1d",
  ink2: "#3b3b40",
  muted: "#6e6e76",
  label: "#8a8a92",
  faint: "#9a9aa2",

  rule: "#cbc8c1",
  softRule: "#e4e1db",
  faintRule: "#eceae4",

  accent: "#2052cc",
  accentForeground: "#ffffff",

  amber: "#cf9a18",
  amberText: "#9a6700",
  red: "#c0362c",
  redText: "#b3261e",
  green: "#2e7d46",
  greenDot: "#5f9e77",

  addEdge: "#2e7d46",
  addBg: "rgba(46, 125, 70, 0.07)",
  delEdge: "#c0362c",
  delBg: "rgba(192, 54, 44, 0.06)",
};

export const darkColors: EvidenceColors = {
  canvas: "#0d0f13",
  bg: "#14161b",
  panel: "#1f222a",
  sunken: "#272b34",
  wash: "#1c2747",

  ink: "#eef0f5",
  ink2: "#cdd1db",
  muted: "#a2a8b5",
  label: "#9096a4",
  faint: "#7e8493",

  rule: "#4a505e",
  softRule: "#363b46",
  faintRule: "#2c3039",

  accent: "#5781ea",
  accentForeground: "#ffffff",

  amber: "#cf9a18",
  amberText: "#d9a93a",
  red: "#c0362c",
  redText: "#e0726a",
  green: "#5faf78",
  greenDot: "#5f9e77",

  addEdge: "#5faf78",
  addBg: "rgba(95, 175, 120, 0.1)",
  delEdge: "#e0726a",
  delBg: "rgba(224, 114, 106, 0.09)",
};

export const evidenceColors = {
  light: lightColors,
  dark: darkColors,
} as const;

export type EvidenceScheme = keyof typeof evidenceColors;

/** Soft radius scale, px. Controls `lg`, cards `xl2`, hero panels `xl3`. */
export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xl2: 22,
  xl3: 28,
} as const;

/** 8px rhythm, used generously. */
export const spacing = {
  xs: 6,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xl2: 48,
  xl3: 64,
} as const;

/**
  The three voices. Values are font family names as registered by the loader
  (Expo Google Fonts static styles); web CSS uses the stacks in globals.css.
*/
export const fontFamilies = {
  sans: {
    regular: "Inter_400Regular",
    medium: "Inter_500Medium",
    semibold: "Inter_600SemiBold",
  },
  display: {
    medium: "SpaceGrotesk_500Medium",
    semibold: "SpaceGrotesk_600SemiBold",
    bold: "SpaceGrotesk_700Bold",
  },
  mono: {
    regular: "JetBrainsMono_400Regular",
    medium: "JetBrainsMono_500Medium",
  },
} as const;

/** Type scale from DESIGN.md §2. Sizes px; tracking em multiples of size. */
export const typeScale = {
  pageTitle: { size: 28, letterSpacing: -0.016 },
  body: { size: 14.5, lineHeight: 1.55 },
  ui: { size: 13 },
  sectionLabel: { size: 12 },
  mono: { size: 12.5 },
  /** Tiny mono eyebrow: uppercase, wide tracking */
  eyebrow: { size: 10.5, letterSpacing: 0.06 },
} as const;

/**
  Elevation — warm, low-spread depth, as CSS box-shadow strings (React Native
  ≥0.76 accepts `boxShadow`; identical on web).
*/
export const shadows = {
  light: {
    xs: "0 1px 2px 0 rgba(27, 27, 29, 0.05)",
    sm: "0 2px 8px -3px rgba(27, 27, 29, 0.1)",
    md: "0 14px 34px -16px rgba(27, 27, 29, 0.18)",
    lg: "0 30px 68px -30px rgba(27, 27, 29, 0.26)",
    cobalt: "0 24px 64px -26px rgba(32, 82, 204, 0.34)",
    overlay: "0 24px 56px -24px rgba(27, 27, 29, 0.26)",
  },
  dark: {
    xs: "0 1px 2px 0 rgba(0, 0, 0, 0.4)",
    sm: "0 2px 8px -3px rgba(0, 0, 0, 0.5)",
    md: "0 14px 34px -16px rgba(0, 0, 0, 0.6)",
    lg: "0 30px 68px -30px rgba(0, 0, 0, 0.7)",
    cobalt: "0 24px 64px -26px rgba(32, 82, 204, 0.5)",
    overlay: "0 24px 56px -24px rgba(0, 0, 0, 0.7)",
  },
} as const;
