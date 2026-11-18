import type { ESTree, Rule, SourceCode } from "@oxlint/plugins";

import { type Imports, importedCallee, importsFrom, innermost, resolve } from "../ast.ts";

const REACT = new Set(["react"]);
const EFFECTS = new Set(["useEffect", "useLayoutEffect"]);

/** The callback of a `useEffect` or `useLayoutEffect` call, when `call` is one. */
function effectCallback(
  call: ESTree.CallExpression,
  imports: Imports,
): ESTree.ArrowFunctionExpression | ESTree.Function | undefined {
  const hook = importedCallee(call, imports);
  if (hook === undefined || !EFFECTS.has(hook)) return undefined;
  const callback = call.arguments[0];
  if (callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression")
    return callback;
  return undefined;
}

export const noEffectFetch: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Data is fetched with a query or a route loader, not with fetch() inside an effect.",
    },
    messages: {
      fetch:
        "This effect fetches data, so nothing renders its pending or error state and nothing caches it. Fetch it with `useQuery` (or in the route's loader) instead.",
    },
  },
  create(context) {
    const imports = importsFrom(context.sourceCode.ast, REACT);
    const effects: Array<ESTree.ArrowFunctionExpression | ESTree.Function> = [];
    return {
      CallExpression(call) {
        const callback = effectCallback(call, imports);
        if (callback !== undefined) effects.push(callback);
        if (!isGlobalFetch(context.sourceCode, call)) return;
        const inside = context.sourceCode
          .getAncestors(call)
          .some((ancestor) => effects.some((effect) => effect === ancestor));
        if (inside) context.report({ node: call, messageId: "fetch" });
      },
    };
  },
};

function isGlobalFetch(sourceCode: SourceCode, call: ESTree.CallExpression): boolean {
  const callee = innermost(call.callee);
  if (callee.type === "Identifier")
    return callee.name === "fetch" && (resolve(sourceCode, callee)?.defs.length ?? 0) === 0;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "window" || callee.object.name === "globalThis")
  );
}

export const noStateCopyEffect: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "An effect that only copies values into state is derived data: compute it while rendering instead.",
    },
    messages: {
      copy: "This effect only copies values into state, so for one render the screen shows the old value. Compute the value while rendering (with `useMemo` if it is costly), or give the component a `key` so its state resets.",
    },
  },
  create(context) {
    const imports = importsFrom(context.sourceCode.ast, REACT);
    return {
      CallExpression(call) {
        const callback = effectCallback(call, imports);
        const deps = call.arguments[1];
        if (callback === undefined || deps?.type !== "ArrayExpression") return;
        if (deps.elements.length === 0) return;
        const statements =
          callback.body?.type === "BlockStatement"
            ? callback.body.body
            : callback.body === null || callback.body === undefined
              ? []
              : [callback.body];
        if (statements.length === 0) return;
        const onlySetters = statements.every((statement) => {
          const expression =
            statement.type === "ExpressionStatement" ? statement.expression : statement;
          return (
            expression.type === "CallExpression" &&
            isStateSetter(context.sourceCode, imports, expression.callee)
          );
        });
        if (onlySetters) context.report({ node: call, messageId: "copy" });
      },
    };
  },
};

/** `setX` from `const [x, setX] = useState(…)`. */
function isStateSetter(sourceCode: SourceCode, imports: Imports, callee: ESTree.Node): boolean {
  const node = innermost(callee);
  if (node.type !== "Identifier") return false;
  const definition = resolve(sourceCode, node)?.defs[0];
  const declarator = definition?.node;
  if (declarator?.type !== "VariableDeclarator" || declarator.id.type !== "ArrayPattern")
    return false;
  if (declarator.id.elements[1] !== definition?.name || declarator.init === null) return false;
  const init = innermost(declarator.init);
  return init.type === "CallExpression" && importedCallee(init, imports) === "useState";
}
