import { ThreadId, WS_METHODS } from "@mend/t3-contracts";
import { Effect } from "effect";

import { assert, it } from "./support/effect-vitest.ts";
import { ROOT, withAssetHarness } from "./support/raw-assets.ts";

it.live(
  "one captured mint pins exact bytes, seeks and document children after the head advances",
  () =>
    withAssetHarness(
      (mend, logs) =>
        Effect.gen(function* () {
          const { rpc } = yield* mend.pair("CAPTURE");
          const files = mend.workbench.rawFiles;
          const oldId = "a".repeat(64);
          const newId = "b".repeat(64);
          for (const name of ["movie.mp4", "docs/index.html", "docs/style.css"]) {
            const file = {
              canonicalPath: name,
              bytes: Uint8Array.of(0, 255, 1, 2),
              captureId: oldId,
            };
            files.set(`worktree-session-1/${name}`, file);
            files.set(`worktree-session-1/${name}@${oldId}`, file);
          }
          const mint = (path: string, kind: "workspace-file" | "media-file") =>
            rpc[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: kind,
                threadId: ThreadId.make("session-1"),
                path: `${ROOT}/${path}`,
              },
            });
          const movie = yield* mint("movie.mp4", "media-file");
          const page = yield* mint("docs/index.html", "workspace-file");
          for (const name of ["movie.mp4", "docs/index.html", "docs/style.css"]) {
            const file = {
              canonicalPath: name,
              bytes: Uint8Array.of(3, 4, 5, 6),
              captureId: newId,
            };
            files.set(`worktree-session-1/${name}`, file);
            files.set(`worktree-session-1/${name}@${newId}`, file);
          }
          for (const url of [
            movie.relativeUrl,
            page.relativeUrl,
            page.relativeUrl.replace("index.html", "style.css"),
          ]) {
            const response = yield* mend.fetch(url);
            assert.strictEqual(response.status, 200);
            assert.deepStrictEqual(
              new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
              Uint8Array.of(0, 255, 1, 2),
            );
          }
          const range = yield* mend.fetch(movie.relativeUrl, { headers: { range: "bytes=2-3" } });
          assert.strictEqual(range.status, 206);
          assert.deepStrictEqual(
            new Uint8Array(yield* Effect.promise(() => range.arrayBuffer())),
            Uint8Array.of(1, 2),
          );
          const newest = yield* mint("movie.mp4", "media-file");
          const current = yield* mend.fetch(newest.relativeUrl);
          assert.deepStrictEqual(
            new Uint8Array(yield* Effect.promise(() => current.arrayBuffer())),
            Uint8Array.of(3, 4, 5, 6),
          );
          mend.workbench.goneWorktrees.add("worktree-session-1");
          assert.strictEqual((yield* mend.fetch(movie.relativeUrl)).status, 404);
          const telemetry = JSON.stringify([
            logs,
            mend.spans.map((span) => [span.name, [...span.attributes]]),
          ]);
          for (const needle of ["movie.mp4", "index.html", ROOT, movie.relativeUrl])
            assert.isFalse(telemetry.includes(needle));
        }),
      {},
      false,
    ),
);

it.live(
  "preparing and oversize mints are unavailable; a later mint succeeds when Mend is ready",
  () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* mend.pair("PREPARING");
          const input = {
            resource: {
              _tag: "workspace-file" as const,
              threadId: ThreadId.make("session-1"),
              path: `${ROOT}/image.png`,
            },
          };
          for (const status of [503, 413]) {
            mend.workbench.rawFiles.set("worktree-session-1/image.png", {
              canonicalPath: "image.png",
              bytes: Uint8Array.of(0, 255),
              status,
            });
            assert.strictEqual(
              (yield* Effect.flip(rpc[WS_METHODS.assetsCreateUrl](input)))._tag,
              "AssetWorkspaceAssetNotFoundError",
            );
          }
          mend.workbench.rawFiles.set("worktree-session-1/image.png", {
            canonicalPath: "image.png",
            bytes: Uint8Array.of(0, 255),
          });
          const ready = yield* rpc[WS_METHODS.assetsCreateUrl](input);
          const response = yield* mend.fetch(ready.relativeUrl);
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(
            new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
            Uint8Array.of(0, 255),
          );
        }),
      {},
      false,
    ),
);
