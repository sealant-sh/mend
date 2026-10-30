import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const exceptions = new Map([
  [
    "packages/db/src/repos/capture-store.ts:listChains",
    "Capture liveness includes retained and orphaned owners.",
  ],
  [
    "packages/db/src/repos/capture-store.ts:claim",
    "Lease admission explicitly checks permanent removal marks.",
  ],
  ["packages/db/src/repos/removal-fences.ts:keep", "Remove moves a listed project to removed."],
  ["packages/db/src/repos/removal-fences.ts:restore", "Restore reads and locks lifecycle state."],
  ["packages/db/src/repos/removal-fences.ts:takePurge", "Purge claims retained lifecycle state."],
  [
    "packages/db/src/repos/removal-fences.ts:relativesMarked",
    "Removal marks include retained parents.",
  ],
  ["packages/db/src/repos/removal-fences.ts:take", "Taking a mark refuses retained parents."],
  [
    "packages/db/src/repos/removal-fences.ts:admitsStart",
    "Admission checks permanent marks in every state.",
  ],
  [
    "packages/db/src/repos/projects.ts:removedById",
    "Removed metadata is an explicit recovery read.",
  ],
  [
    "packages/db/src/repos/projects.ts:removedForOrganization",
    "Removed metadata is an explicit recovery read.",
  ],
  ["packages/db/src/repos/projects.ts:storeClaimed", "Every state reserves its store directory."],
  [
    "packages/db/src/repos/projects.ts:confirm",
    "An uncertain commit must not delete a registered store in any state.",
  ],
  ["packages/db/src/repos/projects.ts:remove", "Purge deletes the removed row under its mark."],
  [
    "packages/db/src/repos/member-revocations.ts:beginRemoval",
    "Revocation must include retained private content.",
  ],
  [
    "packages/db/src/repos/resources.ts:lockProject",
    "Declarations and approvals lock the row in every state; a removed project's declaration is refused.",
  ],
]);

const ownerOf = (node: ts.Node): string => {
  let parent: ts.Node | undefined = node;
  while (parent !== undefined) {
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name) &&
      parent.initializer !== undefined &&
      (parent.initializer.getText().includes("Effect.fn(") ||
        ts.isArrowFunction(parent.initializer))
    )
      return parent.name.text;
    parent = parent.parent;
  }
  return "unknown";
};

const unguarded = (name: string, source: string): ReadonlyArray<string> => {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const violations: Array<string> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      [
        "from",
        "innerJoin",
        "leftJoin",
        "rightJoin",
        "fullJoin",
        "crossJoin",
        "update",
        "delete",
      ].includes(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "projects"
    ) {
      let query: ts.Node = node;
      while (ts.isPropertyAccessExpression(query.parent) || ts.isCallExpression(query.parent))
        query = query.parent;
      const text = query.getText(file);
      const owner = `${name}:${ownerOf(node)}`;
      if (!text.includes("projectListed") && !exceptions.has(owner))
        violations.push(`${owner}:${file.getLineAndCharacterOfPosition(node.pos).line + 1}`);
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      /\b(?:FROM|JOIN|UPDATE)\s+projects\b/i.test(node.template.getText(file))
    ) {
      const owner = `${name}:${ownerOf(node)}`;
      if (!/removed_at\s+IS NULL/i.test(node.template.getText(file)) && !exceptions.has(owner))
        violations.push(`${owner}:raw SQL`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ROOTS = ["apps", "packages"];
/** The schema and its history describe every state; they read no project. */
const EXEMPT = new Set(["packages/db/src/migrations.ts", "packages/db/src/schema/workbench.ts"]);

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", "test", ".output", ".turbo"].includes(entry.name)
        ? []
        : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec|gen)\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("default listed project reads", () => {
  it("rejects every new project query in production code that omits the listed predicate", () => {
    const found = ROOTS.flatMap((root) =>
      sourceFiles(path.join(REPO_ROOT, root)).flatMap((file) => {
        const relative = path.relative(REPO_ROOT, file);
        if (EXEMPT.has(relative) || !relative.includes(`${path.sep}src${path.sep}`)) return [];
        return unguarded(relative, readFileSync(file, "utf8"));
      }),
    );
    expect(found).toEqual([]);
  });
  it("detects a missing predicate even in a file with another guarded query", () => {
    expect(
      unguarded(
        "future.ts",
        "db.select().from(projects).where(projectListed); db.select().from(projects).where(eq(projects.id, id));",
      ),
    ).toHaveLength(1);
  });
  it("detects an unguarded raw query outside the repositories", () => {
    expect(
      unguarded(
        "apps/api/src/future.ts",
        "const rows = sql`SELECT id FROM projects WHERE id = ${id}`;",
      ),
    ).toEqual(["apps/api/src/future.ts:unknown:raw SQL"]);
  });
});
