import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

export type Node = ESTree.Node;
export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

// Wrappers that change a value's type or optionality but not the value: `q!`, `q as T`, `q?.x`.
const TRANSPARENT = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

/** The outermost node that still holds the same value as `node`, so its parent is what uses it. */
export function outermost(node: Node): Node {
  let current = node;
  while (current.parent !== null && TRANSPARENT.has(current.parent.type)) current = current.parent;
  return current;
}

/** The expression inside any type-only or optional-chain wrappers. */
export function innermost(node: Node): Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case "ChainExpression":
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSInstantiationExpression":
        current = current.expression;
        continue;
      default:
        return current;
    }
  }
}

export function isFunction(node: Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** A property's static name: `a`, `"a"` and `["a"]` are all `a`; a computed key is `undefined`. */
export function keyName(key: Node, computed: boolean): string | undefined {
  if (!computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "Literal" && typeof key.value === "number") return String(key.value);
  return undefined;
}

/** `x.name` or `x["name"]`, else `undefined`. */
export function memberName(member: ESTree.MemberExpression): string | undefined {
  if (member.type !== "MemberExpression") return undefined;
  return keyName(member.property, member.computed);
}

/** The variable a binding identifier declares. */
export function variableOf(sourceCode: SourceCode, id: Node): Variable | undefined {
  if (id.type !== "Identifier") return undefined;
  for (let scope: Scope | null = sourceCode.getScope(id); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(id.name);
    if (variable !== undefined && variable.identifiers.some((each) => each === id)) return variable;
  }
  return undefined;
}

/** The variable an identifier reads, following scopes outwards. */
export function resolve(sourceCode: SourceCode, id: Node): Variable | undefined {
  if (id.type !== "Identifier") return undefined;
  for (let scope: Scope | null = sourceCode.getScope(id); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(id.name);
    if (variable !== undefined) return variable;
  }
  return undefined;
}

/** Every read of the variable `id` declares, not counting its declaration. */
export function readsOf(sourceCode: SourceCode, id: Node): ReadonlyArray<Node> {
  const variable = variableOf(sourceCode, id);
  if (variable === undefined) return [];
  return variable.references
    .filter((reference) => reference.identifier !== id && reference.isRead())
    .map((reference) => reference.identifier);
}

/** The identifier a function is called by: its declaration's name, or the variable it is assigned to. */
export function functionBinding(fn: FunctionNode): Node | undefined {
  if (fn.type === "FunctionDeclaration" && fn.id !== null) return fn.id;
  const parent = outermost(fn).parent;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id;
  return undefined;
}

export function functionName(fn: FunctionNode): string | undefined {
  const binding = functionBinding(fn);
  return binding?.type === "Identifier" ? binding.name : undefined;
}

export function enclosingFunction(node: Node): FunctionNode | undefined {
  for (let current = node.parent; current !== null; current = current.parent)
    if (isFunction(current)) return current;
  return undefined;
}

/** Whether `inner` lies inside `outer`'s source range. */
export function within(inner: Node, outer: Node): boolean {
  return inner.range[0] >= outer.range[0] && inner.range[1] <= outer.range[1];
}

/** The names a file imports from `source`: local name to imported name, and namespace names. */
export interface Imports {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
}

export function importsFrom(program: ESTree.Program, sources: ReadonlySet<string>): Imports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || !sources.has(statement.source.value)) continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      // `import * as React` and `import React` both give `React.useEffect`.
      if (specifier.type !== "ImportSpecifier") namespaces.add(specifier.local.name);
      else if (specifier.importKind !== "type") {
        const imported = keyName(specifier.imported, false);
        if (imported !== undefined) named.set(specifier.local.name, imported);
      }
    }
  }
  return { named, namespaces };
}

/** The imported name a call's callee stands for: `useQuery`, `useQ` as `useQuery`, `RQ.useQuery`. */
export function importedCallee(call: ESTree.CallExpression, imports: Imports): string | undefined {
  const callee = innermost(call.callee);
  if (callee.type === "Identifier") return imports.named.get(callee.name);
  if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    imports.namespaces.has(callee.object.name)
  )
    return memberName(callee);
  return undefined;
}

/**
 * Whether an options expression sets `key` to something other than `false`, looking through
 * spreads, calls that take options (`trpc.x.queryOptions(input, { … })`) and `const` bindings in
 * the same file. What it can't see, such as a factory in another file, reads as unset.
 */
export function setsOption(
  sourceCode: SourceCode,
  expression: Node | undefined,
  key: string,
  depth = 0,
): boolean {
  if (expression === undefined || depth > 6) return false;
  const node = innermost(expression);
  switch (node.type) {
    case "ObjectExpression":
      return node.properties.some((property) =>
        property.type === "SpreadElement"
          ? setsOption(sourceCode, property.argument, key, depth + 1)
          : keyName(property.key, property.computed) === key &&
            !(property.value.type === "Literal" && property.value.value === false),
      );
    case "CallExpression":
      return node.arguments.some(
        (argument) =>
          argument.type !== "SpreadElement" && setsOption(sourceCode, argument, key, depth + 1),
      );
    case "Identifier": {
      const definition = resolve(sourceCode, node)?.defs[0];
      if (definition?.node.type !== "VariableDeclarator" || definition.node.init === null)
        return false;
      return setsOption(sourceCode, definition.node.init, key, depth + 1);
    }
    default:
      return false;
  }
}
