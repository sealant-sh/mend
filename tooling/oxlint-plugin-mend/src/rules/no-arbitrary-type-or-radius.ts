import type { Rule } from "@oxlint/plugins";

import { stringVisitor, utilities } from "../strings.ts";

// `text-[13px]`, `text-[length:13px]`, `rounded-[7px]`, `rounded-tl-[7px]`.
const ARBITRARY = /^(text|rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?)-\[(.+)\]$/;
// What `text-[…]` holds when it is a size rather than a colour: a number with a unit, or a
// length function.
const LENGTH = /^(?:length:)?(?:-?[\d.]+[a-z%]*|(?:calc|clamp|min|max)\(.*\))$/;

export const noArbitraryTypeOrRadius: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Type sizes and radii come from the kit's scale: no `text-[13px]` or `rounded-[7px]`. Arbitrary widths and heights are fine.",
    },
    messages: {
      type: "`{{utility}}` sets a type size off the kit's scale. Use one of the kit's text sizes (`text-sm`, or the name the kit gives an off-scale size).",
      radius:
        "`{{utility}}` sets a radius off the kit's scale. Use one of the kit's radii (`rounded-md`, or the name the kit gives an off-scale radius).",
    },
  },
  create(context) {
    return stringVisitor((node, text) => {
      for (const utility of utilities(text)) {
        const match = ARBITRARY.exec(utility);
        if (match === null) continue;
        const [, prefix = "", value = ""] = match;
        // A value worked out from a token (`min(var(--radius-md),10px)`) or a keyword
        // (`rounded-[inherit]`) stays on the scale.
        if (value.includes("var(") || /^[a-z-]+$/.test(value)) continue;
        if (prefix === "text") {
          if (!LENGTH.test(value)) continue;
          context.report({ node, messageId: "type", data: { utility } });
        } else {
          context.report({ node, messageId: "radius", data: { utility } });
        }
      }
    });
  },
};
