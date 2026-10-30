import {
  type RecipeApproval,
  recipeRefusalLine,
  type RecipeSpec,
  recipeUnapprovedLine,
  type ServiceDeclarations,
  type ServiceRecipe,
  type ServiceStartCause,
  type SetupDeclaration,
  setupRefusalsOf,
} from "@mend/domain/workbench";

import { canonicalJson, recipeDigestsOf, recipeSpecOf } from "./recipe-digest.ts";
import { type LaunchSpec, recipeLaunch } from "./service-launch.ts";

/** ADR 0013, ADR 0017 decision log 4. */
export type RecipeAuthority =
  | { readonly _tag: "Approves"; readonly by: string }
  | { readonly _tag: "RunsFile" }
  | { readonly _tag: "ApprovedOnly" };

export const recipeAuthorityOf = (
  cause: ServiceStartCause,
  ownerUserId: string | null,
): RecipeAuthority => {
  switch (cause.kind) {
    case "person":
      return ownerUserId !== null && cause.userId === ownerUserId
        ? { _tag: "Approves", by: cause.userId }
        : { _tag: "ApprovedOnly" };
    case "workspace":
      return { _tag: "RunsFile" };
    case "system":
      return { _tag: "ApprovedOnly" };
  }
};

export interface PlannedRecipe {
  readonly recipe: ServiceRecipe;
  readonly launch: LaunchSpec | null;
  readonly runs:
    | { readonly _tag: "File" }
    /** An approved-only plan's recipe that runs nothing, as its dependent's approval pinned it. */
    | { readonly _tag: "Adoption" }
    | { readonly _tag: "Approval"; readonly spec: RecipeSpec; readonly matchesFile: boolean };
}

export type PlanSetup =
  | { readonly _tag: "None" }
  | { readonly _tag: "Declared"; readonly setup: SetupDeclaration }
  | { readonly _tag: "Refused"; readonly line: string };

export type GatedPlan =
  | { readonly _tag: "Refused"; readonly message: string }
  | {
      readonly _tag: "Planned";
      readonly steps: ReadonlyArray<PlannedRecipe>;
      readonly setup: PlanSetup;
      readonly approvals: ReadonlyArray<Omit<RecipeApproval, "approvedAt">>;
    };

export const overlayApproved = <Base extends object>(base: Base, spec: RecipeSpec) => ({
  ...base,
  argv: spec.argv,
  cwd: spec.cwd,
  env: spec.env,
  depends: spec.depends.map((dependency) => dependency.name),
  source: "recipe" as const,
});

type Launched = Pick<LaunchSpec, "argv" | "cwd" | "env" | "depends">;

export const sameLaunch = (a: Launched, b: Launched): boolean =>
  canonicalJson({ argv: a.argv, cwd: a.cwd, env: a.env, depends: a.depends }) ===
  canonicalJson({ argv: b.argv, cwd: b.cwd, env: b.env, depends: b.depends });

export const recipeGraphChangedLine = (
  dependent: string,
  dependency: string,
  changedBy: "approval" | "file",
) =>
  `${dependent} · its approved version runs with a ${dependency} ${changedBy === "approval" ? "the owner has approved again" : "mend.toml has changed"} since · the owner's Start runs it`;

/** The digest a dependent's approval names for one of its dependencies. */
interface Pin {
  readonly dependent: string;
  readonly digest: string;
}

interface Chosen {
  readonly step: PlannedRecipe;
  /** What a second dependent's pin on the same recipe is checked against. */
  readonly digest: string | undefined;
  readonly dependencies: ReadonlyArray<{ readonly name: string; readonly pin: Pin | null }>;
}

/** Dependencies first, depth first in the order each step names them, each once, then `name`. */
const walkPlan = (
  name: string,
  runnable: ReadonlyMap<string, ServiceRecipe>,
  choose: (recipe: ServiceRecipe, pin: Pin | null) => Chosen | string,
): ReadonlyArray<PlannedRecipe> | string => {
  const planned = new Map<string, Chosen>();
  const visiting = new Set<string>();
  const visit = (current: string, pin: Pin | null): string | null => {
    const done = planned.get(current);
    if (done !== undefined) {
      return pin === null || done.digest === pin.digest
        ? null
        : recipeGraphChangedLine(
            pin.dependent,
            current,
            done.step.runs._tag === "Approval" ? "approval" : "file",
          );
    }
    if (visiting.has(current)) {
      return `${current} · its approved version and the file's form a cycle · the owner's Start runs it`;
    }
    const recipe = runnable.get(current);
    if (recipe === undefined) {
      return pin === null
        ? `No Service recipe named "${current}" exists in this session.`
        : `${pin.dependent} · its approved version needs ${current}, which mend.toml no longer declares · the owner's Start runs it`;
    }
    const chosen = choose(recipe, pin);
    if (typeof chosen === "string") return chosen;
    visiting.add(current);
    for (const dependency of chosen.dependencies) {
      const refused = visit(dependency.name, dependency.pin);
      if (refused !== null) return refused;
    }
    visiting.delete(current);
    planned.set(current, chosen);
    return null;
  };
  return visit(name, null) ?? [...planned.values()].map(({ step }) => step);
};

const runnableOf = (recipes: ReadonlyArray<ServiceRecipe>) =>
  new Map(
    recipes.flatMap((recipe) =>
      recipe.shadowedBy === null ? [[recipe.name, recipe] as const] : [],
    ),
  );

const refusedSetupOf = (declarations: ServiceDeclarations): string | null => {
  const refusals = setupRefusalsOf(declarations.refused);
  return refusals.length === 0 ? null : refusals.map(recipeRefusalLine).join("; ");
};

/** The owner's start and the agent's: the file as it reads now, which the owner's approves. */
const planFileStart = (
  declarations: ServiceDeclarations,
  name: string,
  approver: string | null,
): GatedPlan => {
  const steps = walkPlan(name, runnableOf(declarations.recipes), (recipe) => ({
    step: {
      recipe,
      launch: recipe.command === null ? null : recipeLaunch({ ...recipe, command: recipe.command }),
      runs: { _tag: "File" },
    },
    digest: undefined,
    dependencies: recipe.depends.map((dependency) => ({ name: dependency, pin: null })),
  }));
  if (typeof steps === "string") return { _tag: "Refused", message: steps };
  const digests = recipeDigestsOf(declarations);
  const refusedSetup = refusedSetupOf(declarations);
  return {
    _tag: "Planned",
    steps,
    setup: !steps.some((step) => step.launch !== null)
      ? { _tag: "None" }
      : refusedSetup !== null
        ? { _tag: "Refused", line: refusedSetup }
        : declarations.setup === null
          ? { _tag: "None" }
          : { _tag: "Declared", setup: declarations.setup },
    approvals:
      approver === null
        ? []
        : steps.flatMap(({ recipe }) => {
            const digest = digests.get(recipe.name);
            const spec = recipeSpecOf(recipe, declarations.setup, digests);
            return digest === undefined || spec === null
              ? []
              : [{ serviceName: recipe.name, digest, approvedBy: approver, spec }];
          }),
  };
};

/**
 * Any other start runs approvals only, as one graph: each dependency at the digest its dependent
 * was approved with, and the one `[setup]` they all name. `recipes` are read before `depends` is
 * checked, since the approved graph, not the file's, decides what runs.
 */
const planApprovedStart = (
  declarations: ServiceDeclarations,
  recipes: ReadonlyArray<ServiceRecipe>,
  name: string,
  approvals: ReadonlyMap<string, RecipeApproval>,
): GatedPlan => {
  const digests = recipeDigestsOf(declarations);
  const steps = walkPlan(name, runnableOf(recipes), (recipe, pin): Chosen | string => {
    const approval = approvals.get(recipe.name);
    const fileDigest = digests.get(recipe.name);
    if (approval === undefined) {
      if (pin !== null && fileDigest !== pin.digest) {
        return recipeGraphChangedLine(pin.dependent, recipe.name, "file");
      }
      if (recipe.command !== null) return recipeUnapprovedLine(recipe.name);
      // An adoption runs nothing and has no approval: one an approval pinned keeps its file's
      // dependencies, which its own digest, just matched, covers.
      const dependencies: Array<{ readonly name: string; readonly pin: Pin | null }> = [];
      for (const dependency of recipe.depends) {
        const digest = digests.get(dependency);
        if (pin !== null && digest === undefined) {
          return recipeGraphChangedLine(recipe.name, dependency, "file");
        }
        dependencies.push({
          name: dependency,
          pin: pin === null || digest === undefined ? null : { dependent: recipe.name, digest },
        });
      }
      return {
        step: { recipe, launch: null, runs: { _tag: "Adoption" } },
        digest: fileDigest,
        dependencies,
      };
    }
    if (pin !== null && approval.digest !== pin.digest) {
      return recipeGraphChangedLine(pin.dependent, recipe.name, "approval");
    }
    return {
      step: {
        recipe,
        launch: overlayApproved(
          { ready: recipe.ready, host: recipe.host, address: recipe.address },
          approval.spec,
        ),
        runs: {
          _tag: "Approval",
          spec: approval.spec,
          matchesFile: approval.digest === fileDigest,
        },
      },
      digest: approval.digest,
      dependencies: approval.spec.depends.map((dependency) => ({
        name: dependency.name,
        pin: { dependent: recipe.name, digest: dependency.digest },
      })),
    };
  });
  if (typeof steps === "string") return { _tag: "Refused", message: steps };
  const setups = new Map(
    steps.flatMap(({ runs }) => {
      if (runs._tag !== "Approval") return [];
      const { setup } = runs.spec;
      return [
        [setup === null ? "" : canonicalJson({ run: setup.run, inputs: setup.inputs }), setup],
      ];
    }),
  );
  const refusedSetup = refusedSetupOf(declarations);
  if (setups.size > 0 && refusedSetup !== null) {
    return {
      _tag: "Refused",
      message: `mend.toml refuses [setup], so ${name} is not started automatically: ${refusedSetup}`,
    };
  }
  if (setups.size > 1) {
    return {
      _tag: "Refused",
      message: `${name} · the approvals its start needs name different [setup] · the owner's Start runs it`,
    };
  }
  const setup = [...setups.values()][0] ?? null;
  return {
    _tag: "Planned",
    steps,
    setup: setup === null ? { _tag: "None" } : { _tag: "Declared", setup },
    approvals: [],
  };
};

export const planRecipeStart = (input: {
  readonly declarations: ServiceDeclarations;
  readonly recipesBeforeDependsCheck: ReadonlyArray<ServiceRecipe>;
  readonly name: string;
  readonly authority: RecipeAuthority;
  readonly approvals: ReadonlyMap<string, RecipeApproval>;
}): GatedPlan => {
  const { declarations, name, authority } = input;
  switch (authority._tag) {
    case "Approves":
      return planFileStart(declarations, name, authority.by);
    case "RunsFile":
      return planFileStart(declarations, name, null);
    case "ApprovedOnly":
      return planApprovedStart(
        declarations,
        input.recipesBeforeDependsCheck,
        name,
        input.approvals,
      );
  }
};
