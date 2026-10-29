import { ENCODING, type Input, setEncodings } from "./rfb-client.ts";
import { type ByteQueue, view } from "./rfb-queue.ts";

export const VIEWER_CUT_TEXT_CEILING = 65_536;
export const VIEWER_ENCODINGS_CEILING = 64;

/** No Cursor: a viewer drawing its own pointer would hide where the agent's pointer is. */
export const FORWARDED_ENCODINGS: ReadonlySet<number> = new Set(Object.values(ENCODING));

export type ViewerMessage =
  | { readonly _tag: "SetPixelFormat" | "FramebufferUpdateRequest"; readonly bytes: Uint8Array }
  | { readonly _tag: "SetEncodings"; readonly encodings: ReadonlyArray<number> }
  | { readonly _tag: "ClientCutText"; readonly text: string }
  | Input;

export type ViewerClose = {
  readonly _tag: "Close";
  readonly reason: "unknown-type" | "oversized";
  readonly type: number;
};

export type ViewerVerdict =
  | { readonly _tag: "Pass"; readonly bytes: Uint8Array }
  | { readonly _tag: "Reissue"; readonly input: Input }
  | { readonly _tag: "Paste"; readonly text: string }
  | { readonly _tag: "Drop" }
  | ViewerClose;

interface Layout {
  readonly header: number;
  readonly body?: { readonly size: (header: DataView) => number; readonly ceiling: number };
  readonly read: (bytes: Uint8Array, message: DataView) => ViewerMessage;
}

const VIEWER_MESSAGES: ReadonlyMap<number, Layout> = new Map<number, Layout>([
  [0, { header: 20, read: (bytes) => ({ _tag: "SetPixelFormat", bytes }) }],
  [
    2,
    {
      header: 4,
      body: { size: (m) => 4 * m.getUint16(2), ceiling: 4 * VIEWER_ENCODINGS_CEILING },
      read: (_, m) => ({
        _tag: "SetEncodings",
        encodings: Array.from({ length: m.getUint16(2) }, (_unused, index) =>
          m.getInt32(4 + 4 * index),
        ),
      }),
    },
  ],
  [3, { header: 10, read: (bytes) => ({ _tag: "FramebufferUpdateRequest", bytes }) }],
  [
    4,
    {
      header: 8,
      read: (_, m) => ({ _tag: "Key", down: m.getUint8(1) !== 0, keysym: m.getUint32(4) }),
    },
  ],
  [
    5,
    {
      header: 6,
      read: (_, m) => ({
        _tag: "Pointer",
        buttons: m.getUint8(1),
        x: m.getUint16(2),
        y: m.getUint16(4),
      }),
    },
  ],
  [
    6,
    {
      header: 8,
      body: { size: (m) => m.getUint32(4), ceiling: VIEWER_CUT_TEXT_CEILING },
      read: (bytes) => ({
        _tag: "ClientCutText",
        text: Buffer.from(bytes.subarray(8)).toString("latin1"),
      }),
    },
  ],
]);

/** Reads the whole messages buffered after the viewer's ClientInit; a `Close` is always last. */
export const readViewer = (queue: ByteQueue): Array<ViewerMessage | ViewerClose> => {
  const messages: Array<ViewerMessage | ViewerClose> = [];
  while (queue.length > 0) {
    const type = queue.peek(1)[0] ?? 0;
    const layout = VIEWER_MESSAGES.get(type);
    if (layout === undefined) return [...messages, { _tag: "Close", reason: "unknown-type", type }];
    if (queue.length < layout.header) break;
    const body = layout.body?.size(view(queue.peek(layout.header))) ?? 0;
    if (body > (layout.body?.ceiling ?? 0)) {
      return [...messages, { _tag: "Close", reason: "oversized", type }];
    }
    if (queue.length < layout.header + body) break;
    const bytes = queue.take(layout.header + body).slice();
    messages.push(layout.read(bytes, view(bytes)));
  }
  return messages;
};

export const forwardedEncodings = (encodings: ReadonlyArray<number>): ReadonlyArray<number> => [
  ...new Set(encodings.filter((encoding) => FORWARDED_ENCODINGS.has(encoding))),
];

export const viewerVerdict = (
  message: ViewerMessage | ViewerClose,
  holdsInput: boolean,
): ViewerVerdict => {
  switch (message._tag) {
    case "SetPixelFormat":
    case "FramebufferUpdateRequest":
      return { _tag: "Pass", bytes: message.bytes };
    case "SetEncodings":
      return { _tag: "Pass", bytes: setEncodings(forwardedEncodings(message.encodings)) };
    case "Key":
    case "Pointer":
      return holdsInput ? { _tag: "Reissue", input: message } : { _tag: "Drop" };
    case "ClientCutText":
      return holdsInput ? { _tag: "Paste", text: message.text } : { _tag: "Drop" };
    case "Close":
      return message;
  }
};
