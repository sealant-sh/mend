import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

/** One entry per query (`queryKey`): a new query, or an edit to one, is judged again. */
const exceptions = new Map([
  [
    "packages/db/src/repos/capture-store.ts:claim:e6e99d48",
    "Lease admission explicitly checks permanent removal marks.",
  ],
  [
    "packages/db/src/repos/capture-store.ts:publishObservedSummary:e03803ea",
    "A removed project is read to refuse it a published summary.",
  ],
  [
    "packages/db/src/repos/capture-store.ts:uploadAdmitted:f316d0a6",
    "A removed project is read to refuse it new upload URLs.",
  ],
  [
    "packages/db/src/repos/capture-store.ts:condemnForPurge:3935d85e",
    "Only a removed project's purge mark authorizes the condemnation.",
  ],
  [
    "packages/db/src/repos/member-revocations.ts:beginRemoval:8efe8152",
    "Revocation must include retained private content.",
  ],
  [
    "packages/db/src/repos/projects.ts:removedById:b685272a",
    "Removed metadata is an explicit recovery read.",
  ],
  [
    "packages/db/src/repos/projects.ts:removedForOrganization:2fb7923f",
    "Removed metadata is an explicit recovery read.",
  ],
  [
    "packages/db/src/repos/projects.ts:storeClaimed:a538c2ed",
    "Every state reserves its store directory.",
  ],
  [
    "packages/db/src/repos/projects.ts:confirm:6e3f79ca",
    "An uncertain commit must not delete a registered store in any state.",
  ],
  [
    "packages/db/src/repos/projects.ts:setCreatedBy:b4ed897b",
    "An owner takes over a departed member's project in every state, removed ones included.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:lockMembership:65feea34",
    "Lifecycle changes lock the person's membership in every state.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:audited:9b413ca6",
    "Each lifecycle change records its entry.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:keep:694132d1",
    "Remove moves a listed project to removed.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:keep:f0dc3512",
    "Remove moves a listed project to removed.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:restore:ae83b8ac",
    "Restore reads and locks lifecycle state.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:takePurge:c701ff29",
    "Purge claims retained lifecycle state.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:takePurge:b1af04df",
    "Purge claims retained lifecycle state.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:finishPurge:a68bb8b1",
    "Purge deletes the removed row under its own mark.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:finishPurge:af372624",
    "Purge deletes the removed row under its own mark.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:relativesMarked:df857b56",
    "Removal marks include retained parents.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:take:e2ea693e",
    "Taking a mark refuses retained parents.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:take:be10131c",
    "Taking a mark refuses retained parents.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:take:5d4e2e26",
    "Taking a mark refuses retained parents.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:take:678a0d5e",
    "Taking a mark refuses retained parents.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:renew:b3b8524f",
    "A purge renews its mark on the removed row.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:release:6c94c554",
    "Only a listed project's checking mark is released; the row is read in every state to say so.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:handOver:94eb9cf1",
    "A stopped purge hands its mark over on the removed row.",
  ],
  [
    "packages/db/src/repos/removal-fences.ts:admitsStart:4bce7293",
    "Admission checks permanent marks in every state.",
  ],
  [
    "packages/db/src/repos/resources.ts:fence:766879ce",
    "Declarations lock the row in every state; a removed project's declaration is refused.",
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

/**
 * One query, as an exception names it: its function and a hash of its text. An exception covers
 * that query only, so a query added beside it, or an edit to it, is judged again.
 */
const queryKey = (name: string, node: ts.Node, file: ts.SourceFile) =>
  `${name}:${ownerOf(node)}:${createHash("sha256")
    .update(node.getText(file).replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 8)}`;

/**
 * Raw SQL that reads or writes projects: by name, as the interpolated schema table, or through a
 * table it names only when it runs (`${sql(tableOf(row))}`).
 */
const rawProjects = (tables: ReadonlySet<string>) =>
  new RegExp(
    `\\b(?:FROM|JOIN|UPDATE)\\s+(?:projects\\b|\\$\\{\\s*(?:sql\\(|(?:${[...tables].join("|")})\\s*\\}))`,
    "i",
  );
const DRIZZLE_READS = [
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
  "update",
  "delete",
];

const unguarded = (name: string, source: string): ReadonlyArray<string> => {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const violations: Array<string> = [];
  // The schema's `projects`, under whatever name a file imports it.
  const tables = new Set(["projects"]);
  for (const statement of file.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if ((element.propertyName ?? element.name).text === "projects")
          tables.add(element.name.text);
  }
  const raw = rawProjects(tables);
  const judge = (query: ts.Node, listed: boolean) => {
    const key = queryKey(name, query, file);
    if (!listed && !exceptions.has(key)) violations.push(key);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DRIZZLE_READS.includes(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      tables.has(node.arguments[0].text)
    ) {
      let query: ts.Node = node;
      while (ts.isPropertyAccessExpression(query.parent) || ts.isCallExpression(query.parent))
        query = query.parent;
      judge(query, query.getText(file).includes("projectListed"));
    }
    // `db.query.projects…`: the relational API reads the table too.
    if (
      ts.isPropertyAccessExpression(node) &&
      tables.has(node.name.text) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    )
      judge(node, false);
    if (ts.isTaggedTemplateExpression(node) && raw.test(node.template.getText(file)))
      judge(node, /removed_at\s+IS NULL/i.test(node.template.getText(file)));
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "unsafe" &&
      node.arguments[0] !== undefined &&
      raw.test(node.arguments[0].getText(file))
    )
      judge(node, /removed_at\s+IS NULL/i.test(node.arguments[0].getText(file)));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
/** Declared as this package's test inputs in packages/db/turbo.json. */
const ROOTS = [path.join(REPO_ROOT, "apps"), path.join(REPO_ROOT, "packages")];
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
      sourceFiles(root).flatMap((file) => {
        const relative = path.relative(REPO_ROOT, file);
        if (EXEMPT.has(relative) || !relative.includes(`${path.sep}src${path.sep}`)) return [];
        return unguarded(relative, readFileSync(file, "utf8"));
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);
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
    ).toEqual([expect.stringMatching(/^apps\/api\/src\/future\.ts:unknown:[0-9a-f]{8}$/)]);
  });
  it("detects raw SQL through unsafe, a table named at run time, the relational API and an alias", () => {
    expect(
      unguarded(
        "future.ts",
        [
          'import { projects as p } from "../schema/workbench.ts";',
          'const a = () => sql.unsafe("SELECT id FROM projects");',
          "const b = () => sql`UPDATE ${sql(table)} SET name = ${name}`;",
          "const c = () => db.query.projects.findMany();",
          "const d = () => db.select().from(p).where(eq(p.id, id));",
        ].join("\n"),
      ),
    ).toHaveLength(4);
  });
  it("names each query apart, so an exception never covers one added beside it", () => {
    const [first] = unguarded(
      "future.ts",
      "const read = () => db.select().from(projects).where(eq(projects.id, id));",
    );
    const [second] = unguarded(
      "future.ts",
      "const read = () => db.select().from(projects).where(eq(projects.name, name));",
    );
    expect(first).toMatch(/^future\.ts:read:[0-9a-f]{8}$/);
    expect(second).not.toEqual(first);
  });
});
