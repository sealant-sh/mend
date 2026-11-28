import { SPAN_NAMES } from "@mend/telemetry/span-names";
import type { ESTree, Rule } from "@oxlint/plugins";

import { innermost } from "../ast.ts";

/** The calls that name a span with their first argument: `Effect.fn("…")`, `withSpan("…")`. */
const NAMING_CALLS = new Set(["fn", "withSpan", "makeSpan", "makeSpanScoped", "useSpan"]);

const isTestFile = (filename: string): boolean =>
  /\.test\.[cm]?tsx?$/.test(filename) || /[\\/](?:test|tests|__tests__)[\\/]/.test(filename);

/** The literal span name `call` gives, when it names a span with one. */
function spanNameOf(call: ESTree.CallExpression): ESTree.StringLiteral | undefined {
  const callee = innermost(call.callee);
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.property.type !== "Identifier") return undefined;
  const method = callee.property.name;
  const first = call.arguments[0];
  if (first === undefined) return undefined;
  if (NAMING_CALLS.has(method)) {
    // `fn` names a span only on Effect: `Effect.fn("SessionEngine.provision")`.
    if (
      method === "fn" &&
      !(callee.object.type === "Identifier" && callee.object.name === "Effect")
    )
      return undefined;
    // `withSpan` also takes the effect first: `Effect.withSpan(work, "mend.turn.dispatch")`.
    const named = method === "withSpan" && first.type !== "Literal" ? call.arguments[1] : first;
    return named?.type === "Literal" && typeof named.value === "string" ? named : undefined;
  }
  // A tracer's own span: `tracer.span({ name: "mend.turn.first_output", … })`.
  if (method === "span" && first.type === "ObjectExpression") {
    for (const property of first.properties) {
      if (
        property.type === "Property" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "name" &&
        property.value.type === "Literal" &&
        typeof property.value.value === "string"
      )
        return property.value;
    }
  }
  return undefined;
}

export const spanName: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every span the code names has its name and words in @mend/telemetry's span catalog.",
    },
    messages: {
      unnamed:
        'Span "{{name}}" has no entry in SPAN_NAMES (packages/telemetry/src/span-names.ts). Add one: its `mend.<area>.<operation>` name and a short description of what happened.',
    },
  },
  create(context) {
    if (isTestFile(context.filename)) return {};
    return {
      CallExpression(call) {
        const literal = spanNameOf(call);
        if (literal === undefined || SPAN_NAMES[literal.value] !== undefined) return;
        context.report({ node: literal, messageId: "unnamed", data: { name: literal.value } });
      },
    };
  },
};
