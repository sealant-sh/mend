import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  SourceControlProviderKind,
  WS_METHODS,
} from "@mend/t3-contracts";
import { Effect, Option, Stream } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("project operations over the paired WebSocket", () => {
  it.live("adopts a private GitHub picker selection through the person's SSH access", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PRIVATE", undefined, undefined, "0.1.2");
          const repository = yield* rpc[WS_METHODS.sourceControlLookupRepository]({
            provider: SourceControlProviderKind.make("github"),
            repository: "alice/private-repo",
          });
          const result = yield* rpc[WS_METHODS.sourceControlCloneRepository]({
            remoteUrl: repository.url,
            destinationPath: "/client/private-repo",
          });
          assert.strictEqual(repository.url, "https://github.com/alice/private-repo");
          assert.strictEqual(result.remoteUrl, "git@github.com:alice/private-repo.git");
          assert.deepStrictEqual(
            mend.workbench.calls
              .filter((c) => c.path === "/api/projects" && c.method === "POST")
              .map((c) => ({ body: c.body, authorization: c.authorization })),
            [
              {
                body: {
                  name: "private-repo",
                  source: "git@github.com:alice/private-repo.git",
                  visibility: "private",
                },
                authorization: `Bearer ${mend.claims[0]?.token}`,
              },
            ],
          );
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
  it.live("adopts and renames with the person's device token, returning the managed project", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PROJECTS", undefined, undefined, "0.1.2");
          const cloned = yield* rpc[WS_METHODS.sourceControlCloneRepository]({
            remoteUrl: "https://github.com/alice/repo.git",
            destinationPath: "/client/checkout/repo",
          });
          const opened = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
          if (opened.kind !== "snapshot") throw new Error("expected a shell snapshot");
          const shell = opened.snapshot;
          const project = shell.projects.find((p) => p.workspaceRoot === cloned.cwd);
          assert.isDefined(project);
          if (project === undefined) return;
          const renamed = yield* rpc[WS_METHODS.projectsMutate]({
            type: "project.update",
            projectId: project.id,
            commandId: CommandId.make("rename-over-ws"),
            title: "renamed",
          });
          assert.strictEqual(renamed.title, "renamed");
          assert.strictEqual(renamed.id, project.id);
          assert.strictEqual(renamed.workspaceRoot, cloned.cwd);
          assert.deepStrictEqual(
            mend.workbench.calls
              .filter((c) => c.method === "POST")
              .map((c) => ({ path: c.path, body: c.body, authorization: c.authorization })),
            [
              {
                path: "/api/projects",
                body: {
                  name: "repo",
                  source: "https://github.com/alice/repo.git",
                  visibility: "private",
                },
                authorization: `Bearer ${mend.claims[0]?.token}`,
              },
              {
                path: `/api/projects/${project.id}/name`,
                body: { name: "renamed" },
                authorization: `Bearer ${mend.claims[0]?.token}`,
              },
            ],
          );
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
