import { Agent, get } from "node:http";

import { ProofArtifactId, SessionId } from "@mend/domain";
import { ProofRef } from "@mend/domain/workbench";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ThreadProjection,
} from "@mend/t3-contracts";
import { Duration, Effect, Exit, Schema } from "effect";

import { ASSET_URL_TTL_MS } from "../src/assets.ts";
import { requiredScopesFor } from "../src/rpc-scopes.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { ROOT, withAssetHarness } from "./support/raw-assets.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { applyOrchestrationV2ProjectionEvent } from "./support/upstream/steering-client.mjs";

const THREAD = ThreadId.make("session-1");
const ID = ProofArtifactId.make("c57e0440-1ef8-4f54-9c63-f4c8ef64f41c");
const LABEL = "Completed task on board · before · base 1a2b3c4 · observed 14:02 UTC";
const CAPTION = "The completed task is visible in the Done column.";
const BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
const reference = (patch: Partial<ProofRef> = {}) =>
  new ProofRef({
    artifactId: ID,
    sessionId: SessionId.make("session-1"),
    title: "Completed task on board",
    caption: CAPTION,
    kind: "screenshot",
    side: "before",
    label: LABEL,
    state: "stored",
    mimeType: "image/png",
    ...patch,
  });
const expectedProofText = (ref: ProofRef) =>
  `${ref.label}\n\n${ref.caption}${ref.state === "stored" ? `\n\n![](/mend-proof/${ref.artifactId}.${ref.kind === "video" ? "mp4" : "png"})` : ""}`;
const encoded = Schema.encodeSync(ProofRef);
const resource = (extension = "png", kind: "media-file" | "workspace-file" = "media-file") => ({
  _tag: kind,
  threadId: THREAD,
  path: `/mend-proof/${ID}.${extension}`,
});

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const assertProofMessage = (
  item: OrchestrationV2TurnItem | undefined,
  id: string,
  text: string,
) => {
  if (item?.type !== "assistant_message") throw new Error("Expected a proof assistant message");
  assert.strictEqual(item.id, id);
  assert.strictEqual(item.messageId, `message:${id}`);
  assert.strictEqual(item.text, text);
  assert.isFalse(item.streaming);
  assert.isNull(item.runId);
  assert.isNull(item.nodeId);
};

describe("proof in the session's T3 Code thread", () => {
  it.live(
    "projects stored images and video, recording and missing captures as labelled assistant Markdown",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = mend.workbench.addTurn("session-1", "Capture the board", "completed");
          mend.workbench.addItem(turn, { kind: "assistant-message", text: "Capturing the app." });
          const videoLabel = "Completed task on board · after · checkpoint #2 · observed 14:03 UTC";
          const recordingLabel =
            "Completed task on board · after · checkpoint #2 · recording · observed 14:03 UTC";
          const missingLabel =
            "Completed task on board · before · source unknown · not captured · base does not run";
          const cases = [
            { ref: reference(), text: `${LABEL}\n\n${CAPTION}\n\n![](/mend-proof/${ID}.png)` },
            {
              ref: reference({
                kind: "video",
                side: "after",
                mimeType: "video/mp4",
                label: videoLabel,
              }),
              text: `${videoLabel}\n\n${CAPTION}\n\n![](/mend-proof/${ID}.mp4)`,
            },
            {
              ref: reference({
                kind: "video",
                side: "after",
                state: "recording",
                mimeType: null,
                label: recordingLabel,
              }),
              text: `${recordingLabel}\n\n${CAPTION}`,
            },
            {
              ref: reference({ state: "not-captured", mimeType: null, label: missingLabel }),
              text: missingLabel,
            },
          ];
          const items = cases.map(({ ref }) =>
            mend.workbench.addItem(turn, {
              kind: "proof",
              data: encoded(ref),
              status: ref.state === "recording" ? "in-progress" : "completed",
            }),
          );
          const malformed = mend.workbench.addItem(turn, {
            kind: "proof",
            data: { artifactId: ID },
          });
          const reply = mend.workbench.addItem(turn, {
            kind: "assistant-message",
            text: "The change is captured.",
          });
          const { rpc } = yield* pairAndConnect(mend, "PROOF");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.strictEqual(projection.runs.length, 1);
          assert.strictEqual(
            projection.messages.filter((message) => message.role === "user").length,
            1,
          );
          assert.strictEqual(
            projection.turnItems.filter((item) => item.type === "user_message").length,
            1,
          );
          for (const [index, test] of cases.entries()) {
            const id = items[index]?.id ?? "";
            assertProofMessage(
              projection.turnItems.find((item) => item.id === id),
              id,
              test.text,
            );
            const projectedMessage = projection.messages.find(
              (message) => message.id === `message:${id}`,
            );
            assert.strictEqual(projectedMessage?.role, "assistant");
            assert.strictEqual(projectedMessage?.text, test.text);
            assert.deepStrictEqual(projectedMessage?.attachments, []);
            assert.isNull(projectedMessage?.runId);
            assert.isNull(projectedMessage?.nodeId);
          }
          assert.strictEqual(
            projection.turnItems.find((item) => item.id === reply.id)?.runId,
            projection.runs[0]?.id,
          );
          assert.strictEqual(
            projection.turnItems.find((item) => item.id === malformed.id)?.type,
            "dynamic_tool",
          );
        }),
      ),
  );

  it.live(
    "keeps captures outside collapsed replies through completion, settle, stop and cold replay",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        const turn = mend.workbench.addTurn("session-1", "Capture the app");
        // Put the captures on the second /items page, as in a long agent conversation.
        for (let index = 0; index < 500; index++)
          mend.workbench.addItem(turn, { kind: "reasoning", text: `Observation ${index}` });
        const image = reference();
        const secondImage = reference({
          artifactId: ProofArtifactId.make("30610dea-2b6d-4fa2-9f2f-2a2a557a1884"),
        });
        const recording = reference({
          artifactId: ProofArtifactId.make("f31fb0fb-fbca-46ce-9f6b-3ba90ce48656"),
          kind: "video",
          state: "recording",
          mimeType: null,
        });
        const refs = [image, secondImage, recording];
        const captures = refs.map((ref) =>
          mend.workbench.addItem(turn, {
            kind: "proof",
            status: ref.state === "recording" ? "in-progress" : "completed",
            data: encoded(ref),
          }),
        );
        const check = (projection: OrchestrationV2ThreadProjection, references = refs) => {
          for (const [index, ref] of references.entries()) {
            const id = captures[index]?.id ?? "";
            const visible = projection.visibleTurnItems.filter((row) => row.sourceItemId === id);
            assert.strictEqual(visible.length, 1);
            assertProofMessage(visible[0]?.item, id, expectedProofText(ref));
            const messages = projection.messages.filter(
              (message) => message.id === `message:${id}`,
            );
            assert.strictEqual(messages.length, 1);
            assert.strictEqual(messages[0]?.text, expectedProofText(ref));
            assert.isNull(messages[0]?.runId);
            assert.isNull(messages[0]?.nodeId);
          }
        };
        const stored = reference({
          artifactId: recording.artifactId,
          kind: "video",
          mimeType: "video/mp4",
        });
        const completedRefs = [image, secondImage, stored];
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PROOF-LIFECYCLE");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
          );
          const snapshot = yield* thread.next((item) => item.kind === "snapshot");
          if (snapshot.kind !== "snapshot") throw new Error("Expected a proof snapshot");
          check(snapshot.projection);
          const video = captures[2];
          if (video === undefined) throw new Error("Expected the recording");
          let replayed = snapshot.projection;
          let sequence = snapshot.snapshotSequence;
          const readUntil = (
            accept: (
              event: Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>["event"],
            ) => boolean,
          ) =>
            Effect.gen(function* () {
              for (;;) {
                const item = yield* thread.next((candidate) => candidate.kind === "event");
                if (item.kind !== "event") throw new Error("Expected a proof event");
                replayed = applyOrchestrationV2ProjectionEvent(replayed, item.event);
                sequence = item.sequence;
                if (accept(item.event)) return;
              }
            });
          mend.workbench.updateItem(video, { status: "completed", data: encoded(stored) });
          yield* readUntil(
            (event) => event.type === "turn-item.updated" && event.payload.id === video.id,
          );
          check(replayed, completedRefs);
          const reply = mend.workbench.addItem(turn, {
            kind: "assistant-message",
            text: "The change is captured.",
          });
          yield* readUntil(
            (event) => event.type === "turn-item.updated" && event.payload.id === reply.id,
          );
          mend.workbench.setTurn(turn, "completed");
          yield* readUntil(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          );
          check(replayed, completedRefs);
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.settle",
            commandId: CommandId.make("settle-proof"),
            threadId: THREAD,
          });
          const settled = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.strictEqual(settled.thread.settledOverride, "settled");
          check(settled, completedRefs);
          assert.strictEqual(mend.workbench.sessions.get("session-1")?.status, "idle");
          assert.isNull(mend.workbench.agents.get("session-1")?.exitedAt);
          mend.workbench.stopAgent("session-1");
          const resumed = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: THREAD,
              afterSequence: sequence,
            }),
          );
          for (;;) {
            const item = yield* resumed.next((candidate) => candidate.kind === "event");
            if (item.kind !== "event") throw new Error("Expected a replay event");
            replayed = applyOrchestrationV2ProjectionEvent(replayed, item.event);
            if (
              item.event.type === "provider-session.updated" &&
              item.event.payload.status === "stopped"
            )
              break;
          }
          check(replayed, completedRefs);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
        yield* Effect.gen(function* () {
          const { rpc: cold } = yield* pairAndConnect(mend, "PROOF-COLD");
          check(
            yield* cold[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD }),
            completedRefs,
          );
          const reloaded = yield* feed(
            cold[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
          );
          const fresh = yield* reloaded.next((item) => item.kind === "snapshot");
          if (fresh.kind !== "snapshot") throw new Error("Expected a cold proof snapshot");
          assert.strictEqual(fresh.projection.providerSessions[0]?.status, "stopped");
          check(fresh.projection, completedRefs);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );

  it.live("replaces the recording item and message in place, live and after reconnect", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = mend.workbench.addTurn("session-1", "Record the after flow");
        const ref = reference({
          kind: "video",
          state: "recording",
          mimeType: null,
          label: `${LABEL} · recording`,
        });
        const proof = mend.workbench.addItem(turn, {
          kind: "proof",
          data: encoded(ref),
          status: "in-progress",
        });
        const { rpc } = yield* pairAndConnect(mend, "PROOF-UPDATE");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        const snapshot = yield* thread.next((item) => item.kind === "snapshot");
        if (snapshot.kind !== "snapshot") throw new Error("Expected a snapshot");
        const original = snapshot.projection.turnItems.find((item) => item.id === proof.id);
        assertProofMessage(original, proof.id, `${ref.label}\n\n${CAPTION}`);
        mend.workbench.updateItem(proof, {
          status: "completed",
          data: encoded(reference({ kind: "video", mimeType: "video/mp4" })),
        });
        const expected = `${LABEL}\n\n${CAPTION}\n\n![](/mend-proof/${ID}.mp4)`;
        const messageEvent = yield* thread.next(
          (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.id === `message:${proof.id}`,
        );
        if (messageEvent.kind !== "event" || messageEvent.event.type !== "message.updated")
          throw new Error("Expected a message update");
        assert.strictEqual(messageEvent.event.payload.text, expected);
        const event = yield* thread.next(
          (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "turn-item.updated" &&
            item.event.payload.id === proof.id,
        );
        if (event.kind !== "event" || event.event.type !== "turn-item.updated")
          throw new Error("Expected a proof update");
        assertProofMessage(event.event.payload, proof.id, expected);
        assert.strictEqual(event.event.payload.ordinal, original?.ordinal);
        const { rpc: reconnected } = yield* pairAndConnect(mend, "PROOF-RECONNECT");
        const projection = yield* reconnected[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(projection.turnItems.filter((item) => item.id === proof.id).length, 1);
        assert.strictEqual(
          projection.messages.filter((message) => message.id === `message:${proof.id}`).length,
          1,
        );
        assert.strictEqual(
          projection.messages.find((message) => message.id === `message:${proof.id}`)?.text,
          expected,
        );
        const full = yield* reconnected[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
          threadId: THREAD,
          itemId: TurnItemId.make(proof.id),
        });
        assertProofMessage(full.item ?? undefined, proof.id, expected);
      }),
    ),
  );
});

describe("proof asset URLs", () => {
  it.effect("retires old grants and expires proof URLs under the shared limits", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          mend.workbench.proofs.set(ID, {
            bytes: BYTES,
            mimeType: "image/png",
            readers: new Set(["PROOF-TTL"]),
          });
          const { rpc } = yield* mend.pair("PROOF-TTL");
          const urls = yield* Effect.forEach([0, 1, 2, 3], () =>
            rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() }),
          );
          assert.strictEqual(
            (yield* mend.fetch(urls[0]?.relativeUrl ?? "", { method: "HEAD" })).status,
            404,
          );
          const latest = urls.at(-1);
          assert.strictEqual(latest?.expiresAt, ASSET_URL_TTL_MS);
          assert.strictEqual(
            (yield* mend.fetch(latest?.relativeUrl ?? "", { method: "HEAD" })).status,
            200,
          );
          yield* TestClock.adjust(ASSET_URL_TTL_MS);
          assert.strictEqual(
            (yield* mend.fetch(latest?.relativeUrl ?? "", { method: "HEAD" })).status,
            404,
          );
        }),
      {},
      false,
    ),
  );

  it.live("resets an incomplete proof stream and releases its read slot after a stall", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          const proof = {
            bytes: new Uint8Array(1024 * 1024),
            mimeType: "video/mp4",
            readers: new Set(["PROOF-STREAM"]),
            failAfter: 64 * 1024,
            cancelled: false,
          };
          mend.workbench.proofs.set(ID, proof);
          const { rpc } = yield* mend.pair("PROOF-STREAM");
          const url = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") });
          const read = () =>
            Effect.callback<{ status: number; received: number; ended: boolean }>((resume) => {
              const agent = new Agent({ keepAlive: true });
              let status = 0;
              let received = 0;
              let settled = false;
              const finish = (ended: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                request.destroy();
                agent.destroy();
                resume(Effect.succeed({ status, received, ended }));
              };
              const timer = setTimeout(() => finish(true), 3000);
              const request = get(`${mend.nodeOrigin}${url.relativeUrl}`, { agent }, (response) => {
                status = response.statusCode ?? 0;
                response.on("data", (chunk: Buffer) => {
                  received += chunk.length;
                });
                response.on("end", () => finish(true));
                response.on("close", () => finish(false));
                response.on("error", () => finish(false));
              });
              request.on("error", () => finish(false));
              return Effect.sync(() => {
                clearTimeout(timer);
                request.destroy();
                agent.destroy();
              });
            });
          const broken = yield* read();
          assert.strictEqual(broken.status, 200);
          assert.isBelow(broken.received, proof.bytes.length);
          assert.isFalse(broken.ended);
          const stalled = { ...proof, stalled: true, cancelled: false };
          mend.workbench.proofs.set(ID, stalled);
          const reset = yield* read();
          assert.isFalse(reset.ended);
          mend.workbench.proofs.set(ID, {
            bytes: BYTES,
            mimeType: "video/mp4",
            readers: proof.readers,
          });
          assert.strictEqual((yield* mend.fetch(url.relativeUrl, { method: "HEAD" })).status, 200);
          assert.isTrue(stalled.cancelled);
        }),
      { reads: { total: 1, perKey: 1, queue: 1 }, stall: Duration.millis(100) },
    ),
  );

  it.live(
    "serves both reserved resource kinds from durable media with the page scope and no worktree lookup",
    () =>
      withAssetHarness(
        (mend, logs) =>
          Effect.gen(function* () {
            const { rpc } = yield* mend.pair("PROOF-ASSETS", ["orchestration:read"]);
            for (const [extension, mimeType] of [
              ["png", "image/png"],
              ["mp4", "video/mp4"],
            ] as const) {
              mend.workbench.proofs.set(ID, {
                bytes: BYTES,
                mimeType,
                readers: new Set(["PROOF-ASSETS"]),
              });
              for (const kind of ["media-file", "workspace-file"] as const) {
                const input = { resource: resource(extension, kind) };
                assert.deepStrictEqual(requiredScopesFor(WS_METHODS.assetsCreateUrl, input), [
                  "orchestration:read",
                ]);
                const url = yield* rpc[WS_METHODS.assetsCreateUrl](input);
                const response = yield* mend.fetch(url.relativeUrl);
                assert.strictEqual(response.status, 200);
                assert.strictEqual(response.headers.get("content-type"), mimeType);
                assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
                assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff");
                assert.strictEqual(response.headers.get("content-disposition"), "inline");
                assert.deepStrictEqual(
                  new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
                  BYTES,
                );
                const alias = url.relativeUrl.replace(
                  /\.[^.]+$/,
                  extension === "png" ? ".mp4" : ".png",
                );
                assert.strictEqual((yield* mend.fetch(alias)).status, 404);
                assert.isFalse(logs.some((log) => log.includes(url.relativeUrl)));
              }
            }
            assert.deepStrictEqual(mend.requests, []);
            assert.deepStrictEqual(
              mend.proofRequests.map((request) => request.method),
              ["HEAD", "GET", "HEAD", "GET", "HEAD", "GET", "HEAD", "GET"],
            );
            assert.isTrue(
              mend.proofRequests.every(
                (request) =>
                  request.authorization === "Bearer PROOF-ASSETS" &&
                  request.path === `/api/proof-artifacts/${ID}/media`,
              ),
            );
            const { rpc: filesOnly } = yield* mend.pair("FILES-ONLY", ["filesystem:read"]);
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(filesOnly[WS_METHODS.assetsCreateUrl]({ resource: resource() })),
              ),
            );
          }),
        {},
        false,
      ),
  );

  it.live("refuses malformed reserved paths and keeps worktree paths outside the namespace", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* mend.pair("PROOF-PATHS");
          for (const path of [
            "/mend-proof",
            "/mend-proof/",
            `/mend-proof//${ID}.png`,
            `/mend-proof/${ID}.jpg`,
            `/mend-proof/${ID}.PNG`,
            `/mend-proof/${ID.toUpperCase()}.png`,
            `/mend-proof/${ID}.png/extra`,
            `/mend-proof/${ID}.png?x=1`,
            `/mend-proof/${ID}.png#x`,
            "/mend-proof/not-an-id.png",
            `/mend-proof/../${ID}.png`,
            `/mend-proof/./${ID}.png`,
            `/mend-proof/.git/${ID}.png`,
            `/mend-proof/%2e%2e/${ID}.png`,
            `/mend-proof/${ID}%2epng`,
            `/mend-proof/${ID}.png\0`,
            `/mend-proof/${ID}.png\n`,
            `/mend-proof\\${ID}.png`,
          ]) {
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(
                  rpc[WS_METHODS.assetsCreateUrl]({ resource: { ...resource(), path } }),
                ),
              ),
              path,
            );
          }
          assert.deepStrictEqual(mend.proofRequests, []);
          assert.deepStrictEqual(mend.requests, []);
          const name = `mend-proof/${ID}.png`;
          mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
            bytes: BYTES,
            canonicalPath: name,
          });
          const input = { resource: { ...resource(), path: `${ROOT}/${name}` } };
          assert.deepStrictEqual(requiredScopesFor(WS_METHODS.assetsCreateUrl, input), [
            "filesystem:read",
          ]);
          const url = yield* rpc[WS_METHODS.assetsCreateUrl](input);
          assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 200);
          assert.strictEqual(mend.requests.length, 2);
          assert.deepStrictEqual(mend.proofRequests, []);
        }),
      {},
      false,
    ),
  );

  it.live(
    "passes video ranges and 416 through, with HEAD and If-Range returning whole-media headers",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            mend.workbench.proofs.set(ID, {
              bytes: BYTES,
              mimeType: "video/mp4",
              readers: new Set(["PROOF-RANGE"]),
            });
            const { rpc } = yield* mend.pair("PROOF-RANGE");
            const url = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") });
            for (const [range, from, to] of [
              ["bytes=2-5", 2, 6],
              ["bytes=253-", 253, 256],
              ["bytes=-3", 253, 256],
            ] as const) {
              const response = yield* mend.fetch(url.relativeUrl, { headers: { range } });
              assert.strictEqual(response.status, 206);
              assert.strictEqual(
                response.headers.get("content-range"),
                `bytes ${from}-${to - 1}/256`,
              );
              assert.strictEqual(response.headers.get("accept-ranges"), "bytes");
              assert.strictEqual(response.headers.get("content-length"), String(to - from));
              assert.deepStrictEqual(
                new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
                BYTES.slice(from, to),
              );
            }
            const beyond = yield* mend.fetch(url.relativeUrl, { headers: { range: "bytes=256-" } });
            assert.strictEqual(beyond.status, 416);
            assert.strictEqual(beyond.headers.get("content-range"), "bytes */256");
            assert.strictEqual(yield* Effect.promise(() => beyond.text()), "");
            const head = yield* mend.fetch(url.relativeUrl, {
              method: "HEAD",
              headers: { range: "bytes=2-5" },
            });
            assert.strictEqual(head.status, 200);
            assert.strictEqual(head.headers.get("content-length"), "256");
            assert.strictEqual(yield* Effect.promise(() => head.text()), "");
            const whole = yield* mend.fetch(url.relativeUrl, {
              headers: { range: "bytes=2-5", "if-range": "old" },
            });
            assert.strictEqual(whole.status, 200);
            assert.strictEqual((yield* Effect.promise(() => whole.arrayBuffer())).byteLength, 256);
            assert.isUndefined(mend.proofRequests.at(-1)?.range);
          }),
        {},
        false,
      ),
  );

  it.live(
    "checks change visibility on later ranges and refuses a device's existing grants when Mend returns 401",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            const proof = {
              bytes: BYTES,
              mimeType: "video/mp4",
              readers: new Set(["PROOF-ACCESS"]),
            };
            mend.workbench.proofs.set(ID, proof);
            const { rpc } = yield* mend.pair("PROOF-ACCESS");
            const { rpc: other } = yield* mend.pair("PROOF-OTHER");
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(
                  other[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") }),
                ),
              ),
            );
            const url = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") });
            const first = yield* mend.fetch(url.relativeUrl, { headers: { range: "bytes=0-5" } });
            assert.strictEqual(first.status, 206);
            yield* Effect.promise(() => first.arrayBuffer());
            proof.readers.clear();
            const missing = yield* mend.fetch(url.relativeUrl, {
              headers: { range: "bytes=6-10" },
            });
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(yield* Effect.promise(() => missing.text()), "Not Found");
            proof.readers.add("PROOF-ACCESS");
            assert.strictEqual(
              (yield* mend.fetch(url.relativeUrl, { method: "HEAD" })).status,
              200,
            );
            // Device checks are cached briefly. The media call must still revoke all its grants.
            mend.revoke("PROOF-ACCESS");
            assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 404);
            const requests = mend.proofRequests.length;
            assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 404);
            assert.strictEqual(mend.proofRequests.length, requests);
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") })),
              ),
            );
          }),
        {},
        false,
      ),
  );

  it.live(
    "maps missing media and invalid upstream statuses or headers to the same unavailable response",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            const { rpc } = yield* mend.pair("PROOF-HEADERS");
            const proof = {
              bytes: BYTES,
              mimeType: "video/mp4",
              readers: new Set(["PROOF-HEADERS"]),
            };
            mend.workbench.proofs.set(ID, proof);
            const url = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") });
            for (const status of [403, 404, 409, 429, 500, 503]) {
              mend.workbench.proofs.set(ID, { ...proof, status });
              assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 404);
            }
            for (const headers of [
              { "content-type": "text/html" },
              { "content-type": "image/png" },
              { "content-length": "-1" },
              { "content-length": "no" },
              { "content-length": "9007199254740992" },
              { "content-range": "wrong" },
            ]) {
              mend.workbench.proofs.set(ID, { ...proof, headers });
              assert.strictEqual(
                (yield* mend.fetch(url.relativeUrl, { headers: { range: "bytes=2-5" } })).status,
                404,
              );
            }
            mend.workbench.proofs.delete(ID);
            assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 404);
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("mp4") })),
              ),
            );
          }),
        {},
        false,
      ),
  );
});
