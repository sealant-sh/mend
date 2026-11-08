import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, StoreRefsRepo } from "@mend/db";
import { Sha } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import { SessionRepository, SessionRepositoryCapturedLive, startFromBase } from "@mend/sessions";
import { makeCaptureWorld, newWorktreeId, sh, worktreeRowFor } from "@mend/sessions/testing";
import { git, INDEX_TREE_REF, packIdxKeyOf, sha256Hex, WORKTREE_TREE_REF } from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@mend/t3-contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const BRANCH = "box5-managed-source";
const creationInput = Schema.Struct({ name: Schema.NullOr(Schema.String), base: Schema.NullOr(Schema.String) });

describe("native launch from a captured branch", () => {
  for (const startFromOrigin of [true, false]) {
    it.live(`starts the first message at the newest saved commit with startFromOrigin=${startFromOrigin}`, () =>
      Effect.gen(function* () {
        const world = makeCaptureWorld();
        yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(world.scratch, { recursive: true, force: true })));
        const sourceId = newWorktreeId();
        sh(world.work, ["checkout", "-qb", BRANCH]);
        fs.writeFileSync(path.join(world.work, "agent.txt"), "agent commit\n");
        sh(world.work, ["add", "-A"]);
        sh(world.work, ["commit", "-qm", "Agent change"]);
        const head = Sha.make(sh(world.work, ["rev-parse", "HEAD"]));
        const tree = sh(world.work, ["rev-parse", "HEAD^{tree}"]);
        const prefix = path.join(world.scratch, "closure");
        const packId = sh(world.work, ["pack-objects", "--revs", prefix], `${head}\n`);
        const pack = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.pack`));
        const idx = new Uint8Array(fs.readFileSync(`${prefix}-${packId}.idx`));
        const key = `projects/${world.project.id}/packs/${sha256Hex(pack)}`;
        fs.writeFileSync(path.join(world.work, "keep.md"), "keep this dirty\n");
        const status = sh(world.work, ["status", "--porcelain=v1"]);
        const index = fs.readFileSync(path.join(world.work, ".git/index"));
        world.worktrees.set(sourceId, worktreeRowFor(world, sourceId, BRANCH));
        // The remote has only main. Its fetch must not erase a local captured continuation.
        const origin = path.join(world.scratch, "origin.git");
        sh(world.scratch, ["clone", "--bare", world.storePath, origin]);
        sh(world.storePath, ["remote", "set-url", "origin", origin]);
        const runtime = ManagedRuntime.make(Layer.mergeAll(world.layer, SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer))));
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
        yield* Effect.promise(() => runtime.runPromise(Effect.gen(function* () {
          const captures = yield* CaptureStoreRepo;
          yield* captures.init(sourceId);
          const lease = yield* captures.claim(sourceId, "source");
          const built = buildManifest({ worktreeId: sourceId, n: 0, parent: null, epoch: lease.epoch, seq: 1, kind: "checkpoint", git: {
            packs: [key], head: `refs/heads/${BRANCH}`, refs: { [`refs/heads/${BRANCH}`]: head, [WORKTREE_TREE_REF]: tree, [INDEX_TREE_REF]: tree }, fsck: "verified",
          } });
          yield* uploadObjects(new Map([[key, pack], [packIdxKeyOf(key), idx], [built.key, built.bytes]]));
          yield* captures.register({ worktreeId: sourceId, id: built.id, n: 0, parent: null, epoch: lease.epoch, seq: 1n, kind: "checkpoint", manifestKey: built.key, sections: built.manifest.sections, gitFsck: "verified" });
          // Stale retained refs must not override the source's newest saved tip.
          yield* (yield* StoreRefsRepo).set(world.project.id, `refs/heads/${BRANCH}`, Sha.make(world.baseSha), null);
        })));
        assert.strictEqual(sh(world.storePath, ["branch", "--list", BRANCH]), "");
        const mend = yield* startFakeMend;
        mend.workbench.addProject(world.project.id, "captured source");
        mend.workbench.branches.set(world.project.id, [{ name: "main", isDefault: true }, { name: BRANCH, isDefault: false }]);
        const route = mend.workbench.route.bind(mend.workbench);
        const created = new Map<string, Sha>();
        let refreshes = 0;
        // Keep account/runtime fixtures, but run the HTTP launch's provisioning against the
        // production captured repository and real Git, rather than accepting any base string.
        mend.workbench.route = (request, response, body, accepted) => {
          if (accepted && request.method === "POST" && request.url === `/api/projects/${world.project.id}/refresh`) {
            return runtime.runPromise(git(["fetch", "origin"], world.storePath)).then(() => {
              refreshes++;
              return route(request, response, body, accepted);
            });
          }
          if (accepted && request.method === "POST" && request.url === `/api/projects/${world.project.id}/sessions`) {
            return body().then(async (payload) => {
              const input = Schema.decodeUnknownSync(creationInput)(payload);
              const id = newWorktreeId();
              const result = await runtime.runPromise(Effect.gen(function* () {
                const repo = yield* SessionRepository;
                const made = yield* repo.createWorktree(world.project.id, { id, directory: input.name ?? id, branch: `mend/wt/${id}` }, startFromBase(input.base), null);
                world.worktrees.set(id, new Worktree({ ...worktreeRowFor(world, id, made.branch), baseSha: made.baseSha, baseRef: made.baseRef }));
                if (repo.attachWorktree !== undefined) yield* repo.attachWorktree(world.project.id, id);
                const capture = yield* (yield* CaptureStoreRepo).headOf(id);
                assert.strictEqual(capture?.head?.n, 0);
                assert.strictEqual(made.baseRef, BRANCH);
                created.set(id, made.baseSha);
              }).pipe(Effect.result));
              if (result._tag === "Failure") {
                response.writeHead(422, { "content-type": "application/json" });
                response.end(JSON.stringify({ _tag: "StoreFailure", message: result.failure._tag === "GitError" ? result.failure.stderr : result.failure.message }));
                return true;
              }
              return route(request, response, async () => payload, accepted);
            });
          }
          return route(request, response, body, accepted);
        };
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, `CAPTURED-${startFromOrigin}`);
          const refs = yield* rpc[WS_METHODS.vcsListRefs]({ cwd: `/var/lib/mend/store/${world.project.id}/repo.git`, query: BRANCH, includeMatchingRemoteRefs: true });
          assert.isTrue(refs.refs.some((ref) => ref.name === BRANCH));
          const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
            commandId: CommandId.make(`captured-${startFromOrigin}`), threadId: ThreadId.make(`captured-${startFromOrigin}`), projectId: ProjectId.make(world.project.id), title: "Continue source",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }, runtimeMode: "approval-required", interactionMode: "default",
            workspaceStrategy: { type: "worktree", baseRef: BRANCH, startFromOrigin },
            initialMessage: { messageId: MessageId.make("first"), text: "Continue from the selected branch", attachments: [] },
          });
          assert.strictEqual(launched.projection.messages[0]?.text, "Continue from the selected branch");
          for (let attempt = 0; attempt < 100 && mend.workbench.launches.length === 0; attempt++) yield* Effect.sleep("10 millis");
          assert.strictEqual(mend.workbench.launches.length, 1);
          assert.deepStrictEqual([...created.values()], [head]);
          assert.strictEqual(refreshes, startFromOrigin ? 1 : 0);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
        assert.strictEqual(sh(world.storePath, ["show", `${head}:agent.txt`]), "agent commit");
        assert.strictEqual(sh(world.work, ["rev-parse", "HEAD"]), head);
        assert.strictEqual(sh(world.work, ["status", "--porcelain=v1"]), status);
        assert.deepStrictEqual(fs.readFileSync(path.join(world.work, ".git/index")), index);
      }),
    );
  }
});
