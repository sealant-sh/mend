import type { Rule } from "@oxlint/plugins";

export const noUseClient: Rule = {
  meta: {
    type: "problem",
    docs: { description: 'No `"use client"` directive: this repo is not Next.js.' },
    messages: {
      directive:
        'Remove `"use client"`: this repo is not Next.js, and TanStack Start does not read it.',
    },
  },
  create(context) {
    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type !== "ExpressionStatement" || !("directive" in statement)) break;
          if (statement.directive === "use client")
            context.report({ node: statement, messageId: "directive" });
        }
      },
    };
  },
};
