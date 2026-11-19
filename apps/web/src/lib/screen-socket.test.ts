import { SCREEN_SOCKET_CLOSE } from "@mend/api-contracts";
import { describe, expect, it } from "vitest";

import {
  SCREEN_CLOSE_WORDS,
  ScreenChannel,
  screenCloseWords,
  type ScreenSocket,
  screenSocketUrl,
} from "./screen-socket.ts";

class FakeSocket implements ScreenSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly #events = new EventTarget();
  readonly sent: Array<Uint8Array> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.#events.addEventListener(type, listener);
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  open() {
    this.readyState = 1;
  }

  receive(data: unknown) {
    this.#events.dispatchEvent(new MessageEvent("message", { data }));
  }

  end(code: number, reason: string) {
    this.readyState = 3;
    this.#events.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

const channelOver = (socket: FakeSocket) => {
  const seen = {
    hello: [] as Array<string>,
    closed: [] as Array<{ code: number; reason: string }>,
    opened: 0,
    frames: [] as Array<ArrayBuffer>,
  };
  const channel = new ScreenChannel(socket, {
    hello: (connection) => seen.hello.push(connection),
    closed: (close) => seen.closed.push(close),
  });
  // The two handlers noVNC's Websock sets on its channel.
  Object.assign(channel, {
    onopen: () => {
      seen.opened += 1;
    },
    onmessage: (event: { readonly data: ArrayBuffer }) => seen.frames.push(event.data),
  });
  return { channel, seen };
};

describe("ScreenChannel", () => {
  it("reads the first text frame as the connection and hands noVNC only the binary frames", () => {
    const socket = new FakeSocket();
    const { channel, seen } = channelOver(socket);
    socket.open();
    expect(channel.readyState).toBe(0);

    socket.receive(JSON.stringify({ type: "connection", connection: "vc_one" }));
    const version = bytes("RFB 003.008\n");
    socket.receive(version);

    expect(seen.hello).toEqual(["vc_one"]);
    expect(seen.opened).toBe(1);
    expect(channel.readyState).toBe(1);
    expect(seen.frames).toEqual([version]);
  });

  it("opens nothing for noVNC when the first frame names no connection", () => {
    const socket = new FakeSocket();
    const { seen } = channelOver(socket);
    socket.open();
    socket.receive(bytes("RFB 003.008\n"));
    expect(seen.opened).toBe(0);
    expect(seen.frames).toEqual([]);
    expect(socket.closes).toEqual([
      { code: 4000, reason: "the screen socket named no connection" },
    ]);
  });

  it("sends noVNC's bytes as they are and reports the close with its code and reason", () => {
    const socket = new FakeSocket();
    const { channel, seen } = channelOver(socket);
    const reply = new TextEncoder().encode("RFB 003.008\n");
    channel.send(reply);
    expect(socket.sent).toEqual([reply]);
    expect(socket.binaryType).toBe("arraybuffer");

    socket.end(SCREEN_SOCKET_CLOSE.unreachable, "sign-in refused");
    expect(seen.closed).toEqual([{ code: 4502, reason: "sign-in refused" }]);
  });
});

describe("screenCloseWords", () => {
  it("has words for every close code the server sends", () => {
    for (const code of Object.values(SCREEN_SOCKET_CLOSE)) {
      expect(SCREEN_CLOSE_WORDS.get(code), `code ${code}`).toBeDefined();
    }
  });

  it.each([
    [SCREEN_SOCKET_CLOSE.screenEnded, "screen ended", "the screen stopped"],
    [SCREEN_SOCKET_CLOSE.accessEnded, "access revoked", "your access to this session ended"],
    [SCREEN_SOCKET_CLOSE.noScreen, "no live screen", "the session has no live screen"],
    [
      SCREEN_SOCKET_CLOSE.stoppedAnswering,
      "stopped answering",
      "this viewer stopped answering Mend's pings",
    ],
    [
      SCREEN_SOCKET_CLOSE.viewerRefused,
      "binary RFB only",
      "Mend refused this viewer · binary RFB only",
    ],
    [
      SCREEN_SOCKET_CLOSE.unreachable,
      "sign-in refused",
      "Mend could not reach the screen · sign-in refused",
    ],
    [1006, "", "the connection dropped"],
    [
      4000,
      "the screen socket named no connection",
      "closed with code 4000 · the screen socket named no connection",
    ],
  ])("reads %i (%s) as %s", (code, reason, words) => {
    expect(screenCloseWords({ code, reason })).toBe(words);
  });
});

describe("screenSocketUrl", () => {
  it("opens the socket on the page's own origin, secure when the page is", () => {
    expect(screenSocketUrl("ses_1", "https://mend.example")).toBe(
      "wss://mend.example/api/screen-socket?session=ses_1",
    );
    expect(screenSocketUrl("ses_1", "http://localhost:3000")).toBe(
      "ws://localhost:3000/api/screen-socket?session=ses_1",
    );
  });
});
