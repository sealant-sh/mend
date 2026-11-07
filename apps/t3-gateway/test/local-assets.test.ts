import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { assert, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const ROOT = "/var/lib/mend/store/project-1/repo.git";
const HTML = '<!doctype html><title>Local edits</title><link rel="stylesheet" href="style.css">';

it.live("previews a Local thread's HTML at its project-root path, including after reconnect", () =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    yield* Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "LOCAL-ASSET");
      const threadId = ThreadId.make("local-html");
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch-local-html"),
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Preview Local HTML",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      const worktree = Array.from(mend.workbench.worktrees.values())[0];
      assert.isDefined(worktree);
      if (worktree === undefined) return;
      mend.workbench.fileContents.set(
        worktree.id,
        new Map([
          ["index.html", HTML],
          ["style.css", "body { color: blue; }"],
        ]),
      );
      assert.strictEqual(
        (yield* rpc[WS_METHODS.projectsReadFile]({ cwd: ROOT, relativePath: "index.html" }))
          .contents,
        HTML,
      );
      const reconnected = yield* pairAndConnect(mend, "LOCAL-ASSET-RECONNECT");
      const http = yield* HttpClient.HttpClient;
      const physical = yield* rpc[WS_METHODS.assetsCreateUrl]({
        resource: {
          _tag: "workspace-file",
          threadId,
          path: `/var/lib/mend/store/project-1/worktrees/${worktree.directory}/index.html`,
        },
      });
      assert.strictEqual(yield* (yield* http.get(physical.relativeUrl)).text, HTML);
      for (const client of [rpc, reconnected.rpc]) {
        const asset = yield* client[WS_METHODS.assetsCreateUrl]({
          resource: { _tag: "workspace-file", threadId, path: `${ROOT}/index.html` },
        });
        const response = yield* http.get(asset.relativeUrl);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["content-type"], "text/html; charset=utf-8");
        assert.strictEqual(yield* response.text, HTML);
        const style = yield* http.get(asset.relativeUrl.replace(/index\.html$/, "style.css"));
        assert.strictEqual(style.status, 200);
        assert.strictEqual(yield* style.text, "body { color: blue; }");
      }
      for (const path of [
        "/var/lib/mend/store/project-2/repo.git/index.html",
        `${ROOT}-other/index.html`,
      ]) {
        const refused = yield* Effect.flip(
          rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "workspace-file", threadId, path },
          }),
        );
        assert.strictEqual(refused._tag, "AssetWorkspaceContextNotFoundError");
      }
      const wrongThread = yield* Effect.flip(
        rpc[WS_METHODS.assetsCreateUrl]({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("another-thread"),
            path: `${ROOT}/index.html`,
          },
        }),
      );
      assert.strictEqual(wrongThread._tag, "AssetWorkspaceContextNotFoundError");
      const traversal = yield* Effect.flip(
        rpc[WS_METHODS.assetsCreateUrl]({
          resource: {
            _tag: "workspace-file",
            threadId,
            path: `${ROOT}/../private/index.html`,
          },
        }),
      );
      assert.strictEqual(traversal._tag, "AssetWorkspaceAssetNotFoundError");
      const isolatedThread = ThreadId.make("isolated-html");
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch-isolated-html"),
        threadId: isolatedThread,
        projectId: ProjectId.make("project-1"),
        title: "Use an isolated worktree",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      const isolated = yield* Effect.flip(
        rpc[WS_METHODS.assetsCreateUrl]({
          resource: {
            _tag: "workspace-file",
            threadId: isolatedThread,
            path: `${ROOT}/index.html`,
          },
        }),
      );
      assert.strictEqual(isolated._tag, "AssetWorkspaceContextNotFoundError");
    }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  }),
);
