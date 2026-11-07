import { crc32, deflateSync } from "node:zlib";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type ChatAttachment,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";

import { detectImageType, IMAGES_NOTE, parseDataUrl, turnInputOf, wordsOf } from "../src/images.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { keyedMessageFields } from "./support/keyed-message.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * Images on a message (ADR 0012, phase 2): kept by the gateway from t3code's data URL, placed in
 * the session's workspace through Mend's paste route when the message is sent, named in the turn,
 * and served back to the person through a signed URL.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const pngChunk = (name: string, data: Buffer) => {
  const contents = Buffer.concat([Buffer.from(name), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, checksum]);
};

/** A valid RGB PNG. Stored DEFLATE blocks keep the screenshot-sized fixture deterministic. */
const screenshotPng = (width: number, height: number, sizeBytes?: number) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 3;
      pixels[at] = x % 256;
      pixels[at + 1] = y % 256;
      pixels[at + 2] = (x + y) % 256;
    }
  }
  const chunks = [
    PNG.slice(0, 8),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
  ];
  if (sizeBytes !== undefined) {
    const padding = Buffer.alloc(
      sizeBytes - chunks.reduce((total, chunk) => total + chunk.length, 0) - 24,
      0x20,
    );
    padding.write("Comment\0");
    chunks.push(pngChunk("tEXt", padding));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
};
const dataUrl = (bytes: Uint8Array, mime = "image/png") =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const THREAD = ThreadId.make("session-1");

let commands = 0;
const commandId = () => CommandId.make(`image-command-${++commands}`);

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const posts = (mend: FakeMend, suffix: string) =>
  mend.workbench.calls.filter(
    (call) =>
      call.method === "POST" &&
      (call.path.endsWith(suffix) || (suffix === "/turns" && call.path.endsWith("/messages"))),
  );

const errorTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

const send = (messageId: string, text: string, attachments: ReadonlyArray<ChatAttachment>) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: THREAD,
    messageId: MessageId.make(messageId),
    text,
    attachments,
    dispatchMode: { type: "queue_after_active" },
  }) as const;

describe("images on a message", () => {
  it.live.each([
    { label: "5 MB", width: 1600, height: 1100, sizeBytes: undefined },
    { label: "exactly 10 MiB", width: 2200, height: 1500, sizeBytes: 10 * 1024 * 1024 },
  ])(
    "sends and serves a valid $label PNG through the pinned composer's data-URL fallback",
    ({ width, height, sizeBytes }) =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
          const { rpc, client } = yield* pairAndConnect(mend, "SCREENSHOT");
          const descriptor = yield* client.metadata.descriptor();
          assert.notStrictEqual(descriptor.capabilities.attachmentUploads, true);
          const config = yield* rpc[WS_METHODS.serverGetConfig]({});
          assert.notStrictEqual(config.environment.capabilities.attachmentUploads, true);
          const bytes = screenshotPng(width, height, sizeBytes);
          assert.isAbove(bytes.byteLength, 5 * 1024 * 1024);
          if (sizeBytes !== undefined) assert.strictEqual(bytes.byteLength, sizeBytes);
          // v0.1.2 chatViewSend.ts:336-371 inlines the image when attachmentUploads is absent;
          // client-runtime operations/commands.ts:279-303 persists it before message.dispatch.
          const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-screenshot"),
            attachments: [
              {
                ...upload("screenshot.png"),
                id: "composer-image-1",
                sizeBytes: bytes.byteLength,
                dataUrl: dataUrl(bytes),
              },
            ],
          });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-screenshot", "Look at this screenshot", kept.attachments),
          );
          yield* eventually(() => posts(mend, "/turns").length === 1, "the screenshot's turn");
          assert.deepStrictEqual(posts(mend, "/images")[0]?.body, {
            contentsBase64: Buffer.from(bytes).toString("base64"),
          });
          const image = kept.attachments[0];
          if (image === undefined) return assert.fail("No screenshot kept");
          const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "attachment", attachmentId: image.id },
          });
          const http = yield* HttpClient.HttpClient;
          const response = yield* http.get(url.relativeUrl);
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(new Uint8Array(yield* response.arrayBuffer), bytes);
        }),
      ),
  );

  it.live("refuses a payload larger than its declared 10 MiB, leaving the socket usable", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "LARGE-SCREENSHOT");
        const bytes = screenshotPng(2200, 1500, 10 * 1024 * 1024 + 1);
        const result = yield* Effect.exit(
          rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-large-screenshot"),
            attachments: [
              { ...upload("retina.png"), sizeBytes: 10 * 1024 * 1024, dataUrl: dataUrl(bytes) },
            ],
          }),
        );
        assert.strictEqual(errorTag(result), "PersistChatAttachmentsError");
        const error = Exit.isFailure(result)
          ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
          : undefined;
        assert.strictEqual(error?.message, "retina.png's size does not match its payload.");
        assert.strictEqual(posts(mend, "/images").length, 0);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-after-large-screenshot", "Words still send", []),
        );
        yield* eventually(() => posts(mend, "/turns").length === 1, "the next message");
      }),
    ),
  );

  it.live(
    "keeps an image, places it in the workspace when the message is sent, and serves it back",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
          const { rpc } = yield* pairAndConnect(mend, "IMAGES");

          const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-image"),
            attachments: [
              {
                type: "image",
                name: "screen.png",
                mimeType: "image/png",
                sizeBytes: PNG.byteLength,
                dataUrl: dataUrl(PNG),
              },
            ],
          });
          const image = kept.attachments[0];
          assert.isDefined(image);
          if (image === undefined) return;
          assert.isTrue(image.id.startsWith("mend-image-"));
          // Nothing reaches Mend until the message is sent.
          assert.strictEqual(posts(mend, "/images").length, 0);

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-image", "What is wrong here?", [image]),
          );
          yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
          const pasted = posts(mend, "/images")[0]?.body;
          assert.deepStrictEqual(pasted, { contentsBase64: Buffer.from(PNG).toString("base64") });
          // Mend answers where it placed the file: in a per-person executor, the sender's own
          // directory (mend#615). The turn names exactly that path.
          const path = "/workspace/harness-home/people/user-1/paste/20261010-090000-1.png";
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
            ...keyedMessageFields(posts(mend, "/turns")[0]?.body),
            selection: {
              harness: "codex",
              model: "gpt-6.1-sol",
              effort: null,
              interactionMode: "default",
            },
            input: `What is wrong here?\n\n[image: screen.png · ${path}]\n\n${IMAGES_NOTE}`,
          });

          // The client sees its own words, and the image as an attachment.
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          const message = projection.messages.find((candidate) => candidate.id === "message-image");
          assert.strictEqual(message?.text, "What is wrong here?");
          assert.strictEqual(message?.attachments[0]?.id, image.id);

          // And fetches it through a signed URL, without a bearer, as an <img> does.
          const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
            resource: { _tag: "attachment", attachmentId: image.id },
          });
          assert.isTrue(url.relativeUrl.startsWith("/api/assets/ast_"));
          const http = yield* HttpClient.HttpClient;
          const served = yield* http.get(url.relativeUrl);
          assert.strictEqual(served.status, 200);
          assert.strictEqual(served.headers["content-type"], "image/png");
          assert.deepStrictEqual(new Uint8Array(yield* served.arrayBuffer), PNG);
          const forged = yield* http.get("/api/assets/ast_forged/screen.png");
          assert.strictEqual(forged.status, 404);

          // Someone else's image id, or an unknown one, is not found.
          const unknown = yield* Effect.exit(
            rpc[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "attachment", attachmentId: "mend-image-nobody" },
            }),
          );
          assert.strictEqual(errorTag(unknown), "AssetAttachmentNotFoundError");
        }),
      ),
  );

  it.live("refuses what Mend would refuse, before anything reaches it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "REFUSE-IMAGES");
        const persist = (bytes: Uint8Array, mimeType = "image/png", sizeBytes = bytes.byteLength) =>
          Effect.exit(
            rpc[WS_METHODS.assetsPersistChatAttachments]({
              threadId: THREAD,
              messageId: MessageId.make("message-refused"),
              attachments: [
                {
                  type: "image",
                  name: "x.png",
                  mimeType,
                  sizeBytes,
                  dataUrl: dataUrl(bytes, mimeType),
                },
              ],
            }),
          );
        const text = new TextEncoder().encode("not an image");
        assert.strictEqual(errorTag(yield* persist(text)), "PersistChatAttachmentsError");
        assert.strictEqual(
          errorTag(yield* persist(PNG, "image/png", 3)),
          "PersistChatAttachmentsError",
        );
        const large = new Uint8Array(10 * 1024 * 1024 + 1);
        large.set(PNG);
        assert.strictEqual(
          errorTag(yield* persist(large, "image/png", 10 * 1024 * 1024)),
          "PersistChatAttachmentsError",
        );

        // A message naming an image the gateway does not keep, or a file, is refused.
        for (const attachment of [
          {
            type: "image",
            id: "mend-image-unknown",
            name: "x.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
          { type: "file", id: "file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 },
        ] as const) {
          const exit = yield* Effect.exit(
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
              send(`message-${attachment.id}`, "Look", [attachment]),
            ),
          );
          assert.strictEqual(errorTag(exit), "OrchestrationV2DispatchCommandError");
        }
        assert.strictEqual(posts(mend, "/images").length, 0);
        assert.strictEqual(posts(mend, "/turns").length, 0);
      }),
    ),
  );
});

const upload = (name: string) => ({
  type: "image" as const,
  name,
  mimeType: "image/png",
  sizeBytes: PNG.byteLength,
  dataUrl: dataUrl(PNG),
});

describe("what a message may carry", () => {
  it.live("persists T3's full 80 MiB image batch and refuses the next byte", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "FULL-IMAGE-BATCH");
        const bytes = screenshotPng(2200, 1500, 10 * 1024 * 1024);
        const imageUrl = dataUrl(bytes);
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-full-batch"),
          attachments: Array.from({ length: 8 }, (_, index) => ({
            ...upload(`${index}.png`),
            sizeBytes: bytes.byteLength,
            dataUrl: imageUrl,
          })),
        });
        assert.strictEqual(
          kept.attachments.reduce((total, image) => total + image.sizeBytes, 0),
          80 * 1024 * 1024,
        );
        const over = yield* Effect.exit(
          rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-over-batch"),
            attachments: [
              ...Array.from({ length: 8 }, (_, index) => ({
                ...upload(`${index}.png`),
                sizeBytes: bytes.byteLength,
                dataUrl: imageUrl,
              })),
              { ...upload("extra.png"), sizeBytes: 1, dataUrl: dataUrl(new Uint8Array([1])) },
            ],
          }),
        );
        assert.strictEqual(errorTag(over), "PersistChatAttachmentsError");
        assert.include(String(Exit.isFailure(over) ? Cause.pretty(over.cause) : ""), "80 MiB");
      }),
    ),
  );

  it.live("t3code's 100 images and 80 MiB, each once and of its own thread, however uploaded", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.addSession({ id: "session-2", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "SELECTION");
        const persist = (threadId: string, messageId: string, count: number) =>
          rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: ThreadId.make(threadId),
            messageId: MessageId.make(messageId),
            attachments: Array.from({ length: count }, (_, index) => upload(`${index}.png`)),
          }).pipe(Effect.map((kept) => kept.attachments));
        const oneTooMany = yield* Effect.exit(persist("session-1", "message-101", 101));
        assert.strictEqual(errorTag(oneTooMany), "PersistChatAttachmentsError");
        const first = yield* persist("session-1", "message-many", 100);
        const second = yield* persist("session-1", "message-many", 1);
        const many = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-many", "All of them", [...first, ...second]),
          ),
        );
        assert.strictEqual(errorTag(many), "OrchestrationV2DispatchCommandError");
        const heavy = yield* Effect.exit(
          rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-heavy"),
            attachments: Array.from({ length: 11 }, (_, index) => ({
              ...upload(`${index}.png`),
              sizeBytes: 8 * 1024 * 1024,
            })),
          }),
        );
        assert.strictEqual(errorTag(heavy), "PersistChatAttachmentsError");
        assert.include(String(Exit.isFailure(heavy) ? Cause.pretty(heavy.cause) : ""), "80 MiB");
        const twice = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-twice", "Twice", [...second, ...second]),
          ),
        );
        assert.strictEqual(errorTag(twice), "OrchestrationV2DispatchCommandError");
        // An image attached in another thread does not ride along here.
        const elsewhere = yield* persist("session-2", "message-elsewhere", 1);
        const crossed = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-crossed", "Borrowed", elsewhere),
          ),
        );
        assert.strictEqual(errorTag(crossed), "OrchestrationV2DispatchCommandError");
        assert.strictEqual(posts(mend, "/images").length, 0);
        assert.strictEqual(posts(mend, "/turns").length, 0);
      }),
    ),
  );

  it.live("sends a message of more than ten images, each placed and named in order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "ELEVEN");
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-eleven"),
          attachments: Array.from({ length: 11 }, (_, index) => upload(`${index}.png`)),
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-eleven", "All eleven", kept.attachments),
        );
        yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
        assert.strictEqual(posts(mend, "/images").length, 11);
        const body = posts(mend, "/turns")[0]?.body;
        const input =
          typeof body === "object" && body !== null && "input" in body ? String(body.input) : "";
        const named = [...input.matchAll(/\[image: (\d+)\.png · /g)].map((match) => match[1]);
        assert.deepStrictEqual(
          named,
          Array.from({ length: 11 }, (_, index) => String(index)),
        );
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const message = projection.messages.find((candidate) => candidate.id === "message-eleven");
        assert.strictEqual(message?.text, "All eleven");
        assert.strictEqual(message?.attachments.length, 11);
      }),
    ),
  );

  it.effect("places an image again for a new agent, and once for the same one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.launchBringsAgentUp = true;
        const { rpc } = yield* pairAndConnect(mend, "REPLACED");
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-one"),
          attachments: [upload("screen.png")],
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-one", "Look", kept.attachments),
        );
        yield* TestClock.withLive(
          eventually(() => posts(mend, "/turns").length === 1, "the first turn"),
        );
        const [turn] = mend.workbench.turns.get("session-1") ?? [];
        if (turn !== undefined) mend.workbench.setTurn(turn, "completed");
        // The same agent: the image is where Mend put it.
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-two", "Again", kept.attachments),
        );
        yield* TestClock.withLive(
          eventually(() => posts(mend, "/turns").length === 2, "the second turn"),
        );
        assert.strictEqual(posts(mend, "/images").length, 1);
        // A new agent may run in another workspace: the image is placed again.
        const [, second] = mend.workbench.turns.get("session-1") ?? [];
        if (second !== undefined) mend.workbench.setTurn(second, "completed");
        mend.workbench.stopAgent("session-1");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-three", "Once more", kept.attachments),
        );
        // A send that finds the agent gone waits out its backoff, then reads and launches.
        yield* timers.drive(
          { within: "1 second", deadline: "5 seconds" },
          () => (mend.workbench.turns.get("session-1") ?? []).length === 3,
          "the third turn",
        );
        assert.strictEqual(mend.workbench.launches.length, 1);
        assert.strictEqual(posts(mend, "/images").length, 2);
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("a sent message shows the images its turn carried, not those edited out", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");
        const { rpc } = yield* pairAndConnect(mend, "EDITED");
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-edited"),
          attachments: [upload("screen.png")],
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-edited", "Look at this", kept.attachments),
        );
        const queued = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const runId = queued.runs.find((run) => run.userMessageId === "message-edited")?.id;
        assert.isDefined(runId);
        if (runId === undefined) return;
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "queued-run.edit",
          commandId: commandId(),
          threadId: THREAD,
          runId,
          text: "Words only",
          attachments: [],
        });
        mend.workbench.setTurn(open, "completed");
        yield* eventually(() => posts(mend, "/turns").length === 1, "the edited turn");
        assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
          ...keyedMessageFields(posts(mend, "/turns")[0]?.body),
          selection: {
            harness: "codex",
            model: "gpt-6.1-sol",
            effort: null,
            interactionMode: "default",
          },
          input: "Words only",
        });
        assert.strictEqual(posts(mend, "/images").length, 0);
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const message = projection.messages.find((candidate) => candidate.id === "message-edited");
        assert.strictEqual(message?.text, "Words only");
        assert.deepStrictEqual(message?.attachments, []);
      }),
    ),
  );
});

describe("where an image lands", () => {
  it.live(
    "a steerer's image is placed as the steerer, and its turn is sent as the steerer, at the path Mend answered",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          // Alice's session, with shared control on: Bea may steer it but does not own it.
          mend.workbench.addSession({ id: "session-1", projectId: "project-1", own: false });
          const bea = { id: "user-2", name: "Bea", email: "bea@example.com" };
          const { rpc } = yield* pairAndConnect(mend, "STEERER-IMAGE", bea);
          const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId: THREAD,
            messageId: MessageId.make("message-steered"),
            attachments: [
              {
                type: "image",
                name: "screen.png",
                mimeType: "image/png",
                sizeBytes: PNG.byteLength,
                dataUrl: dataUrl(PNG),
              },
            ],
          });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            send("message-steered", "Look", kept.attachments),
          );
          yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
          const pasted = posts(mend, "/images")[0];
          const turn = posts(mend, "/turns")[0];
          // One sender for both: the paste lands in Bea's own directory, and her turn runs as her
          // (ADR 0016, decision 6), so her agent can read it.
          assert.isDefined(pasted?.authorization);
          assert.strictEqual(pasted?.authorization, turn?.authorization);
          const path = "/workspace/harness-home/people/user-2/paste/20261010-090000-1.png";
          assert.include(JSON.stringify(turn?.body), path);
        }),
      ),
  );

  it.live("in a shared executor, the shared paste directory Mend answers", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.sharedExecutor = true;
        const { rpc } = yield* pairAndConnect(mend, "SHARED-IMAGE");
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-shared"),
          attachments: [
            {
              type: "image",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: PNG.byteLength,
              dataUrl: dataUrl(PNG),
            },
          ],
        });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          send("message-shared", "Look", kept.attachments),
        );
        yield* eventually(() => posts(mend, "/turns").length === 1, "the turn");
        assert.include(
          JSON.stringify(posts(mend, "/turns")[0]?.body),
          "/workspace/harness-home/paste/20261010-090000-1.png",
        );
      }),
    ),
  );
});

describe("an image's signed URL", () => {
  it.live("is never written to the request log, which names the asset route by its template", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const logs: Array<string> = [];
      yield* Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const { rpc } = yield* pairAndConnect(mend, "LOGGED");
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId: THREAD,
          messageId: MessageId.make("message-logged"),
          attachments: [
            {
              type: "image",
              name: "secret-screen.png",
              mimeType: "image/png",
              sizeBytes: PNG.byteLength,
              dataUrl: dataUrl(PNG),
            },
          ],
        });
        const url = yield* rpc[WS_METHODS.assetsCreateUrl]({
          resource: { _tag: "attachment", attachmentId: kept.attachments[0]?.id ?? "" },
        });
        const http = yield* HttpClient.HttpClient;
        assert.strictEqual((yield* http.get(url.relativeUrl)).status, 200);
        assert.strictEqual((yield* http.get("/api/assets/ast_forged/x.png")).status, 404);
        const token = url.relativeUrl.split("/")[3] ?? "";
        assert.isTrue(token.startsWith("ast_"));
        const assets = logs.filter((line) => line.includes(`"http.route":"/api/assets/*"`));
        assert.strictEqual(assets.length, 2);
        const leaked = logs.filter(
          (line) => line.includes(token) || line.includes("secret-screen"),
        );
        assert.deepStrictEqual(leaked, []);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, ":memory:", { logs })));
    }),
  );
});

describe("the image helpers", () => {
  it("reads the format from the bytes, as Mend does", () => {
    assert.strictEqual(detectImageType(PNG), "image/png");
    assert.strictEqual(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0])), "image/jpeg");
    assert.isNull(detectImageType(new TextEncoder().encode("GIF7")));
    assert.isNull(parseDataUrl("not a data url"));
    assert.deepStrictEqual(parseDataUrl(dataUrl(PNG))?.bytes, PNG);
  });

  it("takes off exactly the block it added, and nothing else", () => {
    const placed = [{ name: "a.png", path: "/workspace/a.png" }];
    const input = turnInputOf("Hello", placed);
    assert.strictEqual(wordsOf(input, placed), "Hello");
    assert.strictEqual(wordsOf("Hello", placed), "Hello");
    assert.strictEqual(turnInputOf("Hello", []), "Hello");
  });
});
