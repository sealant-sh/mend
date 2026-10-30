import type { ProjectId } from "../ids.ts";
import {
  changesWhatOwnIs,
  envCollisionRefusals,
  type ImageDigest,
  type ResourceDefinitionInput,
  resourceDefinitionRefusals,
  type ResourceRefusal,
  type ResourceSpecDigest,
  resourceSpecDigest,
} from "./resource.ts";

/** One definition a project's settings hold, as the approval rules read it. */
export interface SettingsDefinition {
  readonly spec: ResourceDefinitionInput;
  readonly digest: ResourceSpecDigest;
  /** The image the project's approval of this spec pins; null until a manager approves it. */
  readonly projectImage: ImageDigest | null;
  /** How many worktrees hold it as `own`, with data of their own. */
  readonly owning: number;
}

/**
 * A project's settings as every declaration and approval in it is decided against: the repo reads
 * it under its locks, a page from what it listed, and both ask the same rules of it.
 */
export interface ResourceSettingsState {
  readonly projectId: ProjectId;
  readonly definitions: ReadonlyArray<SettingsDefinition>;
}

/** Who an approval is for: the project, or a worktree, with the project it is one of (null for none). */
export type ResourceApprovalTarget =
  | { readonly kind: "project" }
  | { readonly kind: "worktree"; readonly projectId: ProjectId | null };

const heldUnder = (settings: ResourceSettingsState, name: string) =>
  settings.definitions.find((definition) => definition.spec.name === name);

/**
 * The image a worktree's approval of `spec` runs: the one the project's approval of this exact
 * spec pins (decision G4). Null until a manager approved this spec for the project.
 */
export const worktreeApprovalImage = (
  settings: ResourceSettingsState,
  spec: ResourceDefinitionInput,
): ImageDigest | null => {
  const held = heldUnder(settings, spec.name);
  return held?.digest === resourceSpecDigest(spec) ? held.projectImage : null;
};

/**
 * Why `spec` may not be declared under its name over what `settings` hold, as declaring or
 * adopting it would; empty when it may. The definition's own rules come alone; then a new scope or
 * preset while a worktree holds it as `own`, and an env name another definition sets too.
 */
export const resourceDeclarationRefusals = (
  settings: ResourceSettingsState,
  spec: ResourceDefinitionInput,
): ReadonlyArray<ResourceRefusal> => {
  const own = resourceDefinitionRefusals(spec);
  if (own.length > 0) return own;
  const others = settings.definitions.filter((definition) => definition.spec.name !== spec.name);
  const collisions = envCollisionRefusals([...others.map((other) => other.spec), spec]).flatMap(
    ({ resource, refusal }) => (resource === spec.name ? [refusal] : []),
  );
  const held = heldUnder(settings, spec.name);
  const owning = held !== undefined && changesWhatOwnIs(held.spec, spec) ? held.owning : 0;
  return [
    ...collisions,
    ...(owning === 0
      ? []
      : [
          {
            key: held?.spec.scope === spec.scope ? "preset" : "scope",
            message:
              owning === 1
                ? `changes what own is, and 1 worktree holds @${spec.name} as own, with data of its own · switch it to shared or off first`
                : `changes what own is, and ${owning} worktrees hold @${spec.name} as own, with data of their own · switch them to shared or off first`,
          },
        ]),
  ];
};

/**
 * Every refusal of approving `spec` for `target` that needs no registry, against `settings`;
 * empty when it may be approved. The approve route answers these, the repo decides them again
 * under its locks, and a page says them for what it does not offer, so the three cannot disagree.
 * Whether the reader may approve at all is `resourceActRefusal`'s.
 */
export const resourceApprovalRefusals = (
  settings: ResourceSettingsState,
  spec: ResourceDefinitionInput,
  target: ResourceApprovalTarget,
): ReadonlyArray<ResourceRefusal> => [
  ...(target.kind === "worktree" ? worktreeRefusals(settings, spec, target.projectId) : []),
  ...resourceDeclarationRefusals(settings, spec),
];

const worktreeRefusals = (
  settings: ResourceSettingsState,
  spec: ResourceDefinitionInput,
  worktreeProject: ProjectId | null,
): ReadonlyArray<ResourceRefusal> => {
  if (spec.scope !== "worktree") {
    return [
      {
        key: "worktree",
        message: `is one worktree, and @${spec.name} is a project resource, approved for the project`,
      },
    ];
  }
  if (worktreeProject !== settings.projectId) {
    return [
      {
        key: "worktree",
        message: `is not a worktree of the project that declares @${spec.name}`,
      },
    ];
  }
  return worktreeApprovalImage(settings, spec) === null
    ? [
        {
          key: "image",
          message: `is not one a manager approved for this project · a manager approves @${spec.name} for the project first`,
        },
      ]
    : [];
};
