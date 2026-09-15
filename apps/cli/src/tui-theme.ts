/**
 * Ayu Mirage with a brighter text ramp for terminal legibility.
 * Backgrounds, accent and syntax colors follow ayu-theme/vscode-ayu's
 * `ayu-mirage.json`. Text and borders are lifted for the TUI's small glyphs.
 * The palette is local to the CLI; it does not change the web theme.
 */

/** Ayu's sidebar and terminal background. */
export const CANVAS = "#1f2430";
/** Ayu's editor background. */
export const PANEL = "#242936";
/** Ayu's floating widget background. */
export const SURFACE = "#282e3b";

/** Primary text, warm white. */
export const INK = "#e6e1cf";
/** Secondary text, including the recorded conversation. */
export const INK_2 = "#d1d4dc";
/** Labels and session facts. */
export const MUTED = "#c2cad7";
/** Quiet text still clears 7:1 contrast on panels and floating surfaces. */
export const FAINT = "#b0bbcc";

/** Borders are separate from titles, which use the primary text color. */
export const RULE = "#78859a";
/** Ayu's focus yellow, reserved for selection and interaction. */
export const ACCENT = "#ffcc66";
/** Ayu's #63759926 selection composited over PANEL. */
export const WASH = "#2d3445";

export const AMBER = "#ffcc66";
/** Ayu's diff addition and deletion foregrounds. */
export const GREEN = "#87d96c";
export const RED = "#f27983";
/** Ayu's error foreground, distinct from routine deletions. */
export const ERROR = "#ff6666";
/** Diff foregrounds composited at 20% over PANEL. */
export const ADD_WASH = "#384c41";
export const DELETE_WASH = "#4d3945";

export const SYNTAX_KEYWORD = "#ffa659";
export const SYNTAX_STRING = "#d5ff80";
export const SYNTAX_NUMBER = "#dfbfff";
export const SYNTAX_FUNCTION = "#ffcd66";
