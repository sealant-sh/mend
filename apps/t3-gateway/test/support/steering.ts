import {
  WS_METHODS,
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { FakeMend } from "./fake-mend.ts";
import { gatewayTestLayer } from "./gateway.ts";
import type { pairAndConnect } from "./rpc.ts";

type Item = OrchestrationV2ThreadStreamItem;
type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];
export type DispatchMessage = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

export const snapshot = (item: Item): item is Extract<Item, { kind: "snapshot" }> =>
  item.kind === "snapshot";

export const gateway = <A, E, R>(
  mend: FakeMend,
  path: string,
  test: Effect.Effect<A, E, R>,
  options: Parameters<typeof gatewayTestLayer>[2] = {},
) => test.pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, path, options)));

export const threadId = ThreadId.make("session-1");
let serial = 0;
export const commandId = () => CommandId.make(`steer-command-${++serial}`);

export const message = (
  id: string,
  mode: DispatchMessage["dispatchMode"],
  intent?: "auto" | "steer" | "restart",
): DispatchMessage => ({
  type: "message.dispatch",
  commandId: commandId(),
  threadId,
  createdBy: "user",
  creationSource: "web",
  messageId: MessageId.make(id),
  text: id,
  attachments: [],
  dispatchMode: mode,
  ...(intent === undefined ? {} : { deliveryIntent: intent }),
});

export const promote = (queuedRunId: string, targetRunId: string): OrchestrationV2Command => ({
  type: "queued-message.promote-to-steer",
  commandId: commandId(),
  threadId,
  queuedRunId: RunId.make(queuedRunId),
  targetRunId: RunId.make(targetRunId),
});

export const posts = (mend: FakeMend, suffix: string) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

export const eventually = (condition: () => boolean, attempts = 150) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error("Expected condition did not arrive."));
  });

export const setup = (mend: FakeMend, harness = "codex", text = "Opening request") => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: threadId, projectId: "project-1", harness });
  return mend.workbench.addTurn(threadId, text);
};

export const inputOf = (projection: OrchestrationV2ThreadProjection, id: string) =>
  projection.turnItems.find((item) => item.type === "user_message" && item.messageId === id);

/** Polls the thread until `condition` holds, and answers that projection. */
export const projectionWhen = (
  rpc: Rpc,
  condition: (projection: OrchestrationV2ThreadProjection) => boolean,
) =>
  Effect.gen(function* () {
    let last: OrchestrationV2ThreadProjection | null = null;
    for (let attempt = 0; attempt < 250; attempt++) {
      last = yield* rpc[methods.getThreadProjection]({ threadId });
      if (condition(last)) return last;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(
      new Error(`The thread never reached the expected state: ${JSON.stringify(last?.turnItems)}`),
    );
  });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A message carrying one kept image, so its preparation places it in Mend. */
export const withImage = (rpc: Rpc, sent: DispatchMessage) =>
  Effect.gen(function* () {
    const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
      threadId,
      messageId: sent.messageId,
      attachments: [
        {
          type: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: PNG.length,
          dataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
        },
      ],
    });
    return { ...sent, attachments: kept.attachments };
  });
