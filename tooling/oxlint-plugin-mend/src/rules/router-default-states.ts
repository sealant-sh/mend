import type { Rule } from "@oxlint/plugins";

import { importedCallee, importsFrom, setsOption } from "../ast.ts";

const SOURCES = new Set(["@tanstack/react-router"]);
const REQUIRED = ["defaultPendingComponent", "defaultErrorComponent", "defaultNotFoundComponent"];

export const routerDefaultStates: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "createRouter sets the components a person sees while a route loads, when it fails, and at an unknown address.",
    },
    messages: {
      missing:
        "createRouter doesn't set {{missing}}. A suspense query's pending and error states are the route's: set `defaultPendingComponent`, `defaultErrorComponent` and `defaultNotFoundComponent` in the object passed to createRouter, so every route shows the app's own loading, failure and not-found screens.",
    },
  },
  create(context) {
    const imports = importsFrom(context.sourceCode.ast, SOURCES);
    return {
      CallExpression(call) {
        if (importedCallee(call, imports) !== "createRouter") return;
        const options = call.arguments[0];
        const missing = REQUIRED.filter((key) => !setsOption(context.sourceCode, options, key)).map(
          (key) => `\`${key}\``,
        );
        if (missing.length === 0) return;
        context.report({ node: call, messageId: "missing", data: { missing: missing.join(", ") } });
      },
    };
  },
};
