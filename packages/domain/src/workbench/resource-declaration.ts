import type { ProjectId } from "../ids.ts";
import {
  changesWhatOwnIs,
  envCollisionRefusals,
  type ResourceDefinitionInput,
  resourceDefinitionRefusals,
  type ResourceRefusal,
  type ResourceSpecDigest,
} from "./resource.ts";

/** One definition a project's settings hold, as the declaration rules read it. */
export interface SettingsDefinition {
  readonly spec: ResourceDefinitionInput;
  readonly digest: ResourceSpecDigest;
  /** How many worktrees hold it as `own`, with data of their own. */
  readonly owning: number;
}

/**
 * A project's settings as every declaration in it is decided against: the repo reads it under its
 * locks, a page from what it listed, and both ask the same rules of it.
 */
export interface ResourceSettingsState {
  readonly projectId: ProjectId;
  readonly definitions: ReadonlyArray<SettingsDefinition>;
}

/**
 * Why `spec` may not be declared under its name over what `settings` hold; empty when it may. The
 * add route answers these, the repo decides them again under its locks, and a page says them for
 * a `mend.toml` table it does not offer to add, so the three cannot disagree. The definition's own
 * rules come alone; then a new scope or preset while a worktree holds it as `own`, and an env name
 * another definition sets too.
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
  const held = settings.definitions.find((definition) => definition.spec.name === spec.name);
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
