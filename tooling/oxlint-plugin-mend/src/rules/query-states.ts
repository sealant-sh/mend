import type { ESTree, Rule, SourceCode } from "@oxlint/plugins";

import {
  enclosingFunction,
  functionBinding,
  functionName,
  importedCallee,
  importsFrom,
  innermost,
  isFunction,
  memberName,
  type Node,
  outermost,
  readsOf,
  resolve,
  setsOption,
  within,
} from "../ast.ts";
import { emptyUsage, follow, followBinding, followList, type Usage } from "../usage.ts";

const SOURCES = new Set(["@tanstack/react-query"]);

const QUERY_HOOKS = new Set(["useQuery", "useInfiniteQuery"]);
const LIST_HOOKS = new Set(["useQueries"]);
const MUTATION_HOOKS = new Set(["useMutation"]);
const MUTATION_CACHE_HOOKS = new Set(["useMutationState", "useIsMutating"]);

const PENDING = ["isPending", "isLoading", "status"];
const ERROR = ["isError", "error", "status"];
const MUTATION_PENDING = ["isPending", "status"];
const MUTATION_ERROR = ["isError", "error", "status"];

type Kind = "query" | "mutation";

const reads = (usage: Usage, names: ReadonlyArray<string>): boolean =>
  names.some((name) => usage.props.has(name));

export const queryStates: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A query's pending and error states, and a mutation's pending and failure states, are handled wherever its data is read.",
    },
    messages: {
      queryBoth:
        "This query's pending and error states aren't handled. Switch on `status` (or read `isPending` and `isError`) and render what a person sees while it loads and when it fails, or pass the whole result to a component that renders every state.",
      queryPending:
        "This query's pending state isn't handled. Read `isPending` (or switch on `status`) and render what a person sees while it loads, or pass the whole result to a component that renders every state.",
      queryError:
        "This query's error state isn't handled. Read `isError` or `error` (or switch on `status`) and render what a person sees when it fails, pass the whole result to a component that renders every state, or set `throwOnError` so the route's error component shows it.",
      mutationBoth:
        "This mutation's pending and failure states aren't handled. Read `isPending` to disable the control or show progress while it runs, and read `error` (or pass `onError`) to show what failed.",
      mutationPending:
        "This mutation's pending state isn't read. Read `isPending` (or `status`) to disable the control or show progress while it runs, update optimistically in `onMutate`, or pass the whole mutation to a component that does.",
      mutationError:
        "This mutation's failure isn't handled. Read `error` or `isError` and show it, pass `onError` to `useMutation` or to each `mutate` call, or await `mutateAsync` inside a `try`.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    // `options` stays the hook's own options when a site is a caller of a hook that returns it.
    const sites: Array<{
      readonly call: ESTree.CallExpression;
      readonly kind: Kind;
      readonly options: Node | undefined;
    }> = [];
    const lists: Array<ESTree.CallExpression> = [];
    // Calls by plain name, to follow a function in this file that returns a query or mutation.
    const callsByName = new Map<string, Array<ESTree.CallExpression>>();
    const imports = importsFrom(sourceCode.ast, SOURCES);
    // A file that reads mutations through the cache, by key, rather than off the hook's result.
    let readsMutationCache = false;

    return {
      CallExpression(call) {
        const hook = importedCallee(call, imports);
        if (hook !== undefined && MUTATION_CACHE_HOOKS.has(hook)) readsMutationCache = true;
        if (hook !== undefined && QUERY_HOOKS.has(hook))
          sites.push({ call, kind: "query", options: call.arguments[0] });
        else if (hook !== undefined && MUTATION_HOOKS.has(hook))
          sites.push({ call, kind: "mutation", options: call.arguments[0] });
        else if (hook !== undefined && LIST_HOOKS.has(hook)) lists.push(call);
        const callee = innermost(call.callee);
        if (callee.type === "Identifier") {
          const calls = callsByName.get(callee.name) ?? [];
          calls.push(call);
          callsByName.set(callee.name, calls);
        }
      },
      "Program:exit"() {
        const followed = new Set<string>();
        const queue = [...sites];
        for (let site = queue.shift(); site !== undefined; site = queue.shift()) {
          const usage = emptyUsage();
          follow(sourceCode, site.call, usage);
          if (usage.returnedFrom !== undefined) {
            // A hook that returns the result whole: check what its callers in this file read.
            const name = functionName(usage.returnedFrom);
            if (name !== undefined && !followed.has(name)) {
              followed.add(name);
              for (const call of callsByName.get(name) ?? [])
                queue.push({ call, kind: site.kind, options: site.options });
            }
            continue;
          }
          const { options } = site;
          const messageId =
            site.kind === "query"
              ? queryProblem(sourceCode, usage, options)
              : readsMutationCache && setsOption(sourceCode, options, "mutationKey")
                ? undefined
                : mutationProblem(sourceCode, usage, options);
          if (messageId !== undefined) context.report({ node: site.call, messageId });
        }
        for (const call of lists)
          checkList(sourceCode, call, (node, messageId) => {
            context.report({ node, messageId });
          });
      },
    };
  },
};

function queryProblem(
  sourceCode: SourceCode,
  usage: Usage,
  options: Node | undefined,
): "queryBoth" | "queryPending" | "queryError" | undefined {
  if (usage.handedOver || !usage.props.has("data")) return undefined;
  const pending = reads(usage, PENDING) || setsOption(sourceCode, options, "initialData");
  const error = reads(usage, ERROR) || setsOption(sourceCode, options, "throwOnError");
  if (!pending && !error) return "queryBoth";
  if (!pending) return "queryPending";
  if (!error) return "queryError";
  return undefined;
}

function mutationProblem(
  sourceCode: SourceCode,
  usage: Usage,
  options: Node | undefined,
): "mutationBoth" | "mutationPending" | "mutationError" | undefined {
  if (usage.handedOver) return undefined;
  const triggers = usage.uses.filter((use) => use.name === "mutate" || use.name === "mutateAsync");
  // A `mutateAsync` promise handed to a component or function belongs to whatever takes it: it
  // awaits the promise, so it knows while it runs and gets the failure.
  const kept = triggers.filter(
    (use) => !(use.name === "mutateAsync" && promiseHandedOver(sourceCode, use.node)),
  );
  if (triggers.length > 0 && kept.length === 0) return undefined;
  const pending =
    reads(usage, MUTATION_PENDING) ||
    setsOption(sourceCode, options, "onMutate") ||
    builtElsewhere(sourceCode, options);
  const error =
    reads(usage, MUTATION_ERROR) ||
    setsOption(sourceCode, options, "onError") ||
    (kept.length > 0 && kept.every((use) => triggerHandlesFailure(sourceCode, use)));
  if (!pending && !error) return "mutationBoth";
  if (!pending) return "mutationPending";
  if (!error) return "mutationError";
  return undefined;
}

/**
 * Whether mutation options come, whole or spread, from a factory call or an import: an optimistic
 * writer, say, which shows the change at once in a way this rule can't read. tRPC's
 * `mutationOptions(…)` is not one; its argument is read like an inline object.
 */
function builtElsewhere(sourceCode: SourceCode, expression: Node | undefined, depth = 0): boolean {
  if (expression === undefined || depth > 6) return false;
  const node = innermost(expression);
  switch (node.type) {
    case "ObjectExpression":
      return node.properties.some(
        (property) =>
          property.type === "SpreadElement" &&
          builtElsewhere(sourceCode, property.argument, depth + 1),
      );
    case "CallExpression": {
      const callee = innermost(node.callee);
      const name =
        callee.type === "Identifier"
          ? callee.name
          : callee.type === "MemberExpression"
            ? memberName(callee)
            : undefined;
      return name !== "mutationOptions";
    }
    case "Identifier": {
      const definition = resolve(sourceCode, node)?.defs[0];
      if (definition?.node.type !== "VariableDeclarator") return true;
      return (
        definition.node.init !== null && builtElsewhere(sourceCode, definition.node.init, depth + 1)
      );
    }
    default:
      return false;
  }
}

/** The call made with a `mutate` or `mutateAsync` use, when it is called in place. */
function triggerCall(node: Node): ESTree.CallExpression | undefined {
  const self = outermost(node);
  const call = self.parent;
  return call?.type === "CallExpression" && call.callee === self ? call : undefined;
}

/** `mutate(vars, { onError })`, or `mutateAsync` inside a `try` or with a `.catch`. */
function triggerHandlesFailure(sourceCode: SourceCode, use: Usage["uses"][number]): boolean {
  const call = triggerCall(use.node);
  if (call === undefined) return false;
  if (use.name === "mutate") return setsOption(sourceCode, call.arguments[1], "onError");
  return insideTry(call) || caughtByChain(call);
}

/**
 * A `mutateAsync(…)` whose promise leaves its function (returned, or awaited outside a `try`)
 * when that function is handed to a component as a prop, or to a function as an argument.
 */
function promiseHandedOver(sourceCode: SourceCode, node: Node): boolean {
  const call = triggerCall(node);
  if (call === undefined || insideTry(call) || caughtByChain(call)) return false;
  const self = outermost(call);
  const parent = self.parent;
  const leaves =
    parent?.type === "AwaitExpression" ||
    parent?.type === "ReturnStatement" ||
    (parent?.type === "ArrowFunctionExpression" && parent.body === self);
  if (!leaves) return false;
  const fn = enclosingFunction(call);
  if (fn === undefined) return false;
  if (handedToTaker(outermost(fn))) return true;
  const binding = functionBinding(fn);
  if (binding === undefined) return false;
  const uses = readsOf(sourceCode, binding);
  return uses.length > 0 && uses.every((use) => handedToTaker(outermost(use)));
}

/** A value passed as a component's prop (not a DOM element's) or as a call's argument. */
function handedToTaker(node: Node): boolean {
  const parent = node.parent;
  if (parent?.type === "CallExpression") return parent.callee !== node;
  if (parent?.type !== "JSXExpressionContainer") return false;
  const attribute = parent.parent;
  if (attribute?.type !== "JSXAttribute") return false;
  const element = attribute.parent;
  if (element?.type !== "JSXOpeningElement") return false;
  const tag = element.name;
  return (
    tag.type === "JSXMemberExpression" || (tag.type === "JSXIdentifier" && /^[A-Z]/.test(tag.name))
  );
}

/** Inside the block of a `try` that has a `catch`, in the same function. */
function insideTry(node: Node): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (isFunction(current)) return false;
    if (current.type === "TryStatement" && current.handler !== null && within(node, current.block))
      return true;
  }
  return false;
}

/** `promise.catch(…)` or `promise.then(onDone, onFailed)`. */
function caughtByChain(call: Node): boolean {
  const member = outermost(call).parent;
  if (member?.type !== "MemberExpression" || member.computed) return false;
  const next = outermost(member).parent;
  if (next?.type !== "CallExpression" || next.callee !== outermost(member)) return false;
  if (member.property.type !== "Identifier") return false;
  return (
    member.property.name === "catch" ||
    (member.property.name === "then" && next.arguments.length >= 2)
  );
}

/**
 * `useQueries`: each element of `const [a, b] = useQueries(…)` is checked on its own; a list kept
 * whole is checked by what is read off any of its elements. With `combine`, the hook returns
 * whatever `combine` builds, which this rule can't read, so the call is not checked.
 */
function checkList(
  sourceCode: SourceCode,
  call: ESTree.CallExpression,
  report: (node: Node, messageId: "queryBoth" | "queryPending" | "queryError") => void,
): void {
  if (setsOption(sourceCode, call.arguments[0], "combine")) return;
  const self = outermost(call);
  const parent = self.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === self &&
    parent.id.type === "ArrayPattern"
  ) {
    for (const element of parent.id.elements) {
      if (element === null) continue;
      const usage = emptyUsage();
      if (element.type === "RestElement")
        for (const read of readsOf(sourceCode, element.argument))
          followList(sourceCode, read, usage);
      else followBinding(sourceCode, element, usage);
      const messageId = queryProblem(sourceCode, usage, undefined);
      if (messageId !== undefined) report(element, messageId);
    }
    return;
  }
  const usage = emptyUsage();
  followList(sourceCode, call, usage);
  const messageId = queryProblem(sourceCode, usage, undefined);
  if (messageId !== undefined) report(call, messageId);
}
