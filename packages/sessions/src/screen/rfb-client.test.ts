import { describe, expect, it } from "vitest";

import { CLIENT_HANDSHAKE, RELAYED_VIEWER, queueOf } from "../../test/rfb-fixtures.ts";
import {
  type Input,
  NOTHING_HELD,
  clientCutText,
  encodeInput,
  hold,
  keyCombo,
  releaseAll,
  typeText,
} from "./rfb-client.ts";
import { readViewer } from "./rfb-viewer.ts";

const NOVNC_INPUT = readViewer(queueOf(RELAYED_VIEWER.subarray(CLIENT_HANDSHAKE))).filter(
  (message): message is Input => message._tag === "Key" || message._tag === "Pointer",
);

const inputsOf = (keys: ReturnType<typeof typeText>): ReadonlyArray<Input> =>
  keys._tag === "Keys" ? keys.inputs : [];

const key = (down: boolean, keysym: number): Input => ({ _tag: "Key", down, keysym });

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

describe("typeText and keyCombo", () => {
  it("press the keys noVNC sent for the same typing", () => {
    const typed = [
      ...inputsOf(typeText("echo Mend")),
      ...inputsOf(keyCombo("Return")),
      ...inputsOf(keyCombo("ctrl+l")),
    ];
    expect(typed).toEqual(NOVNC_INPUT.filter((input) => input._tag === "Key"));
  });

  it("use Latin-1 keysyms, Unicode keysyms above them, and Return and Tab", () => {
    expect(inputsOf(typeText("Aé€😀\r\n\t"))).toEqual(
      [0x41, 0xe9, 0x010020ac, 0x0101f600, 0xff0d, 0xff09].flatMap((keysym) => [
        key(true, keysym),
        key(false, keysym),
      ]),
    );
    expect(typeText("bell\u0007")).toEqual({ _tag: "Unsupported", key: "\u0007" });
  });

  it("press modifiers in order and release them in reverse", () => {
    expect(inputsOf(keyCombo("ctrl+shift+T"))).toEqual([
      key(true, 0xffe3),
      key(true, 0xffe1),
      key(true, 0x54),
      key(false, 0x54),
      key(false, 0xffe1),
      key(false, 0xffe3),
    ]);
    expect(inputsOf(keyCombo("ctrl++"))).toEqual([
      key(true, 0xffe3),
      key(true, 0x2b),
      key(false, 0x2b),
      key(false, 0xffe3),
    ]);
    expect(inputsOf(keyCombo("F5"))).toEqual([key(true, 0xffc2), key(false, 0xffc2)]);
    expect(keyCombo("hyper+x")).toEqual({ _tag: "Unsupported", key: "hyper" });
  });
});

describe("releaseAll", () => {
  it("lets go of every key and button still held", () => {
    const held = [key(true, 0xffe3), key(true, 0x61), key(false, 0x61)]
      .concat({ _tag: "Pointer", buttons: 1, x: 40, y: 50 })
      .reduce(hold, NOTHING_HELD);
    expect(releaseAll(held)).toEqual([
      key(false, 0xffe3),
      { _tag: "Pointer", buttons: 0, x: 40, y: 50 },
    ]);
    expect(releaseAll(NOTHING_HELD)).toEqual([]);
  });
});

describe("clientCutText", () => {
  it("sends Latin-1 and turns anything outside it into ?", () => {
    expect(readViewer(queueOf(clientCutText("café → ok")))).toEqual([
      { _tag: "ClientCutText", text: "café ? ok" },
    ]);
  });
});
