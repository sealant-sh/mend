import { registerCustomCSSVariableTheme } from "@pierre/diffs";

/**
 * Sheet's syntax theme, for the review's diffs and every code block (SLNT-1236, SLNT-1260): every
 * colour is a `--diffs-*` variable with the kit's token behind it (`syntax-keyword`,
 * `syntax-string`, `syntax-constant`, `syntax-link`), so one theme serves light and dark. The
 * `.change-diff` rule in styles.css sets the variables for a diff; a code block elsewhere takes the
 * values here. The hues only help read the code.
 */
export const CODE_THEME = "mend-sheet";

registerCustomCSSVariableTheme(CODE_THEME, {
  foreground: "var(--color-foreground)",
  background: "transparent",
  "token-comment": "var(--color-muted-foreground)",
  "token-keyword": "var(--color-syntax-keyword)",
  "token-string": "var(--color-syntax-string)",
  "token-string-expression": "var(--color-syntax-string)",
  "token-constant": "var(--color-syntax-constant)",
  "token-parameter": "var(--color-foreground)",
  "token-function": "var(--color-foreground)",
  "token-punctuation": "var(--color-muted-foreground)",
  "token-link": "var(--color-syntax-link)",
});
