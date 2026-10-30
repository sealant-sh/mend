import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const exceptions = new Map([
  ["capture-store.ts:listChains", "Capture liveness includes retained and orphaned owners."],
  ["capture-store.ts:claim", "Lease admission explicitly checks permanent removal marks."],
  ["removal-fences.ts:restore", "Restore reads and locks lifecycle state."],
  ["removal-fences.ts:takePurge", "Purge claims retained lifecycle state."],
  ["removal-fences.ts:relativesMarked", "Removal marks include retained parents."],
  ["removal-fences.ts:take", "Taking a mark refuses retained parents."],
  ["removal-fences.ts:admitsStart", "Admission checks permanent marks in every state."],
  ["projects.ts:removedById", "Removed metadata is an explicit recovery read."],
  ["projects.ts:removedForOrganization", "Removed metadata is an explicit recovery read."],
  ["projects.ts:storeClaimed", "Every state reserves its store directory."],
  ["projects.ts:confirm", "An uncertain commit must not delete a registered store in any state."],
  ["member-revocations.ts:beginRemoval", "Revocation must include retained private content."],
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
      ["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin"].includes(
        node.expression.name.text,
      ) &&
      /\bprojects\b/.test(node.arguments[0]?.getText(file) ?? "")
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
      /\b(?:FROM|JOIN)\s+projects\b/i.test(node.template.getText(file))
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

describe("default listed project reads", () => {
  it("rejects every new project query that omits the listed predicate", () => {
    const root = fileURLToPath(new URL("../src/repos/", import.meta.url));
    const found = readdirSync(root)
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => unguarded(name, readFileSync(`${root}/${name}`, "utf8")));
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
});
