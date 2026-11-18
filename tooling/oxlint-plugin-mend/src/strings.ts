import type { ESTree, Visitor } from "@oxlint/plugins";

import type { Node } from "./ast.ts";

/**
 * Call `check` with the text of every string literal and template chunk in a file, except module
 * specifiers, where a colour or class name is never meant.
 */
export function stringVisitor(check: (node: Node, text: string) => void): Visitor {
  return {
    Literal(node: ESTree.StringLiteral) {
      if (typeof node.value !== "string") return;
      const parent = node.parent;
      if (
        parent.type === "ImportDeclaration" ||
        parent.type === "ExportNamedDeclaration" ||
        parent.type === "ExportAllDeclaration" ||
        parent.type === "ImportExpression"
      )
        return;
      check(node, node.value);
    },
    TemplateElement(node: ESTree.TemplateElement) {
      check(node, node.value.cooked ?? node.value.raw);
    },
  };
}

/** Each whitespace-separated class in a string, without its variants (`hover:`, `md:`) or `!`. */
export function utilities(text: string): ReadonlyArray<string> {
  const result: Array<string> = [];
  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    // The last `:` outside brackets ends the variants: `md:hover:text-[13px]`, `[&>svg]:size-4`.
    let depth = 0;
    let start = 0;
    for (let index = 0; index < token.length; index++) {
      const char = token[index];
      if (char === "[" || char === "(") depth++;
      else if (char === "]" || char === ")") depth--;
      else if (char === ":" && depth === 0) start = index + 1;
    }
    result.push(token.slice(start).replace(/^!|!$/g, "").replace(/^-/, ""));
  }
  return result;
}
