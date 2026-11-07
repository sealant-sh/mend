import { ThreadId, WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { assert, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const ROOT = "/var/lib/mend/store/project-1/repo.git";
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';
const HTML = '<!doctype html><title>Draft preview</title><link rel="stylesheet" href="style.css">';
const CSS = "body { color: blue; }";

it.live(
  "opens draft default-branch images and HTML with relative CSS before any worktree exists",
  () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "shared project");
      mend.workbench.projectVisibility.set("project-1", "shared");
      mend.workbench.addProject("private-project", "someone else's private project");
      mend.workbench.projectVisibility.set("private-project", "private");
      mend.workbench.fileContents.set(
        "project-1",
        new Map([
          ["images/logo.svg", IMAGE],
          ["docs/index.html", HTML],
          ["docs/style.css", CSS],
          ["private/secret.css", "private"],
        ]),
      );
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "DRAFT-ASSETS", {
          id: "user-2",
          name: "Grace",
          email: "grace@example.com",
        });
        const http = yield* HttpClient.HttpClient;
        for (const [name, contents, type] of [
          ["images/logo.svg", IMAGE, "image/svg+xml"],
          ["docs/index.html", HTML, "text/html; charset=utf-8"],
        ] as const) {
          const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "draft-workspace-file", cwd: ROOT, path: `${ROOT}/${name}` },
          });
          const response = yield* http.get(asset.relativeUrl);
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.headers["content-type"], type);
          assert.strictEqual(yield* response.text, contents);
          if (name === "docs/index.html") {
            const style = yield* http.get(asset.relativeUrl.replace(/index\.html$/, "style.css"));
            assert.strictEqual(style.status, 200);
            assert.strictEqual(style.headers["content-type"], "text/css");
            assert.strictEqual(yield* style.text, CSS);
            const outside = yield* http.get(
              asset.relativeUrl.replace(/index\.html$/, "../private/secret.css"),
            );
            assert.strictEqual(outside.status, 404);
          }
          mend.workbench.projectVisibility.set("project-1", "private");
          assert.strictEqual((yield* http.get(asset.relativeUrl)).status, 404);
          mend.workbench.projectVisibility.set("project-1", "shared");
          const relative = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "draft-workspace-file", cwd: ROOT, path: name },
          });
          assert.strictEqual(yield* (yield* http.get(relative.relativeUrl)).text, contents);
        }
        for (const [cwd, path] of [
          [ROOT, "/etc/hostname"],
          [ROOT, `${ROOT}/../private/index.html`],
          [ROOT, `${ROOT}/.git/config`],
          [ROOT, `${ROOT}-other/images/logo.svg`],
          [
            "/var/lib/mend/store/private-project/repo.git",
            "/var/lib/mend/store/private-project/repo.git/logo.svg",
          ],
        ] as const) {
          const refused = yield* Effect.exit(
            rpc[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "draft-workspace-file", cwd, path },
            }),
          );
          assert.isTrue(refused._tag === "Failure");
        }
        const wrongThread = yield* Effect.flip(
          rpc[WS_METHODS.assetsCreateUrl]({
            resource: {
              _tag: "workspace-file",
              threadId: ThreadId.make("nonexistent-thread"),
              path: `${ROOT}/images/logo.svg`,
            },
          }),
        );
        assert.strictEqual(wrongThread._tag, "AssetWorkspaceContextNotFoundError");
        assert.strictEqual(mend.workbench.sessions.size, 0);
        assert.strictEqual(mend.workbench.worktrees.size, 0);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
);
