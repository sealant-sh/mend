import { execFileSync } from "node:child_process";
import path from "node:path";

import ts from "@typescript/typescript6";
import { parse as parseYaml } from "yaml";

const unknown = Symbol("unknown");
const absent = Symbol("absent");
const unresolved = (reason) => ({ timeoutMs: null, timeoutOrigin: null, timeoutReason: reason });
const known = (value, origin) =>
  typeof value === "number" && value >= 0 && !Number.isNaN(value)
    ? {
        timeoutMs: Number.isFinite(value) ? value : null,
        timeoutOrigin: origin,
        timeoutReason: value === 0 || value === Infinity ? "disabled" : null,
      }
    : unresolved("dynamic or invalid timeout");
const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};

// Only literals and lexical const expressions are interpreted. Calls/imports are never executed.
const evaluate = (input, env, visiting = new Set()) => {
  const node = unwrap(input);
  if (!node) return absent;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) {
    if (env.has(node.text)) {
      const binding = env.get(node.text);
      if (binding === unknown || visiting.has(binding)) return unknown;
      const expression = unwrap(binding.node);
      // const protects the binding, not object/array contents. Inline literals are supported.
      if (
        expression &&
        (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression))
      )
        return unknown;
      visiting.add(binding);
      const value = evaluate(binding.node, binding.env, visiting);
      visiting.delete(binding);
      return value;
    }
    return node.text === "Infinity" ? Infinity : unknown;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const value = evaluate(node.operand, env, visiting);
    if (typeof value !== "number") return unknown;
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return value;
    return unknown;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left, env, visiting),
      right = evaluate(node.right, env, visiting);
    if (typeof left !== "number" || typeof right !== "number") return unknown;
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return left + right;
    if (op === ts.SyntaxKind.MinusToken) return left - right;
    if (op === ts.SyntaxKind.AsteriskToken) return left * right;
    if (op === ts.SyntaxKind.SlashToken && right !== 0) return left / right;
    return unknown;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => evaluate(element, env, visiting));
    return values.includes(unknown) || values.includes(absent) ? unknown : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const values = new Map();
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression, env, visiting);
        if (spread instanceof Map) {
          if (spread.has(unknown)) {
            values.clear();
            values.set(unknown, unknown);
          }
          for (const [key, value] of spread) values.set(key, value);
        } else {
          values.clear();
          values.set(unknown, unknown);
        }
      } else {
        const name = property.name;
        const key =
          name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : unknown;
        if (key === unknown) {
          values.clear();
          values.set(unknown, unknown);
        } else
          values.set(
            key,
            ts.isPropertyAssignment(property)
              ? evaluate(property.initializer, env, visiting)
              : unknown,
          );
      }
    }
    return values;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const value = evaluate(node.expression, env, visiting);
    return value instanceof Map
      ? (value.get(node.name.text) ?? (value.has(unknown) ? unknown : absent))
      : unknown;
  }
  return unknown;
};
const propertyOf = (value, name) =>
  value instanceof Map ? (value.get(name) ?? (value.has(unknown) ? unknown : absent)) : unknown;
const timeoutOf = (node, env) => {
  if (!node) return absent;
  const value = evaluate(node, env);
  return value instanceof Map ? propertyOf(value, "timeout") : value;
};
const parse = (text, file) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
const scopeOf = (node, outer) => {
  const env = new Map(outer);
  for (const statement of node.statements ?? []) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          env.set(
            declaration.name.text,
            statement.declarationList.flags & ts.NodeFlags.Const
              ? { node: declaration.initializer, env }
              : unknown,
          );
      }
  }
  return env;
};
const callable = (expression) => {
  if (ts.isIdentifier(expression)) return { root: expression.text, modifiers: [], table: null };
  if (ts.isPropertyAccessExpression(expression)) {
    const base = callable(expression.expression);
    return base && { ...base, modifiers: [...base.modifiers, expression.name.text] };
  }
  if (ts.isCallExpression(expression)) {
    const base = callable(expression.expression);
    return base && { ...base, table: expression.arguments[0], curried: true };
  }
  return null;
};

const jsonLiteral = (value) =>
  value === null ||
  ["string", "number", "boolean"].includes(typeof value) ||
  (Array.isArray(value) && value.every(jsonLiteral));

// Deliberately narrow formatting: unsupported placeholders never produce guessed identities.
const titlesOf = (title, table) => {
  if (table === null) return [title];
  if (!Array.isArray(table)) return [];
  return table.flatMap((row) => {
    const values = Array.isArray(row) ? row : [row];
    let index = 0,
      valid = true;
    const rendered = title.replace(/%%|%[a-zA-Z#$]|\$[\w.]+/g, (token) => {
      if (token === "%%") {
        valid = false;
        return "";
      }
      if (token.startsWith("$")) {
        let value = row;
        for (const key of token.slice(1).split(".")) value = propertyOf(value, key);
        // Vitest displays strings with Chai's configurable quoting/truncation. Do not approximate.
        if (typeof value !== "number" && typeof value !== "boolean") {
          valid = false;
          return "";
        }
        return String(value);
      }
      const value = values[index++];
      if (token === "%s" && ["string", "number", "boolean"].includes(typeof value))
        return String(value);
      if (token === "%j" && jsonLiteral(value)) return JSON.stringify(value);
      valid = false;
      return "";
    });
    return valid ? [rendered] : [];
  });
};

/** Parse static registrations and inherited runner budgets without loading a test module. */
export const readTestBudgets = (text, file, defaultBudget) => {
  const source = parse(text, file),
    imports = new Map(),
    entries = [];
  if (source.parseDiagnostics.length > 0) return [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !["vitest", "@effect/vitest"].includes(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (["it", "test", "describe"].includes(name))
          imports.set(binding.name.text, {
            kind: name === "describe" ? "suite" : "test",
            effect: statement.moduleSpecifier.text === "@effect/vitest",
          });
      }
  }
  let runtimeConfig = false;
  const inspectConfig = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setConfig"
    )
      runtimeConfig = true;
    ts.forEachChild(node, inspectConfig);
  };
  inspectConfig(source);
  const walk = (container, ancestors, inherited, outer, apis, uncertain = false) => {
    const env = scopeOf(container, outer);
    for (const statement of container.statements ?? []) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
        // Helpers/loops can register cases when called. Their multiplicity and ancestry are unknown.
        const inspect = (node, environment, inFunction = false) => {
          let nested = environment;
          if (ts.isFunctionLike(node)) {
            nested = new Map(environment);
            for (const parameter of node.parameters)
              if (ts.isIdentifier(parameter.name)) nested.set(parameter.name.text, unknown);
            inFunction = true;
          }
          if (ts.isBlock(node)) nested = scopeOf(node, nested);
          const shape = ts.isCallExpression(node) ? callable(node.expression) : null;
          if (shape && apis.has(shape.root) && !nested.has(shape.root)) {
            const title = evaluate(node.arguments[0], nested);
            const titleNode = unwrap(node.arguments[0]);
            const prefix =
              typeof title === "string"
                ? title.split(/%|\$/)[0]
                : titleNode && ts.isTemplateExpression(titleNode)
                  ? titleNode.head.text
                  : "";
            entries.push({
              reportedName: null,
              possiblePrefix:
                inFunction || !prefix
                  ? ancestors.length
                    ? `${ancestors.join(" > ")} > `
                    : ""
                  : [...ancestors, prefix].join(" > "),
            });
          }
          ts.forEachChild(node, (child) => inspect(child, nested, inFunction));
        };
        inspect(statement, env);
        continue;
      }
      const call = statement.expression,
        shape = callable(call.expression),
        api = shape && apis.get(shape.root);
      if (!api || env.has(shape.root)) continue;
      if (
        shape.modifiers.some(
          (modifier) =>
            ![
              "only",
              "skip",
              "concurrent",
              "sequential",
              "each",
              "for",
              "effect",
              "live",
              "prop",
              "layer",
            ].includes(modifier),
        )
      ) {
        const title = evaluate(call.arguments[0], env);
        entries.push({
          reportedName: null,
          possiblePrefix:
            typeof title === "string"
              ? [...ancestors, title.split(/%|\$/)[0]].join(" > ")
              : ancestors.length
                ? `${ancestors.join(" > ")} > `
                : "",
        });
        continue;
      }
      const layer = api.effect && shape.modifiers.includes("layer");
      const isSuite = api.kind === "suite" || layer;
      const title = evaluate(call.arguments[0], env);
      if (typeof title !== "string") {
        entries.push({
          reportedName: null,
          possiblePrefix: ancestors.length ? `${ancestors.join(" > ")} > ` : "",
        });
        continue;
      }
      const table = shape.modifiers.some((m) => m === "each" || m === "for")
        ? evaluate(shape.table, env)
        : null;
      const titles = titlesOf(title, table);
      if (titles.length === 0)
        entries.push({
          reportedName: null,
          possiblePrefix: [...ancestors, title.split(/%|\$/)[0]].join(" > "),
        });
      const callback = call.arguments.find(
        (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
      );
      const explicit = layer
        ? absent
        : timeoutOf(call.arguments[1] === callback ? call.arguments[2] : call.arguments[1], env);
      // prop(name, arbitraries, handler, timeout) differs from ordinary Vitest signatures.
      const budgetValue = shape.modifiers.includes("prop")
        ? timeoutOf(call.arguments[3], env)
        : explicit;
      const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
      const budget =
        budgetValue === absent
          ? inherited
          : known(budgetValue, { kind: isSuite ? "suite" : "test", file, line });
      for (const name of titles) {
        if (isSuite) {
          if (!callback || !ts.isBlock(callback.body)) continue;
          const inner = new Map(env),
            innerApis = new Map(apis);
          for (const parameter of callback.parameters)
            if (ts.isIdentifier(parameter.name)) inner.set(parameter.name.text, unknown);
          if (layer && callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)) {
            inner.delete(callback.parameters[0].name.text);
            innerApis.set(callback.parameters[0].name.text, { kind: "test", effect: true });
          }
          walk(
            callback.body,
            [...ancestors, name],
            budget,
            inner,
            innerApis,
            uncertain || table !== null,
          );
        } else
          entries.push({
            reportedName: [...ancestors, name].join(" > "),
            sourceLine: line,
            budget:
              runtimeConfig || uncertain
                ? unresolved(runtimeConfig ? "runtime setConfig" : "parameterized suite context")
                : budget,
          });
      }
    }
  };
  walk(source, [], defaultBudget, new Map(), imports);
  return entries;
};

const configBudget = (text, file, fallback) => {
  const source = parse(text, file),
    env = scopeOf(source, new Map());
  if (source.parseDiagnostics.length > 0) return unresolved("config syntax unsupported");
  const exported = source.statements.find(ts.isExportAssignment);
  if (!exported) return unresolved("config export not statically supported");
  let expression = unwrap(exported.expression);
  if (ts.isCallExpression(expression)) {
    const definitions = source.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
      if (statement.moduleSpecifier.text !== "vitest/config") return [];
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements
            .filter((binding) => (binding.propertyName ?? binding.name).text === "defineConfig")
            .map((binding) => binding.name.text)
        : [];
    });
    if (
      !ts.isIdentifier(expression.expression) ||
      !definitions.includes(expression.expression.text) ||
      expression.arguments.length !== 1
    )
      return unresolved("dynamic config wrapper");
    expression = expression.arguments[0];
  }
  const config = evaluate(expression, env),
    options = propertyOf(config, "test");
  if (propertyOf(config, "plugins") !== absent)
    return unresolved("plugin configuration can alter test options");
  if (options === absent) return fallback;
  if (options === unknown || propertyOf(options, "projects") !== absent)
    return unresolved("dynamic or project config");
  const timeout = propertyOf(options, "testTimeout");
  if (timeout !== absent) return known(timeout, { kind: "config", file });
  const browser = propertyOf(options, "browser");
  if (browser === absent) return fallback;
  const enabled = propertyOf(browser, "enabled");
  if (enabled === false) return fallback;
  if (enabled === true) return known(15000, { kind: "runner-default-browser", file });
  return unresolved("dynamic browser config");
};

/** Resolve against one local immutable Git revision. No network, checkout, or config evaluation. */
export const makeSourceResolver = ({ repo, sourceRef }) => {
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let head;
  try {
    head = git("rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`).trim();
  } catch {
    return {
      head: null,
      resolve: () => ({
        ...unresolved("source revision unavailable locally"),
        identityConfidence: "unknown",
        sourceFile: null,
        sourceLine: null,
        sourceHead: null,
      }),
    };
  }
  const paths = new Set(git("ls-tree", "-r", "--name-only", head).trim().split("\n"));
  const cache = new Map();
  const read = (file) => (paths.has(file) ? git("show", `${head}:${file}`) : null);
  const projects = new Map();
  for (const file of paths)
    if (file.endsWith("package.json") && !file.includes("node_modules/")) {
      try {
        const manifest = JSON.parse(read(file));
        if (typeof manifest.name === "string")
          projects.set(
            manifest.name,
            projects.has(manifest.name)
              ? null
              : {
                  directory: path.posix.dirname(file) === "." ? "" : path.posix.dirname(file),
                  manifest,
                },
          );
      } catch {
        /* Invalid/non-project fixture manifests do not establish package identity. */
      }
    }
  const workspace = read("pnpm-workspace.yaml");
  const catalog = workspace === null ? {} : parseYaml(workspace);
  const defaults = (project, command) => {
    const task = command ?? project.manifest.scripts?.test;
    if (
      typeof task !== "string" ||
      !/^vitest(?:\s|$)/.test(task) ||
      /[;&|`$\n]|--(?:workspace|project|root)\b/.test(task)
    )
      return unresolved("unsupported package test command");
    const version =
      project.manifest.devDependencies?.vitest ?? project.manifest.dependencies?.vitest;
    const resolvedVersion =
      typeof version === "string" && version.startsWith("catalog:")
        ? version === "catalog:"
          ? catalog?.catalog?.vitest
          : catalog?.catalogs?.[version.slice(8)]?.vitest
        : version;
    let budget =
      typeof resolvedVersion === "string" && /^[~^]?(?:3|5)\./.test(resolvedVersion)
        ? known(5000, { kind: "runner-default", version: resolvedVersion })
        : unresolved("runner default version unknown");
    const explicitConfig = /--config(?:=|\s+)([\w./-]+)/.exec(task);
    if (/--config\b/.test(task) && !explicitConfig) return unresolved("dynamic config path");
    const candidates = explicitConfig
      ? [path.posix.join(project.directory, explicitConfig[1])]
      : ["vitest", "vite"].flatMap((name) =>
          ["ts", "mts", "js", "mjs"].map((extension) =>
            path.posix.join(project.directory, `${name}.config.${extension}`),
          ),
        );
    const config = candidates.find((file) => paths.has(file));
    if (explicitConfig && !config) return unresolved("config unavailable at source ref");
    if (config) budget = configBudget(read(config), config, budget);
    else if (
      project.directory &&
      [...paths].some((file) =>
        /^(?:vitest|vite)\.config\.[cm]?[jt]s$|^vitest\.workspace\./.test(file),
      )
    )
      budget = unresolved("root configuration requires project resolution");
    const cliTimeout = /--testTimeout(?:=|\s+)(\d+(?:\.\d+)?)(?=\s|$)/.exec(task);
    if (/--testTimeout\b/.test(task))
      budget = cliTimeout
        ? known(Number(cliTimeout[1]), { kind: "cli", command: task })
        : unresolved("dynamic CLI timeout");
    return budget;
  };
  return {
    head,
    resolve: ({ package: packageName, file, reportedName, command }) => {
      const project = projects.get(packageName);
      if (!project || !file || path.posix.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        return {
          ...unresolved("source package/file unknown"),
          identityConfidence: "unknown",
          sourceFile: null,
          sourceLine: null,
          sourceHead: head,
        };
      const sourceFile = path.posix.join(project.directory, file);
      const key = `${sourceFile}\0${command ?? ""}`;
      if (!cache.has(key)) {
        const text = read(sourceFile);
        cache.set(
          key,
          text === null ? [] : readTestBudgets(text, sourceFile, defaults(project, command)),
        );
      }
      const matches = cache.get(key).filter((entry) => entry.reportedName === reportedName);
      const dynamicCollision = cache
        .get(key)
        .some(
          (entry) => entry.reportedName === null && reportedName.startsWith(entry.possiblePrefix),
        );
      const exact = matches.length === 1 && !dynamicCollision;
      return {
        ...(exact
          ? matches[0].budget
          : unresolved(
              dynamicCollision
                ? "possible dynamic identity collision"
                : matches.length > 1
                  ? "ambiguous duplicate identity"
                  : "static registration not uniquely matched",
            )),
        identityConfidence: exact ? "exact-static" : "unknown",
        sourceFile,
        sourceLine: exact ? matches[0].sourceLine : null,
        sourceHead: head,
      };
    },
  };
};

/** Cached/unknown/disabled budgets cannot establish present CI timeout headroom. */
export const withHeadroom = (observation, resolution) => {
  const assessmentReason = observation.cached
    ? "cached replay"
    : observation.status === "skipped"
      ? "skipped test"
      : observation.reportedDurationMs === null
        ? "duration unobserved"
        : (resolution.timeoutReason ?? (resolution.timeoutMs > 0 ? null : "timeout unknown"));
  const usable = assessmentReason === null;
  return {
    ...observation,
    ...resolution,
    assessmentReason,
    ratio: usable ? observation.reportedDurationMs / resolution.timeoutMs : null,
    headroomMs: usable ? resolution.timeoutMs - observation.reportedDurationMs : null,
    atLeastHalfTimeout: usable
      ? observation.reportedDurationMs >= resolution.timeoutMs * 0.5
      : null,
  };
};
