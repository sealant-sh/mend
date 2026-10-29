import { view } from "./rfb-queue.ts";

export type Input =
  | { readonly _tag: "Key"; readonly down: boolean; readonly keysym: number }
  | { readonly _tag: "Pointer"; readonly buttons: number; readonly x: number; readonly y: number };

const message = (size: number, write: (bytes: DataView) => void): Uint8Array => {
  const bytes = new Uint8Array(size);
  write(view(bytes));
  return bytes;
};

export const encodeInput = (input: Input): Uint8Array =>
  input._tag === "Key"
    ? message(8, (m) => {
        m.setUint8(0, 4);
        m.setUint8(1, input.down ? 1 : 0);
        m.setUint32(4, input.keysym);
      })
    : message(6, (m) => {
        m.setUint8(0, 5);
        m.setUint8(1, input.buttons);
        m.setUint16(2, input.x);
        m.setUint16(4, input.y);
      });

/** RFB cut text is Latin-1; a character outside it goes in as "?", as noVNC sends it. */
export const clientCutText = (text: string): Uint8Array => {
  const latin1 = Buffer.from(
    Array.from(text, (character) =>
      (character.codePointAt(0) ?? 0) > 0xff ? "?" : character,
    ).join(""),
    "latin1",
  );
  const bytes = message(8 + latin1.length, (m) => {
    m.setUint8(0, 6);
    m.setUint32(4, latin1.length);
  });
  bytes.set(latin1, 8);
  return bytes;
};

export const ENCODING = { raw: 0, copyRect: 1, zrle: 16, desktopSize: -223 } as const;

export const setEncodings = (encodings: ReadonlyArray<number>): Uint8Array =>
  message(4 + 4 * encodings.length, (m) => {
    m.setUint8(0, 2);
    m.setUint16(2, encodings.length);
    encodings.forEach((encoding, index) => m.setInt32(4 + 4 * index, encoding));
  });
