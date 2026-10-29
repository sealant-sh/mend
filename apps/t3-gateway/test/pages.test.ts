import { createServer, get } from "node:http";

import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadStreamItem,
  type AssetResource,
} from "@mend/t3-contracts";
import { injectHtmlRenderBootstrap } from "@mend/t3-contracts/html-render";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@mend/t3-contracts/tool-output";
import { Clock, Context, Duration, Effect, Exit, Fiber, Layer, Redacted } from "effect";

import { GatewayConfig } from "../src/config.ts";
import { MendClient } from "../src/mend-client.ts";
import { MendClientFetchLive } from "../src/server.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { pageItem } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { withAssetHarness } from "./support/raw-assets.ts";
import { pairAndConnect } from "./support/rpc.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const THREAD = ThreadId.make("session-1");
const HTML =
  "<!doctype html><html><body><h1>Latency</h1><script>window.pageLoaded = true</script></body></html>";
const DOCUMENT = injectHtmlRenderBootstrap(HTML);
const resource = (attachmentId = "page-1") =>
  ({
    _tag: "attachment",
    attachmentId,
    mimeType: "text/html",
    disposition: "inline",
  }) satisfies AssetResource;

const settled = <A>(fiber: Fiber.Fiber<A>) =>
  Effect.raceFirst(
    Fiber.join(fiber),
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1000))).pipe(
      Effect.as("still waiting" as const),
    ),
  );

const assertPage = (
  item: OrchestrationV2TurnItem | null | undefined,
  id: string,
  title = "Latency",
) => {
  if (item?.type !== "dynamic_tool") throw new Error("Expected a dynamic_tool page item");
  assert.strictEqual(item.status, "completed");
  assert.strictEqual(item.toolName, "html_render");
  const reference = { attachmentId: id, title, height: 420 };
  assert.deepStrictEqual(htmlRenderFromToolItem(item), reference);
  assert.deepStrictEqual(compactDynamicToolOutput(item.output), { htmlRender: reference });
  assert.isBelow(Buffer.byteLength(JSON.stringify(item.output)), 16_384);
  assert.isBelow(Buffer.byteLength(JSON.stringify(item.input)), 16_384);
};

describe("pages in the pinned t3code client", () => {
  it.live(
    "renders snapshot, live and getTurnItem pages in their turn, hiding only published calls",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { workbench } = mend;
          workbench.addProject("project-1", "mend");
          workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
          const turn = workbench.addTurn("session-1", "Plot latency", "completed");
          const published = workbench.addItem(turn, {
            kind: "tool-call",
            title: "mcp__mend__html_render",
            data: { mendPageCall: { attachmentId: "page-1", failure: null } },
          });
          const page = workbench.addItem(
            turn,
            pageItem({ id: "page-1", sessionId: "session-1", title: "Latency", height: 420 }),
          );
          const refused = workbench.addItem(turn, {
            kind: "tool-call",
            title: "mcp__mend__html_render",
            status: "failed",
            data: {
              mendPageCall: {
                attachmentId: null,
                failure: { code: "invalid_request", message: "vh" },
              },
            },
          });
          const answer = workbench.addItem(turn, {
            kind: "assistant-message",
            text: "Here is the plot.",
          });
          const { rpc } = yield* pairAndConnect(mend, "PAGES");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.deepStrictEqual(
            projection.turnItems.map((item) => item.id),
            [`input:${turn.id}`, page.id, refused.id, answer.id],
          );
          assertPage(projection.turnItems[1], "page-1");
          const full = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
            threadId: THREAD,
            itemId: TurnItemId.make(page.id),
          });
          assertPage(full.item, "page-1");
          const hidden = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
            threadId: THREAD,
            itemId: TurnItemId.make(published.id),
          });
          assert.isNull(hidden.item);
          const failed = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
            threadId: THREAD,
            itemId: TurnItemId.make(refused.id),
          });
          assert.strictEqual(failed.item?.status, "failed");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
          );
          const snapshot = yield* thread.next((item) => item.kind === "snapshot");
          if (snapshot.kind !== "snapshot") throw new Error("Expected a snapshot");
          assertPage(
            snapshot.projection.turnItems.find((item) => item.id === page.id),
            "page-1",
          );
          const liveTurn = workbench.addTurn("session-1", "One more plot");
          const live = workbench.addItem(liveTurn, {
            ...pageItem({
              id: "page-2",
              sessionId: "session-1",
              title: "\u0000".repeat(20_000),
              height: 420,
            }),
            status: "in-progress",
          });
          const event = yield* thread.next(
            (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
              item.kind === "event" &&
              item.event.type === "turn-item.updated" &&
              item.event.payload.id === live.id,
          );
          if (event.kind !== "event" || event.event.type !== "turn-item.updated")
            throw new Error("Expected page event");
          assertPage(event.event.payload, "page-2", "\u0000".repeat(200));
          const liveFull = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
            threadId: THREAD,
            itemId: TurnItemId.make(live.id),
          });
          assertPage(liveFull.item, "page-2", "\u0000".repeat(200));
          const liveCall = workbench.addItem(liveTurn, {
            kind: "tool-call",
            title: "mcp__mend__html_render",
            status: "in-progress",
            data: {},
          });
          yield* thread.next(
            (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
              item.kind === "event" &&
              item.event.type === "turn-item.updated" &&
              item.event.payload.id === liveCall.id,
          );
          liveCall.data = { mendPageCall: { attachmentId: "page-2", failure: null } };
          workbench.updateItem(liveCall, { status: "completed" });
          const reset = yield* thread.next((item) => item.kind === "snapshot");
          if (reset.kind !== "snapshot") throw new Error("Expected a snapshot");
          assert.isFalse(reset.projection.turnItems.some((item) => item.id === liveCall.id));
          assertPage(
            reset.projection.turnItems.find((item) => item.id === live.id),
            "page-2",
            "\u0000".repeat(200),
          );
        }),
      ),
  );

  it.effect(
    "serves the bootstrapped document with exact sandbox headers and no credential in logs or traces",
    () =>
      withAssetHarness(
        (mend, logs) =>
          Effect.gen(function* () {
            mend.workbench.pages.set("page-1", {
              document: DOCUMENT,
              readers: new Set(["READER"]),
            });
            const { rpc } = yield* mend.pair("READER");
            const before = yield* Clock.currentTimeMillis;
            const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            assert.isAtLeast(asset.expiresAt - before, 15 * 60_000);
            assert.match(asset.relativeUrl, /^\/api\/assets\/ast_[A-Za-z0-9_-]{43}\/page\.html$/);
            const response = yield* mend.fetch(asset.relativeUrl);
            assert.strictEqual(response.status, 200);
            assert.strictEqual(yield* Effect.promise(() => response.text()), DOCUMENT);
            assert.strictEqual(response.headers.get("content-type"), "text/html; charset=utf-8");
            assert.strictEqual(
              response.headers.get("content-security-policy"),
              "sandbox allow-scripts allow-forms",
            );
            assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff");
            assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
            assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
            assert.isNull(response.headers.get("x-frame-options"));
            const head = yield* mend.fetch(asset.relativeUrl, { method: "HEAD" });
            assert.strictEqual(head.status, 200);
            assert.strictEqual(yield* Effect.promise(() => head.text()), "");
            assert.lengthOf(
              mend.pageRequests.filter((r) => r.path.endsWith("/frame")),
              3,
            );
            assert.isTrue(
              mend.pageRequests
                .filter((r) => r.path.endsWith("/frame"))
                .every((r) => r.authorization === "Bearer READER"),
            );
            assert.isTrue(
              mend.pageRequests
                .filter((r) => r.path === "/api/page-view")
                .every((r) => r.authorization === undefined),
            );
            const traces = JSON.stringify(
              mend.spans.map((span) => [span.name, [...span.attributes]]),
            );
            for (const value of [
              asset.relativeUrl,
              asset.relativeUrl.split("/")[3] ?? "",
              "private-view-",
              "Bearer READER",
            ]) {
              assert.notInclude(logs.join("\n"), value);
              assert.notInclude(traces, value);
            }
          }),
        {},
        false,
      ),
  );

  it.effect(
    "refuses absent pages and other people, then rechecks project access on the next load",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            const readers = new Set(["OWNER"]);
            mend.workbench.pages.set("page-1", { document: DOCUMENT, readers });
            const owner = yield* mend.pair("OWNER");
            const stranger = yield* mend.pair("STRANGER");
            for (const call of [
              stranger.rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() }),
              owner.rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("absent") }),
            ]) {
              const result = yield* Effect.exit(call);
              assert.isTrue(Exit.isFailure(result));
              if (Exit.isFailure(result))
                assert.include(JSON.stringify(result), "AssetAttachmentNotFoundError");
            }
            const asset = yield* owner.rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            assert.strictEqual((yield* mend.fetch(asset.relativeUrl)).status, 200);
            readers.delete("OWNER");
            const denied = yield* mend.fetch(asset.relativeUrl);
            assert.strictEqual(denied.status, 404);
            assert.strictEqual(yield* Effect.promise(() => denied.text()), "Not Found");
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(owner.rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() })),
              ),
            );
          }),
        {},
        false,
      ),
  );

  it.effect("refuses tampering, expired URLs and revoked devices; a remount can mint again", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          mend.workbench.pages.set("page-1", { document: DOCUMENT, readers: new Set(["READER"]) });
          const { rpc } = yield* mend.pair("READER");
          const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          const [prefix, token = "", name] = asset.relativeUrl.slice("/api/".length).split("/");
          const changed = token.endsWith("A") ? `${token.slice(0, -1)}B` : `${token.slice(0, -1)}A`;
          for (const url of [
            `/api/${prefix}/${changed}/${name}`,
            `${asset.relativeUrl}/child.js`,
            asset.relativeUrl.replace("page.html", "other.html"),
          ])
            assert.strictEqual((yield* mend.fetch(url)).status, 404);
          yield* TestClock.adjust("30 minutes");
          assert.strictEqual((yield* mend.fetch(asset.relativeUrl)).status, 404);
          const remounted = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          assert.notStrictEqual(remounted.relativeUrl, asset.relativeUrl);
          assert.strictEqual((yield* mend.fetch(remounted.relativeUrl)).status, 200);
          mend.revoke("READER");
          assert.strictEqual((yield* mend.fetch(remounted.relativeUrl)).status, 404);
        }),
      {},
      false,
    ),
  );

  it.effect(
    "caps a page URL at its bearer expiry and refuses a mint with less than 15 minutes left",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            mend.workbench.pages.set("page-1", {
              document: DOCUMENT,
              readers: new Set(["READER"]),
            });
            const { rpc } = yield* mend.pair("READER");
            yield* TestClock.adjust(30 * 24 * 60 * 60_000 - 15 * 60_000);
            const now = yield* Clock.currentTimeMillis;
            const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            assert.strictEqual(asset.expiresAt - now, 15 * 60_000);
            yield* TestClock.adjust(1);
            const asked = mend.pageRequests.length;
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() })),
              ),
            );
            assert.strictEqual(mend.pageRequests.length, asked, "refused without asking Mend");
            yield* TestClock.adjust(15 * 60_000);
            assert.strictEqual((yield* mend.fetch(asset.relativeUrl)).status, 404);
          }),
        {},
        false,
      ),
  );

  it.effect("keeps every page URL serving until its expiry however often the frame remounts", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          mend.workbench.pages.set("page-1", { document: DOCUMENT, readers: new Set(["READER"]) });
          const { rpc } = yield* mend.pair("READER");
          const mint = rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          const first = yield* mint;
          for (let remount = 0; remount < 3; remount++)
            assert.deepStrictEqual(yield* mint, first, "a URL with 15 minutes left is reused");
          yield* TestClock.adjust(16 * 60_000);
          const second = yield* mint;
          assert.notStrictEqual(second.relativeUrl, first.relativeUrl);
          for (let remount = 0; remount < 3; remount++) assert.deepStrictEqual(yield* mint, second);
          yield* TestClock.adjust(first.expiresAt - (yield* Clock.currentTimeMillis) - 1);
          assert.strictEqual((yield* mend.fetch(first.relativeUrl)).status, 200);
          yield* TestClock.adjust(1);
          assert.strictEqual((yield* mend.fetch(first.relativeUrl)).status, 404);
          assert.strictEqual((yield* mend.fetch(second.relativeUrl)).status, 200);
        }),
      {},
      false,
    ),
  );

  it.effect("serves a 401 from the page view as unavailable and leaves the device paired", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          const readers = new Set(["READER"]);
          mend.workbench.pages.set("page-1", { document: DOCUMENT, readers, viewStatus: 401 });
          const { rpc } = yield* mend.pair("READER");
          const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          const refused = yield* mend.fetch(asset.relativeUrl);
          assert.strictEqual(refused.status, 404);
          assert.strictEqual(yield* Effect.promise(() => refused.text()), "Not Found");
          mend.workbench.pages.set("page-1", { document: DOCUMENT, readers });
          assert.strictEqual((yield* mend.fetch(asset.relativeUrl)).status, 200);
          const again = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          assert.strictEqual((yield* mend.fetch(again.relativeUrl)).status, 200);
        }),
      {},
      false,
    ),
  );

  it.live("refuses a frame or view that redirects, over the gateway's own fetch client", () =>
    Effect.gen(function* () {
      const hits: string[] = [];
      let frameRedirects = true;
      const server = createServer((request, response) => {
        const path = request.url ?? "";
        hits.push(path);
        if (path.startsWith("/api/pages/page-1/frame") && frameRedirects) {
          response.writeHead(302, { location: "/elsewhere/frame" });
          response.end();
        } else if (path.startsWith("/api/pages/page-1/frame") || path === "/elsewhere/frame") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              url: "/api/page-view?view=private-view",
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            }),
          );
        } else if (path.startsWith("/api/page-view")) {
          response.writeHead(302, { location: "/elsewhere/page" });
          response.end();
        } else {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(DOCUMENT);
        }
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
      );
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a port");
      const services = yield* Layer.build(
        MendClientFetchLive.pipe(
          Layer.provide(
            Layer.succeed(GatewayConfig, {
              mendUrl: new URL(`http://127.0.0.1:${address.port}`),
              host: "127.0.0.1",
              port: 0,
              statePath: ":memory:",
              label: "redirects",
            }),
          ),
        ),
      );
      const client = Context.get(services, MendClient);
      const token = Redacted.make("READER");
      const frame = yield* Effect.exit(client.pageFrame(token, "page-1"));
      assert.isTrue(Exit.isFailure(frame) && JSON.stringify(frame).includes("MendPageUnavailable"));
      assert.notInclude(hits, "/elsewhere/frame");
      frameRedirects = false;
      const view = yield* Effect.exit(Effect.scoped(client.openPage(token, "page-1")));
      assert.isTrue(Exit.isFailure(view) && JSON.stringify(view).includes("MendPageUnavailable"));
      assert.include(hits, "/api/page-view?view=private-view");
      assert.notInclude(hits, "/elsewhere/page");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "gives up on a frame whose body Mend never finishes within its deadline, freeing the slot",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            const page = { document: DOCUMENT, readers: new Set(["READER"]), frameStalls: false };
            mend.workbench.pages.set("page-1", page);
            const { rpc } = yield* mend.pair("READER");
            const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            page.frameStalls = true;
            const asked = mend.pageRequests.length;
            const mint = yield* Effect.forkChild(
              Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() })),
            );
            const load = yield* Effect.forkChild(mend.fetch(asset.relativeUrl));
            while (mend.pageRequests.length < asked + 2)
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
            yield* TestClock.adjust("11 seconds");
            const minted = yield* settled(mint);
            assert.isTrue(minted !== "still waiting" && Exit.isFailure(minted));
            const loaded = yield* settled(load);
            assert.strictEqual(loaded === "still waiting" ? 0 : loaded.status, 404);
            page.frameStalls = false;
            const again = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            assert.strictEqual((yield* mend.fetch(again.relativeUrl)).status, 200);
          }),
        {
          mints: { total: 1, perKey: 1, queue: 4 },
          reads: { total: 1, perKey: 1, queue: 4 },
          wait: Duration.millis(1),
        },
        false,
      ),
  );

  it.live("resets a load whose page body Mend stops sending, freeing the slot", () =>
    withAssetHarness(
      (mend) =>
        Effect.gen(function* () {
          const page = { document: DOCUMENT, readers: new Set(["READER"]), viewStalls: true };
          mend.workbench.pages.set("page-1", page);
          const { rpc } = yield* mend.pair("READER");
          const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          const outcome = yield* Effect.callback<"reset" | "end" | "still waiting">((resume) => {
            const timer = setTimeout(() => resume(Effect.succeed("still waiting")), 3000);
            const request = get(`${mend.nodeOrigin}${asset.relativeUrl}`, (response) => {
              response.resume();
              response.on("end", () => resume(Effect.succeed("end")));
              response.on("error", () => resume(Effect.succeed("reset")));
            });
            request.on("error", () => resume(Effect.succeed("reset")));
            return Effect.sync(() => {
              clearTimeout(timer);
              request.destroy();
            });
          });
          assert.strictEqual(outcome, "reset");
          page.viewStalls = false;
          assert.strictEqual((yield* mend.fetch(asset.relativeUrl)).status, 200);
        }),
      {
        reads: { total: 1, perKey: 1, queue: 4 },
        wait: Duration.millis(1),
        stall: Duration.millis(300),
      },
    ),
  );

  it.effect("forgets URLs across restart while pages remain readable from Mend", () =>
    Effect.gen(function* () {
      const page = { document: DOCUMENT, readers: new Set(["READER"]) };
      const old = yield* withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            mend.workbench.pages.set("page-1", page);
            const { rpc } = yield* mend.pair("READER");
            return yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
          }),
        {},
        false,
      );
      yield* withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            mend.workbench.pages.set("page-1", page);
            const { rpc } = yield* mend.pair("READER");
            assert.strictEqual((yield* mend.fetch(old.relativeUrl)).status, 404);
            const fresh = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            assert.strictEqual((yield* mend.fetch(fresh.relativeUrl)).status, 200);
          }),
        {},
        false,
      );
    }),
  );

  it.effect(
    "refuses invalid frame locations and upstream failures without serving their bodies",
    () =>
      withAssetHarness(
        (mend) =>
          Effect.gen(function* () {
            const page = {
              document: DOCUMENT,
              readers: new Set(["READER"]),
              frameUrl: "",
              frameStatus: 200,
              viewStatus: 200,
              contentType: "text/html",
            };
            mend.workbench.pages.set("page-1", page);
            const { rpc } = yield* mend.pair("READER");
            for (const frameUrl of [
              "https://elsewhere.invalid/api/page-view?view=secret",
              "//elsewhere.invalid/api/page-view?view=secret",
              "/api/projects?view=secret",
              "/api/page-view?view=secret#fragment",
              "/api/page-view?view=",
            ]) {
              page.frameUrl = frameUrl;
              assert.isTrue(
                Exit.isFailure(
                  yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() })),
                ),
              );
            }
            mend.workbench.pages.set("page-1", { document: DOCUMENT, readers: page.readers });
            const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource() });
            for (const fixture of [
              { frameStatus: 503 },
              { viewStatus: 404 },
              { viewStatus: 302 },
              { contentType: "application/json" },
            ]) {
              mend.workbench.pages.set("page-1", {
                document: DOCUMENT,
                readers: page.readers,
                ...fixture,
              });
              const response = yield* mend.fetch(asset.relativeUrl);
              assert.strictEqual(response.status, 404);
              assert.strictEqual(yield* Effect.promise(() => response.text()), "Not Found");
            }
          }),
        {},
        false,
      ),
  );
});
