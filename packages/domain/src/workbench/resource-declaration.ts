import type { ProjectId } from "../ids.ts";
import {
  changesWhatOwnIs,
  envCollisionRefusals,
  type ResourceDefinition,
  resourceDefinitionRefusals,
  type ResourceRefusal,
  type ResourceSpecDigest,
} from "./resource.ts";

/** A remembered spec and the retained own databases that constrain its replacement. */
export interface RememberedResourceSpec {
  readonly spec: ResourceDefinition;
  readonly digest: ResourceSpecDigest;
  /** How many worktrees hold it as `own`, with data of their own. */
  readonly owning: number;
}

/** Remembered specs used to validate an explicit replacement. */
export interface ResourceRememberedState {
  readonly projectId: ProjectId;
  readonly definitions: ReadonlyArray<RememberedResourceSpec>;
}

/** Definition, env collision and own-database preservation refusals for a replacement. */
export const resourceRestartRefusals = (
  remembered: ResourceRememberedState,
  spec: ResourceDefinition,
): ReadonlyArray<ResourceRefusal> => {
  const own = resourceDefinitionRefusals(spec);
  if (own.length > 0) return own;
  const others = remembered.definitions.filter((definition) => definition.spec.name !== spec.name);
  const collisions = envCollisionRefusals([...others.map((other) => other.spec), spec]).flatMap(
    ({ resource, refusal }) => (resource === spec.name ? [refusal] : []),
  );
  const held = remembered.definitions.find((definition) => definition.spec.name === spec.name);
  const owning = held !== undefined && changesWhatOwnIs(held.spec, spec) ? held.owning : 0;
  return [
    ...collisions,
    ...(owning === 0
      ? []
      : [
          {
            key: "preset",
            message:
              owning === 1
                ? `changes what own is, and 1 worktree holds @${spec.name} as own, with data of its own · keep its Postgres preset while own databases exist`
                : `changes what own is, and ${owning} worktrees hold @${spec.name} as own, with data of their own · keep its Postgres preset while own databases exist`,
          },
        ]),
  ];
};
