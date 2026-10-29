import { describe, expect, it } from "vitest";

import {
  CLIENT_HANDSHAKE,
  DEFAULTS_VIEWER,
  RELAYED_VIEWER,
  chunkings,
  queueOf,
} from "../../test/rfb-fixtures.ts";
import { ByteQueue } from "./rfb-queue.ts";
import {
  VIEWER_CUT_TEXT_CEILING,
  VIEWER_ENCODINGS_CEILING,
  type ViewerClose,
  type ViewerMessage,
  readViewer,
  viewerVerdict,
} from "./rfb-viewer.ts";

const messagesOf = (stream: Uint8Array): Array<ViewerMessage | ViewerClose> =>
  readViewer(queueOf(stream.subarray(CLIENT_HANDSHAKE)));

const RAW = 0;
const COPY_RECT = 1;
const ZRLE = 16;
const DESKTOP_SIZE = -223;
const NOVNC_EXTENSIONS = {
  fence: -312,
  continuousUpdates: -313,
  qemuExtendedKeyEvent: -258,
  extendedDesktopSize: -308,
  xvp: -309,
  extendedClipboard: -1063131698,
  extendedMouseButtons: -316,
  cursor: -239,
};

const verdictsOf = (stream: Uint8Array, holdsInput: boolean) =>
  messagesOf(stream).map((message) => viewerVerdict(message, holdsInput));

describe("readViewer", () => {
  it("splits noVNC's stream into the same messages at every chunk boundary", () => {
    const body = RELAYED_VIEWER.subarray(CLIENT_HANDSHAKE);
    const whole = readViewer(queueOf(body));
    expect(whole.map((message) => message._tag)).toContain("ClientCutText");
    for (const chunks of chunkings(body)) {
      const queue = new ByteQueue();
      const messages = chunks.flatMap((chunk) => {
        queue.push(chunk);
        return readViewer(queue);
      });
      expect(messages).toEqual(whole);
    }
  });

  it("closes on the Fence noVNC sends when Xvnc is offered its extensions", () => {
    expect(messagesOf(DEFAULTS_VIEWER).at(-1)).toEqual({
      _tag: "Close",
      reason: "unknown-type",
      type: 248,
    });
  });

  it("refuses an oversized length from its header, before the body arrives", () => {
    const cutText = Uint8Array.of(6, 0, 0, 0, 0, 1, 0, 1);
    expect(VIEWER_CUT_TEXT_CEILING).toBeLessThan(0x10001);
    expect(readViewer(queueOf(cutText))).toEqual([{ _tag: "Close", reason: "oversized", type: 6 }]);
    const encodings = Uint8Array.of(2, 0, 0, VIEWER_ENCODINGS_CEILING + 1);
    expect(readViewer(queueOf(encodings))).toEqual([
      { _tag: "Close", reason: "oversized", type: 2 },
    ]);
  });

  it("closes on any other message type", () => {
    for (const type of [1, 7, 150, 248, 250, 251, 255]) {
      expect(readViewer(queueOf(Uint8Array.of(type, 0, 0, 0)))).toEqual([
        { _tag: "Close", reason: "unknown-type", type },
      ]);
    }
  });
});

describe("viewerVerdict", () => {
  it("forwards only Raw, CopyRect, ZRLE and DesktopSize from noVNC's SetEncodings", () => {
    const setEncodings = messagesOf(RELAYED_VIEWER).find(
      (message) => message._tag === "SetEncodings",
    );
    expect(setEncodings?._tag === "SetEncodings" && setEncodings.encodings).toEqual(
      expect.arrayContaining(Object.values(NOVNC_EXTENSIONS)),
    );
    const verdict = setEncodings && viewerVerdict(setEncodings, false);
    expect(verdict?._tag).toBe("Pass");
    const forwarded = verdict?._tag === "Pass" ? readViewer(queueOf(verdict.bytes)) : [];
    expect(forwarded).toEqual([
      { _tag: "SetEncodings", encodings: [COPY_RECT, ZRLE, RAW, DESKTOP_SIZE] },
    ]);
  });

  it("sees noVNC send plain KeyEvents (type 4) once the rewrite went to Xvnc", () => {
    const messages = messagesOf(RELAYED_VIEWER);
    expect(messages.filter((message) => message._tag === "Close")).toEqual([]);
    expect(messages.filter((message) => message._tag === "Key")).toHaveLength(24);
  });

  it("re-issues the holder's keys, pointer and paste through the hand", () => {
    const verdicts = verdictsOf(RELAYED_VIEWER, true);
    const tags = new Set(verdicts.map((verdict) => verdict._tag));
    expect(tags).toEqual(new Set(["Pass", "Reissue", "Paste"]));
    expect(verdicts).toContainEqual({ _tag: "Paste", text: "pasted from the holder" });
    expect(verdicts).toContainEqual({
      _tag: "Reissue",
      input: { _tag: "Key", down: true, keysym: 0xff0d },
    });
  });

  it("drops a non-holder's keys, pointer and paste and still passes display messages", () => {
    const holder = verdictsOf(RELAYED_VIEWER, true);
    const watcher = verdictsOf(RELAYED_VIEWER, false);
    expect(watcher).toHaveLength(holder.length);
    watcher.forEach((verdict, index) => {
      const held = holder[index];
      expect(verdict).toEqual(held?._tag === "Pass" ? held : { _tag: "Drop" });
    });
  });

  it("closes a viewer whose stream closed", () => {
    expect(verdictsOf(DEFAULTS_VIEWER, true).at(-1)?._tag).toBe("Close");
  });
});
