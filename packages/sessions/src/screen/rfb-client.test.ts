import { describe, expect, it } from "vitest";

import { CLIENT_HANDSHAKE, RELAYED_VIEWER, queueOf } from "../../test/rfb-fixtures.ts";
import { type Input, clientCutText, encodeInput } from "./rfb-client.ts";
import { readViewer } from "./rfb-viewer.ts";

const NOVNC_INPUT = readViewer(queueOf(RELAYED_VIEWER.subarray(CLIENT_HANDSHAKE))).filter(
  (message): message is Input => message._tag === "Key" || message._tag === "Pointer",
);

describe("encodeInput", () => {
  it("writes the same KeyEvent and PointerEvent bytes noVNC sent", () => {
    const body = RELAYED_VIEWER.subarray(CLIENT_HANDSHAKE);
    const queue = queueOf();
    let start = 0;
    let compared = 0;
    body.forEach((_, at) => {
      queue.push(body.subarray(at, at + 1));
      for (const message of readViewer(queue)) {
        const sent = body.subarray(start, (start = at + 1));
        if (message._tag !== "Key" && message._tag !== "Pointer") continue;
        expect(Buffer.from(encodeInput(message)).equals(sent)).toBe(true);
        compared++;
      }
    });
    expect(compared).toBe(NOVNC_INPUT.length);
  });
});

describe("clientCutText", () => {
  it("sends Latin-1 and turns anything outside it into ?", () => {
    expect(readViewer(queueOf(clientCutText("café → ok")))).toEqual([
      { _tag: "ClientCutText", text: "café ? ok" },
    ]);
  });
});
