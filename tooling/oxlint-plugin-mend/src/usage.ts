import type { SourceCode } from "@oxlint/plugins";

import {
  enclosingFunction,
  type FunctionNode,
  keyName,
  memberName,
  type Node,
  outermost,
  readsOf,
} from "./ast.ts";

/** What a file does with one hook result: `useQuery(…)`, `useMutation(…)` or a list element. */
export interface Usage {
  /** Names read off the result: `q.data`, `const { data } = q`, `q["data"]`. */
  readonly props: Set<string>;
  /** Each place a named property's value is used, to follow `mutate` and `mutateAsync`. */
  readonly uses: Array<{ readonly name: string; readonly node: Node }>;
  /** The whole result goes somewhere this rule can't follow: an argument, a prop, a property. */
  handedOver: boolean;
  /** The function that returns the whole result, when one does. */
  returnedFrom: FunctionNode | undefined;
}

export function emptyUsage(): Usage {
  return { props: new Set(), uses: [], handedOver: false, returnedFrom: undefined };
}

/** Follow every use of the value `node` evaluates to. */
export function follow(sourceCode: SourceCode, node: Node, usage: Usage): void {
  const self = outermost(node);
  const parent = self.parent;
  if (parent === null) return;
  switch (parent.type) {
    case "MemberExpression": {
      if (parent.object !== self) return;
      const name = memberName(parent);
      if (name === undefined) {
        usage.handedOver = true;
        return;
      }
      usage.props.add(name);
      usage.uses.push({ name, node: parent });
      return;
    }
    case "VariableDeclarator":
      if (parent.init === self) followBinding(sourceCode, parent.id, usage);
      return;
    case "ReturnStatement": {
      const fn = enclosingFunction(parent);
      if (fn === undefined) usage.handedOver = true;
      else usage.returnedFrom = fn;
      return;
    }
    case "ArrowFunctionExpression":
      if (parent.body === self) usage.returnedFrom = parent;
      return;
    case "ConditionalExpression":
      if (parent.test !== self) follow(sourceCode, parent, usage);
      return;
    case "LogicalExpression":
      follow(sourceCode, parent, usage);
      return;
    case "CallExpression":
      if (parent.callee !== self) usage.handedOver = true;
      return;
    // Reads that test or print the result without taking anything from it.
    case "ExpressionStatement":
    case "IfStatement":
    case "UnaryExpression":
    case "BinaryExpression":
    case "SwitchStatement":
    case "TemplateLiteral":
      return;
    // An argument, a JSX prop or child, a property value, a spread, an array element, an
    // assignment: the whole result goes on, and whatever takes it owns its states.
    default:
      usage.handedOver = true;
  }
}

/** Follow a binding a result is assigned to: `const q = …`, `const { data, error } = …`. */
export function followBinding(sourceCode: SourceCode, pattern: Node, usage: Usage): void {
  switch (pattern.type) {
    case "Identifier":
      for (const read of readsOf(sourceCode, pattern)) follow(sourceCode, read, usage);
      return;
    case "AssignmentPattern":
      followBinding(sourceCode, pattern.left, usage);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          followBinding(sourceCode, property.argument, usage);
          continue;
        }
        const name = keyName(property.key, property.computed);
        if (name === undefined) {
          usage.handedOver = true;
          continue;
        }
        usage.props.add(name);
        const value =
          property.value.type === "AssignmentPattern" ? property.value.left : property.value;
        if (value.type === "Identifier")
          for (const read of readsOf(sourceCode, value)) usage.uses.push({ name, node: read });
      }
      return;
    default:
      usage.handedOver = true;
  }
}

// Array methods whose callback gets one element at a time as its first argument.
const ELEMENT_CALLBACKS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

/**
 * Follow a list of results (`useQueries`) into `usage`, which collects what is read off any
 * element. `results[0].data`, `results.some((r) => r.isPending)`, `for (const r of results)` and
 * `const [a, b] = results` are followed; any other use hands the list over.
 */
export function followList(sourceCode: SourceCode, node: Node, usage: Usage): void {
  const self = outermost(node);
  const parent = self.parent;
  if (parent === null) return;
  switch (parent.type) {
    case "MemberExpression": {
      if (parent.object !== self) return;
      if (parent.computed) {
        follow(sourceCode, parent, usage);
        return;
      }
      const name = memberName(parent);
      if (name === "length") return;
      const call = outermost(parent).parent;
      if (
        name !== undefined &&
        ELEMENT_CALLBACKS.has(name) &&
        call?.type === "CallExpression" &&
        call.callee === outermost(parent)
      ) {
        const callback = call.arguments[0];
        if (
          (callback?.type === "ArrowFunctionExpression" ||
            callback?.type === "FunctionExpression") &&
          callback.params[0] !== undefined
        ) {
          followBinding(sourceCode, callback.params[0], usage);
          return;
        }
      }
      usage.handedOver = true;
      return;
    }
    case "VariableDeclarator":
      if (parent.init !== self) return;
      followListBinding(sourceCode, parent.id, usage);
      return;
    case "ForOfStatement": {
      if (parent.right !== self) return;
      const left = parent.left;
      if (left.type === "VariableDeclaration" && left.declarations[0] !== undefined)
        followBinding(sourceCode, left.declarations[0].id, usage);
      else usage.handedOver = true;
      return;
    }
    case "ExpressionStatement":
    case "IfStatement":
    case "UnaryExpression":
    case "BinaryExpression":
      return;
    default:
      usage.handedOver = true;
  }
}

function followListBinding(sourceCode: SourceCode, pattern: Node, usage: Usage): void {
  if (pattern.type === "Identifier") {
    for (const read of readsOf(sourceCode, pattern)) followList(sourceCode, read, usage);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element === null) continue;
      if (element.type === "RestElement") followListBinding(sourceCode, element.argument, usage);
      else followBinding(sourceCode, element, usage);
    }
    return;
  }
  usage.handedOver = true;
}
