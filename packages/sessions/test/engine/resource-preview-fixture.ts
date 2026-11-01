import {
  ProjectEnvironmentRepo,
  ProjectSecretsRepo,
  ResourcesRepo,
  type StoredResourceDefinition,
} from "@mend/db";
import { ProjectId, ResourceDefinitionId } from "@mend/domain";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  ResourceName,
  resourceSpecDigest,
} from "@mend/domain/workbench";
import { ResourceScopes, type ScopeInstance } from "@mend/sealant";
import { Duration, Effect, Layer } from "effect";

import { ResourceImageResolver } from "../../src/resources/image-resolver.ts";
import { resourceRuntimeLayer } from "../../src/resources/runtime.ts";
import { WorktreeReads, WORKTREE_STAMP } from "../../src/worktree-reads.ts";

/** Real resource preparation over a scope client that holds a person's stop against use. */
export const resourcePreviewFixture = () => {
  const spec = presetDefinition({
    name: ResourceName.make("db"),
    preset: "postgres",
    version: PresetVersion.make("17"),
    scope: "project",
  });
  const imageDigest = ImageDigest.make(`sha256:${"a".repeat(64)}`);
  const definition: StoredResourceDefinition = {
    id: ResourceDefinitionId.make("r-preview-db"),
    projectId: ProjectId.make("p-fixture"),
    spec,
    specDigest: resourceSpecDigest(spec),
    imageDigest,
    image: `postgres:17@${imageDigest}`,
    addedBy: "user-fixture",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const control: {
    starts: number;
    uses: number;
    choice: "shared" | "off";
    state: ScopeInstance["state"];
  } = {
    starts: 0,
    uses: 0,
    choice: "shared",
    state: { kind: "stopped", at: new Date(), reason: { kind: "idle" } },
  };
  const instance = (): ScopeInstance => ({
    id: "scope-instance",
    key: definition.id,
    alias: "db",
    worktreeKey: null,
    specDigest: "digest",
    desired: control.state.kind === "stopped" ? "stopped" : "running",
    stopReason: control.state.kind === "stopped" ? control.state.reason : null,
    state: control.state,
    observedAt: new Date(),
    startedAt: null,
    lastReachedAt: null,
    volumes: [],
  });
  const layer = resourceRuntimeLayer(Duration.seconds(1)).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ResourcesRepo, {
          listWithChoices: () => Effect.succeed([{ definition, choice: control.choice }]),
        }),
        Layer.mock(ProjectEnvironmentRepo, {
          snapshot: () => Effect.succeed({ revision: 0, variables: [] }),
        }),
        Layer.mock(ProjectSecretsRepo, {
          snapshot: () => Effect.succeed({ revision: 0, secrets: [] }),
        }),
        Layer.mock(WorktreeReads, {
          readFile: () => Effect.succeed({ value: null, stamp: WORKTREE_STAMP }),
        }),
        Layer.mock(ResourceImageResolver, {}),
        Layer.succeed(ResourceScopes, {
          of: () =>
            Effect.succeed({
              id: "scope-preview",
              up: () =>
                Effect.sync(() => {
                  control.uses += 1;
                  if (control.state.kind === "stopped" && control.state.reason.kind === "person")
                    return instance();
                  if (control.state.kind !== "running") control.starts += 1;
                  control.state = { kind: "running", since: new Date() };
                  return instance();
                }),
              get: () => Effect.sync(instance),
              list: () => Effect.sync(() => [instance()]),
              link: () => Effect.void,
              stop: () => Effect.die("not used here"),
              exec: () => Effect.die("not used here"),
              archiveScope: () => Effect.succeed([]),
              archive: () => Effect.succeed([]),
            }),
        }),
      ),
    ),
  );
  return { layer, control };
};
