import type { Rule } from "@oxlint/plugins";

import { stringVisitor } from "../strings.ts";

// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, standing alone: not part of a word, an id or a URL.
const HEX = /(?<![\w&#/-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/i;
const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(/i;
// A Tailwind arbitrary value holding a colour: `bg-[#0a0a0a]`, `text-[rgb(0_0_0)]`, `fill-[oklch(…)]`.
const ARBITRARY = /-\[(?:[a-z-]+:)?(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab)\()[^\]]*\]/i;

export const noRawColors: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Colours come from the kit's tokens: no hex, rgb(), hsl() or oklch() in a .tsx file or a Tailwind class.",
    },
    messages: {
      raw: "`{{color}}` is a raw colour. Use the kit's colour tokens instead: a Tailwind colour class from the theme, or `var(--…)`.",
    },
  },
  create(context) {
    // In a .tsx file any raw colour is app code drawing its own colour; in a .ts file only a
    // Tailwind class is, since a .ts file may hold a palette a library needs, such as a
    // terminal theme.
    const anywhere = context.filename.endsWith(".tsx");
    return stringVisitor((node, text) => {
      if (
        anywhere &&
        node.parent?.type === "JSXAttribute" &&
        node.parent.name.type === "JSXIdentifier" &&
        node.parent.name.name === "href"
      )
        return;
      const found = anywhere
        ? (HEX.exec(text)?.[0] ?? FUNCTION.exec(text)?.[0])
        : ARBITRARY.exec(text)?.[0];
      if (found === undefined) return;
      context.report({ node, messageId: "raw", data: { color: found.replace(/\($/, "()") } });
    });
  },
};
