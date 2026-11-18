/** The theme a page the agent made is painted with: light or dark, and the host's colours. */
export interface PageTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * The variables a page reads, named as t3code names them (its `htmlRenderTheme`), each from one of
 * Sheet's tokens: a page written for either host reads the same names.
 */
const FROM_SHEET: ReadonlyArray<readonly [string, string]> = [
  ["--background", "--background"],
  ["--foreground", "--foreground"],
  ["--muted", "--muted"],
  ["--muted-foreground", "--muted-foreground"],
  ["--card", "--card"],
  ["--card-foreground", "--card-foreground"],
  ["--popover", "--popover"],
  ["--popover-foreground", "--popover-foreground"],
  ["--secondary", "--secondary"],
  ["--secondary-foreground", "--secondary-foreground"],
  ["--border", "--border"],
  ["--input", "--input"],
  ["--ring", "--ring"],
  ["--primary", "--primary"],
  ["--primary-foreground", "--primary-foreground"],
  ["--accent", "--primary"],
  ["--accent-foreground", "--primary-foreground"],
  ["--destructive", "--destructive"],
  ["--warning", "--warning"],
  ["--success", "--success"],
  ["--info", "--info"],
  ["--code-background", "--muted"],
  ["--code-foreground", "--foreground"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
];

/**
 * The page theme from the tokens as `read` gives them (the document's computed style in a browser):
 * what the app itself is painted with now, light or dark. A token `read` lacks is left out, and the
 * page keeps its own value for it.
 */
export const pageThemeOf = (read: (token: string) => string, dark: boolean): PageTheme => ({
  appearance: dark ? "dark" : "light",
  variables: Object.fromEntries(
    FROM_SHEET.flatMap(([name, token]) => {
      const value = read(token).trim();
      return value === "" ? [] : [[name, value]];
    }),
  ),
});
