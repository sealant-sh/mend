import { Agent, get } from "node:http";

import { MessageId, ThreadId, WS_METHODS } from "@mend/t3-contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import {
  withAssetHarness,
  pairAssetClient as pairAndConnect,
  type AssetHarness as FakeMend,
} from "./support/raw-assets.ts";

const THREAD = ThreadId.make("session-1");
const ROOT = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
const BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
const withGateway = <A, E, R>(test: (mend: FakeMend, logs: string[]) => Effect.Effect<A, E, R>) =>
  withAssetHarness((mend, logs) =>
    Effect.gen(function* () {
      for (const name of [
        "image.png",
        "movie.mp4",
        "song.opus",
        "docs/index.html",
        "docs/book.pdf",
        "docs/style.css",
        "docs/nested/a.mjs",
        "private/secret.css",
        "vector.svg",
        "space % #.png",
      ]) {
        mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
          bytes: BYTES,
          canonicalPath: name,
        });
      }
      mend.workbench.rawFiles.set("worktree-session-1/docs/leak.css", {
        bytes: BYTES,
        canonicalPath: "private/secret.css",
      });
      mend.workbench.rawFiles.set("worktree-session-1/disguised.png", {
        bytes: BYTES,
        canonicalPath: "docs/index.html",
      });
      return yield* test(mend, logs);
    }),
  );
const resource = (name: string, kind: "workspace-file" | "media-file" = "workspace-file") => ({
  _tag: kind,
  threadId: THREAD,
  path: `${ROOT}/${name}`,
});

describe("worktree asset URLs", () => {
  it.live(
    "mints fresh canonical file URLs and returns exact binary bytes and browser headers without logging paths",
    () =>
      withGateway((mend, logs) =>
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RAW");
          const http = yield* HttpClient.HttpClient;
          for (const [name, mime] of [
            ["image.png", "image/png"],
            ["space % #.png", "image/png"],
            ["docs/book.pdf", "application/pdf"],
            ["vector.svg", "image/svg+xml"],
            ["disguised.png", "text/html; charset=utf-8"],
          ]) {
            const input = { resource: resource(name ?? "") };
            const a = yield* rpc[WS_METHODS.assetsCreateUrl](input);
            const b = yield* rpc[WS_METHODS.assetsCreateUrl](input);
            assert.notStrictEqual(a.relativeUrl, b.relativeUrl);
            const response = yield* http.get(a.relativeUrl, { headers: { range: "bytes=2-5" } });
            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.headers["content-type"], mime);
            assert.strictEqual(response.headers["cache-control"], "private, no-store");
            assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
            assert.isUndefined(response.headers["x-frame-options"]);
            assert.deepStrictEqual(new Uint8Array(yield* response.arrayBuffer), BYTES);
            if (name === "vector.svg")
              assert.strictEqual(
                response.headers["content-security-policy"],
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              );
            if (name === "disguised.png") {
              assert.isTrue(a.relativeUrl.endsWith("/index.html"));
              assert.strictEqual(
                response.headers["content-security-policy"],
                "sandbox allow-scripts allow-forms allow-popups allow-downloads",
              );
            }
            const traces = JSON.stringify(
              mend.spans.map((span) => [span.name, [...span.attributes]]),
            );
            assert.isFalse(
              traces.includes(a.relativeUrl) ||
                traces.includes(name ?? "") ||
                traces.includes(ROOT),
            );
            assert.isFalse(
              logs.some(
                (log) =>
                  log.includes(a.relativeUrl) || log.includes(name ?? "") || log.includes(ROOT),
              ),
            );
          }
          assert.isAbove(mend.spans.length, 0);
          const wrongThread = yield* Effect.exit(
            rpc[WS_METHODS.assetsCreateUrl]({
              resource: { ...resource("image.png"), threadId: ThreadId.make("elsewhere") },
            }),
          );
          assert.isTrue(Exit.isFailure(wrongThread));
        }),
      ),
  );
  it.live(
    "serves each kind with t3code v0.1.2's content type, nosniff and sandbox, from the opened file",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "TYPES");
          const http = yield* HttpClient.HttpClient;
          const svg = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
          const html = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
          for (const name of ["icon.ico", "photo.avif", "Shot.JPG", "docs/font.woff2"])
            mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
              bytes: BYTES,
              canonicalPath: name,
            });
          const served = [
            ["icon.ico", "image/x-icon", undefined],
            ["photo.avif", "image/avif", undefined],
            ["Shot.JPG", "image/jpeg", undefined],
            ["image.png", "image/png", undefined],
            ["vector.svg", "image/svg+xml", svg],
            ["docs/index.html", "text/html; charset=utf-8", html],
            ["docs/book.pdf", "application/pdf", undefined],
          ] as const;
          for (const kind of ["workspace-file", "media-file"] as const)
            for (const [name, type, csp] of served) {
              const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
                resource: resource(name, kind),
              });
              const response = yield* http.get(url.relativeUrl);
              assert.strictEqual(response.status, 200, `${kind} ${name}`);
              assert.strictEqual(response.headers["content-type"], type, `${kind} ${name}`);
              assert.strictEqual(response.headers["x-content-type-options"], "nosniff");
              assert.strictEqual(response.headers["content-security-policy"], csp);
            }
          for (const [name, type] of [
            ["movie.mp4", "video/mp4"],
            ["song.opus", "audio/ogg"],
          ] as const) {
            const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
              resource: resource(name, "media-file"),
            });
            assert.strictEqual(
              (yield* http.get(url.relativeUrl)).headers["content-type"],
              type,
              name,
            );
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource(name) })),
              ),
              `workspace-file ${name}`,
            );
          }
          const page = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: resource("docs/index.html"),
          });
          const directory = page.relativeUrl.slice(0, page.relativeUrl.lastIndexOf("/"));
          for (const [suffix, type] of [
            ["style.css", "text/css"],
            ["nested/a.mjs", "text/javascript"],
            ["font.woff2", "font/woff2"],
          ] as const) {
            const response = yield* http.get(`${directory}/${suffix}`);
            assert.strictEqual(response.headers["content-type"], type, suffix);
            assert.isUndefined(response.headers["content-security-policy"]);
          }
        }),
      ),
  );
  it.live("forwards media Range as 206/416, ignores If-Range and supplies HEAD and CORS", () =>
    withGateway((mend, logs) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "MEDIA");
        const http = yield* HttpClient.HttpClient;
        for (const name of ["movie.mp4", "song.opus"]) {
          const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: resource(name, "media-file"),
          });
          const partial = yield* http.get(url.relativeUrl, { headers: { range: "bytes=2-5" } });
          assert.strictEqual(partial.status, 206);
          assert.strictEqual(partial.headers["content-range"], "bytes 2-5/256");
          assert.deepStrictEqual(new Uint8Array(yield* partial.arrayBuffer), BYTES.slice(2, 6));
          assert.strictEqual(
            (yield* http.get(url.relativeUrl, { headers: { range: "bytes=256-" } })).status,
            416,
          );
          assert.strictEqual(
            (yield* http.get(url.relativeUrl, {
              headers: { range: "bytes=2-5", "if-range": "unknown" },
            })).status,
            200,
          );
          const head = yield* http.head(url.relativeUrl);
          assert.strictEqual(head.status, 200);
          assert.strictEqual(head.headers["content-length"], "256");
          assert.strictEqual(yield* head.text, "");
          const options = yield* http.options(url.relativeUrl, {
            headers: {
              origin: "null",
              "access-control-request-method": "GET",
              "access-control-request-headers": "range",
            },
          });
          assert.include(options.headers["access-control-allow-headers"], "range");
          assert.isFalse(
            logs.some((line) => line.includes(url.relativeUrl) || line.includes("movie.mp4")),
          );
        }
      }),
    ),
  );
  it.live(
    "binds exact files, confines document children and returns the missing favicon marker",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "BOUND");
          const http = yield* HttpClient.HttpClient;
          const image = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
          const base = image.relativeUrl.slice(0, image.relativeUrl.lastIndexOf("/"));
          for (const suffix of ["vector.svg", "image.png/extra", "%2e%2e/secret", "%2fetc", "%ZZ"])
            assert.strictEqual((yield* http.get(`${base}/${suffix}`)).status, 404);
          const html = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: resource("docs/index.html"),
          });
          const directory = html.relativeUrl.slice(0, html.relativeUrl.lastIndexOf("/"));
          for (const suffix of ["style.css", "nested/a.mjs"])
            assert.strictEqual((yield* http.get(`${directory}/${suffix}`)).status, 200);
          for (const suffix of ["leak.css", ".git/config", "file.ts", "%2e%2e/private/secret.css"])
            assert.strictEqual((yield* http.get(`${directory}/${suffix}`)).status, 404);
          const favicon = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "project-favicon", cwd: "/var/lib/mend/store/project-1/repo.git" },
          });
          assert.isTrue(favicon.relativeUrl.endsWith("/project-favicon-missing"));
          mend.workbench.goneWorktrees.add("worktree-session-1");
          const denied = yield* http.get(image.relativeUrl);
          assert.strictEqual(denied.status, 404);
          assert.strictEqual(yield* denied.text, "Not Found");
        }),
      ),
  );
  it.effect(
    "expires grants and revokes both file and chat-image URLs with the originating device after five seconds",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "REVOKE");
          const http = yield* HttpClient.HttpClient;
          const image = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
          const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("raw-image"),
            attachments: [
              {
                type: "image",
                name: "chat.png",
                mimeType: "image/png",
                sizeBytes: png.length,
                dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
              },
            ],
          });
          const chat = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "attachment", attachmentId: kept.attachments[0]?.id ?? "" },
          });
          const second = yield* pairAndConnect(mend, "SECOND");
          const other = yield* second.rpc[WS_METHODS.assetsCreateUrl]({
            resource: resource("image.png"),
          });
          assert.strictEqual((yield* http.get(chat.relativeUrl)).status, 200);
          mend.revoke(mend.claims[0]?.token ?? "");
          yield* TestClock.adjust("5001 millis");
          for (const url of [image, chat])
            assert.strictEqual((yield* http.get(url.relativeUrl)).status, 404);
          assert.strictEqual((yield* http.get(other.relativeUrl)).status, 200);
          yield* TestClock.adjust("1 hour");
          assert.strictEqual((yield* http.get(other.relativeUrl)).status, 404);
        }),
      ),
  );
});

/** What a browser on a real socket sees of one response: its end, a reset, or no end at all. */
export const readOverSocket = (url: string) =>
  Effect.callback<{
    readonly status: number;
    readonly length: number;
    readonly received: number;
    readonly outcome: "end" | "reset" | "hang";
  }>((resume) => {
    let status = 0;
    let length = 0;
    let received = 0;
    let settled = false;
    const finish = (outcome: "end" | "reset" | "hang") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      agent.destroy();
      resume(Effect.succeed({ status, length, received, outcome }));
    };
    const timer = setTimeout(() => finish("hang"), 3000);
    // A browser keeps the connection open, so only a reset tells it the body stopped short.
    const agent = new Agent({ keepAlive: true });
    const request = get(url, { agent }, (response) => {
      status = response.statusCode ?? 0;
      length = Number(response.headers["content-length"]);
      response.on("data", (chunk: Buffer) => (received += chunk.length));
      response.on("end", () => finish("end"));
      response.on("close", () => finish("reset"));
      response.on("error", () => finish("reset"));
    });
    request.on("error", () => finish("reset"));
  });

it.live("resets the socket when Mend's body fails after the gateway sent its headers", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "RESET");
      for (const [name, kind] of [
        ["broken.mp4", "media-file"],
        ["broken.png", "workspace-file"],
      ] as const) {
        mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
          bytes: BYTES,
          canonicalPath: name,
          size: 1024 * 1024,
          failAfter: 64 * 1024,
        });
        const url = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource(name, kind) });
        const seen = yield* readOverSocket(`${mend.nodeOrigin}${url.relativeUrl}`);
        assert.strictEqual(seen.status, 200, name);
        assert.strictEqual(seen.length, 1024 * 1024, name);
        assert.isBelow(seen.received, 1024 * 1024, name);
        assert.strictEqual(seen.outcome, "reset", name);
      }
      const whole = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
      const seen = yield* readOverSocket(`${mend.nodeOrigin}${whole.relativeUrl}`);
      assert.deepStrictEqual(seen, { status: 200, length: 256, received: 256, outcome: "end" });
    }),
  ),
);

it.live("streams large files under backpressure, cancels upstream and aborts late failures", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "LARGE");
      for (const size of [512 * 1024 * 1024, 1024 * 1024 * 1024]) {
        const file = {
          bytes: BYTES,
          canonicalPath: "large.mp4",
          size,
          pulled: 0,
          cancelled: false,
        };
        mend.workbench.rawFiles.set("worktree-session-1/large.mp4", file);
        const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
          resource: resource("large.mp4", "media-file"),
        });
        assert.strictEqual(file.pulled, 0);
        const response = yield* mend.fetch(url.relativeUrl);
        assert.strictEqual(response.status, 200);
        const reader = response.body?.getReader();
        assert.isDefined(reader);
        if (reader === undefined) return;
        const first = yield* Effect.promise(() => reader.read());
        assert.strictEqual(first.value?.byteLength, 64 * 1024);
        assert.isBelow(file.pulled, 1024 * 1024);
        yield* Effect.promise(() => reader.cancel());
        assert.isTrue(file.cancelled);
      }
      mend.workbench.rawFiles.set("worktree-session-1/broken.mp4", {
        bytes: BYTES,
        canonicalPath: "broken.mp4",
        size: 1024 * 1024,
        failAfter: 64 * 1024,
      });
      const broken = yield* rpc[WS_METHODS.assetsCreateUrl]({
        resource: resource("broken.mp4", "media-file"),
      });
      const response = yield* mend.fetch(broken.relativeUrl);
      assert.strictEqual(response.status, 200);
      const body = yield* Effect.result(Effect.tryPromise(() => response.arrayBuffer()));
      assert.strictEqual(body._tag, "Failure");
    }),
  ),
);

it.effect(
  "refuses new grants at capacity, keeps existing grants and releases expired capacity",
  () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "CAPACITY");
        const first = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
        for (let i = 1; i < 256; i++)
          yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") }),
            ),
          ),
        );
        const response = yield* mend.fetch(first.relativeUrl);
        assert.strictEqual(response.status, 200);
        yield* Effect.promise(() => response.arrayBuffer());
        yield* TestClock.adjust("1 hour");
        const fresh = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
        assert.notStrictEqual(first.relativeUrl, fresh.relativeUrl);
      }),
    ),
);

it.live("keeps a media URL through an in-place edit and refuses it once the file is replaced", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "IDENTITY");
      const http = yield* HttpClient.HttpClient;
      for (const name of ["movie.mp4", "image.png"]) {
        const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
          resource: resource(name, "media-file"),
        });
        assert.strictEqual(url.fileRevision, "a".repeat(64));
        const edited = BYTES.toReversed();
        mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
          bytes: edited,
          canonicalPath: name,
          revision: "b".repeat(64),
        });
        const response = yield* http.get(url.relativeUrl);
        assert.strictEqual(response.status, 200, `${name} after an edit`);
        assert.deepStrictEqual(new Uint8Array(yield* response.arrayBuffer), edited);
        mend.workbench.rawFiles.set(`worktree-session-1/${name}`, {
          bytes: BYTES,
          canonicalPath: name,
          identity: "d".repeat(64),
        });
        assert.strictEqual(
          (yield* http.get(url.relativeUrl)).status,
          404,
          `${name} after a replacement`,
        );
      }
    }),
  ),
);

it.live("refuses all upstream failures as the same plain 404", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "ERRORS");
      for (const status of [403, 404, 409, 413, 429, 500, 503, 401]) {
        const file = { bytes: BYTES, canonicalPath: "image.png", status };
        mend.workbench.rawFiles.set("worktree-session-1/image.png", {
          bytes: BYTES,
          canonicalPath: "image.png",
        });
        const current = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
        mend.workbench.rawFiles.set("worktree-session-1/image.png", file);
        const response = yield* mend.fetch(current.relativeUrl);
        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.headers.get("cache-control"), "private, no-store");
        assert.strictEqual(yield* Effect.promise(() => response.text()), "Not Found");
      }
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") })),
        ),
      );
    }),
  ),
);

it.live("keeps grant publication within capacity when mints overlap and bounds pending mints", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "RACING");
      const mint = () => rpc[WS_METHODS.assetsCreateUrl]({ resource: resource("image.png") });
      for (let i = 0; i < 255; i++) yield* mint();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let pending = 0;
      mend.beforeRaw(() =>
        Effect.gen(function* () {
          pending++;
          if (pending === 2) yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      );
      const a = yield* Effect.forkChild(Effect.exit(mint()));
      const b = yield* Effect.forkChild(Effect.exit(mint()));
      yield* Deferred.await(entered);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(mint())));
      assert.strictEqual(pending, 2);
      yield* Deferred.succeed(release, undefined);
      const results = [yield* Fiber.join(a), yield* Fiber.join(b)];
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
    }),
  ),
);

it.live("refuses excess active reads and returns capacity when a client cancels", () =>
  withGateway((mend) =>
    Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "READS");
      mend.workbench.rawFiles.set("worktree-session-1/large.mp4", {
        bytes: BYTES,
        canonicalPath: "large.mp4",
        size: 1024 * 1024 * 1024,
      });
      const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
        resource: resource("large.mp4", "media-file"),
      });
      const responses: Response[] = [];
      for (let i = 0; i < 8; i++) {
        const response = yield* mend.fetch(url.relativeUrl);
        assert.strictEqual(response.status, 200);
        responses.push(response);
      }
      assert.strictEqual((yield* mend.fetch(url.relativeUrl)).status, 404);
      const released = responses.shift();
      const releasedBody = released?.body;
      if (releasedBody !== undefined && releasedBody !== null)
        yield* Effect.promise(() => releasedBody.cancel());
      const admitted = yield* mend.fetch(url.relativeUrl);
      assert.strictEqual(admitted.status, 200);
      responses.push(admitted);
      for (const response of responses) {
        const body = response.body;
        if (body !== null) yield* Effect.promise(() => body.cancel());
      }
    }),
  ),
);
