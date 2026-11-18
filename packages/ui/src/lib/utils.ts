import { createCn } from "cn/config";

/**
 * Merges class names, dropping the earlier of two that set the same thing. It knows the names
 * globals.css adds to Tailwind's scales; without them `cn` reads `text-meta` as a colour and drops
 * `text-muted-foreground` beside it. Every component imports `cn` from here, not from "cn".
 */
export const cn = createCn({
  extend: {
    theme: {
      text: ["2xs", "meta", "row", "prose"],
      radius: ["chip", "palette"],
      shadow: ["sheet", "card", "pop"],
      spacing: [
        "sheet-inset",
        "sidebar",
        "header",
        "tab-strip",
        "conversation",
        "settings",
        "palette",
      ],
    },
  },
});

// React passes CSS custom properties (`--sidebar-width`) through to an element's style, but its
// types list none of them.
export type CSSVariables = { [variable: `--${string}`]: string | number | undefined };

declare module "react" {
  interface CSSProperties extends CSSVariables {}
}
