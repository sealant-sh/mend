import { readFileSync } from "node:fs";
import * as path from "node:path";

import ts from "@typescript/typescript6";

const codeFile = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const scope = (node) => {
  while (node.parent && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent;
  return node;
};

/** Syntax-only audit, never executes a test. Resolves literal paths, local constants,
 * import.meta, cwd, path joins and URL constructors; unknown template parts become globs.
 * Dynamic runtime paths and code embedded in strings still need the documented manual audit.
 */
export const sourceReferences = (source, filename, packageRoot) => {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = declarations.get(node.name.text) ?? [];
      entries.push(node);
      declarations.set(node.name.text, entries);
    }
  });
  const value = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return undefined;
    const next = new Set([...seen, node]);
    const get = (child) => value(child, next);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return (
        node.head.text +
        node.templateSpans.map((span) => (get(span.expression) ?? "*") + span.literal.text).join("")
      );
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "__dirname") return path.dirname(filename);
      if (node.text === "__filename") return filename;
      const candidates = declarations.get(node.text) ?? [];
      for (let parent = node; parent; parent = parent.parent) {
        const declaration = candidates.find((candidate) => scope(candidate) === parent);
        if (declaration) return get(declaration.initializer);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(tree);
      if (text === "import.meta.dirname") return path.dirname(filename);
      if (text === "import.meta.filename" || text === "import.meta.url") return filename;
      if (["pathname", "href"].includes(node.name.text)) return get(node.expression);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return get(node.expression);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = node.expression.getText(tree);
      const args = node.arguments ?? [];
      if (name === "process.cwd") return packageRoot;
      if (name === "URL" && args.length === 2) {
        const relative = get(args[0]);
        const base = get(args[1]);
        if (relative !== undefined && base?.startsWith("/")) {
          const result = path.resolve(base.endsWith("/") ? base : path.dirname(base), relative);
          return /(?:\/|\.)$/.test(relative) ? result + "/" : result;
        }
      }
      if (/^(?:(?:path|posix)\.)?(?:join|resolve)$/.test(name)) {
        const first = get(args[0]);
        if (first?.startsWith("/"))
          return path.resolve(first, ...args.slice(1).map((arg) => get(arg) ?? "*"));
      }
      if (/^(?:path\.)?dirname$/.test(name)) {
        const arg = get(args[0]);
        if (arg?.startsWith("/")) return path.dirname(arg);
      }
      if (/^(?:(?:fs|url)\.)?(?:fileURLToPath|realpathSync)$/.test(name)) return get(args[0]);
    }
    return undefined;
  };
  const paths = new Set();
  const imports = new Set();
  const binaries = new Set();
  walk(tree, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const resolved = value(node);
      if (resolved?.startsWith("/")) paths.add(path.normalize(resolved));
      const name = node.expression.getText(tree);
      if (/^(?:fs\.)?(?:readFile|readFileSync|readdir|readdirSync|open|openSync)$/.test(name)) {
        const input = value(node.arguments?.[0]);
        if (input !== undefined) paths.add(path.resolve(packageRoot, input));
      }
      if (/^(?:chromium|firefox|webkit)\.launch$/.test(name)) binaries.add(name.split(".")[0]);
      if (/^(?:(?:cp|child_process)\.)?(?:spawn|spawnSync|execFile|execFileSync)$/.test(name)) {
        const executable = value(node.arguments?.[0]);
        if (
          executable &&
          !executable.includes("*") &&
          !["node", process.execPath].includes(executable)
        )
          binaries.add(executable);
      }
      if (name === "import" && ts.isStringLiteral(node.arguments?.[0]))
        imports.add(node.arguments[0].text);
    }
  });
  return { paths: [...paths], imports: [...imports], binaries: [...binaries] };
};

/** Follow local imports and executable source fixtures, including root scripts read by tests.
 * Workspace imports are already represented by Turbo's dependency graph.
 */
export const testInputAudit = (repository, files, packages) => {
  const absoluteFiles = files.map((file) => path.join(repository, file));
  const tracked = new Set(absoluteFiles);
  const parsed = new Map();
  return packages.map((directory) => {
    const root = path.join(repository, directory);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const scripts = ["pretest", "test", "posttest"]
      .map((name) => manifest.scripts?.[name] ?? "")
      .join(" ");
    const queue = absoluteFiles.filter(
      (file) =>
        file.startsWith(root + "/") &&
        codeFile.test(file) &&
        (/(?:\.(?:test|spec)\.|\/test\/|vitest\.config\.)/.test(file) ||
          scripts.includes(path.relative(root, file))),
    );
    const visited = new Set();
    const references = new Map();
    const binaries = new Map();
    const enqueue = (file, from) => {
      if (!file.startsWith(root + "/"))
        references.set(path.relative(repository, file), path.relative(repository, from));
      if (codeFile.test(file) && !visited.has(file)) queue.push(file);
    };
    // The test command itself can load files outside the package, such as a reporter passed as
    // `--test-reporter=../../scripts/reporter.mjs`: every relative path in it is a read.
    const manifestFile = path.join(root, "package.json");
    for (const [, reference] of scripts.matchAll(/(?:^|[\s=:'"])((?:\.\.?\/)+[^\s'"]+)/g)) {
      const file = path.resolve(root, reference);
      if (tracked.has(file)) enqueue(file, manifestFile);
    }
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const key = `${directory}:${file}`;
      if (!parsed.has(key))
        parsed.set(key, sourceReferences(readFileSync(file, "utf8"), file, root));
      const result = parsed.get(key);
      for (const binary of result.binaries) binaries.set(binary, path.relative(repository, file));
      for (const specifier of result.imports) {
        if (!specifier.startsWith(".")) continue;
        const base = path.resolve(path.dirname(file), specifier);
        const resolved = [
          base,
          base.replace(/\.js$/, ".ts"),
          base + ".ts",
          base + ".tsx",
          base + "/index.ts",
        ].find((candidate) => tracked.has(candidate));
        if (resolved) enqueue(resolved, file);
      }
      for (const reference of result.paths) {
        if (tracked.has(reference)) enqueue(reference, file);
        else if (reference.includes("*")) {
          for (const candidate of absoluteFiles)
            if (path.matchesGlob(candidate, reference)) enqueue(candidate, file);
        }
      }
    }
    return {
      directory,
      filesScanned: visited.size,
      references: Object.fromEntries([...references].toSorted()),
      binaries: Object.fromEntries([...binaries].toSorted()),
    };
  });
};
