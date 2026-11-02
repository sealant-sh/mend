import {
  ResourceArchivesRepo,
  ProjectEnvironmentRepo,
  ProjectSecretsRepo,
  SessionsRepo,
  ResourcesRepo,
  type StoredResourceInstance,
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

import { resourceRuntimeLayer } from "../../src/resources/runtime.ts";
import { ResourceTableReads } from "../../src/resources/worktree-tables.ts";

/** Real resource preparation over a scope client that holds a person's stop against use. */
export const resourcePreviewFixture = () => {
  const spec = presetDefinition({
    name: ResourceName.make("db"),
    preset: "postgres",
    version: PresetVersion.make("17"),
  });
  const imageDigest = ImageDigest.make(`sha256:${"a".repeat(64)}`);
  const definition: StoredResourceInstance = {
    id: ResourceDefinitionId.make("r-preview-db"),
    projectId: ProjectId.make("p-fixture"),
    spec,
    specDigest: resourceSpecDigest(spec),
    imageDigest,
    image: `postgres:17@${imageDigest}`,
    startedBy: "user-fixture",
    startedAt: new Date(),
    worktreeId: null,
    updatedAt: new Date(),
  };
  const control: {
    starts: number;
    uses: number;
    choice: "project" | "off";
    state: ScopeInstance["state"];
  } = {
    starts: 0,
    uses: 0,
    choice: "project",
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
        Layer.mock(ResourceArchivesRepo, { rememberVolumes: () => Effect.void }),
        Layer.mock(ResourcesRepo, {
          listForProject: () => Effect.succeed([definition]),
          bindingRows: (_, worktreeId) =>
            Effect.succeed({
              worktreeId,
              usesProjectResources: true,
              resources: [{ id: definition.id, name: "db" }],
              instances: [{ resourceId: definition.id, worktreeId: null, spec }],
              selections: [{ resourceId: definition.id, mode: control.choice }],
              ownDatabases: new Set(),
            }),
          listWithChoices: () => Effect.succeed([{ definition, choice: control.choice }]),
        }),
        Layer.mock(ProjectEnvironmentRepo, {
          snapshot: () => Effect.succeed({ revision: 0, variables: [] }),
        }),
        Layer.mock(ProjectSecretsRepo, {
          snapshot: () => Effect.succeed({ revision: 0, secrets: [] }),
        }),
        Layer.mock(ResourceTableReads, {
          forWorktree: () =>
            Effect.succeed({ kind: "absent", observed: "observed on the worktree" }),
        }),
        Layer.mock(SessionsRepo, { listForProject: () => Effect.succeed([]) }),
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
