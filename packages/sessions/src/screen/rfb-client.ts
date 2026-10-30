import { view } from "./rfb-queue.ts";

export type Input =
  | { readonly _tag: "Key"; readonly down: boolean; readonly keysym: number }
  | { readonly _tag: "Pointer"; readonly buttons: number; readonly x: number; readonly y: number };

export type Keys =
  | { readonly _tag: "Keys"; readonly inputs: ReadonlyArray<Input> }
  | { readonly _tag: "Unsupported"; readonly key: string };

export interface Held {
  readonly keys: ReadonlySet<number>;
  readonly buttons: number;
  readonly x: number;
  readonly y: number;
}

export const NOTHING_HELD: Held = { keys: new Set(), buttons: 0, x: 0, y: 0 };

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

export const framebufferUpdateRequest = (
  incremental: boolean,
  width: number,
  height: number,
): Uint8Array =>
  message(10, (m) => {
    m.setUint8(0, 3);
    m.setUint8(1, incremental ? 1 : 0);
    m.setUint16(6, width);
    m.setUint16(8, height);
  });

const RETURN = 0xff0d;
const TAB = 0xff09;

const NAMED_KEYS: ReadonlyMap<string, number> = new Map([
  ...Object.entries({
    return: RETURN,
    enter: RETURN,
    tab: TAB,
    escape: 0xff1b,
    esc: 0xff1b,
    backspace: 0xff08,
    delete: 0xffff,
    insert: 0xff63,
    home: 0xff50,
    left: 0xff51,
    up: 0xff52,
    right: 0xff53,
    down: 0xff54,
    pageup: 0xff55,
    pagedown: 0xff56,
    end: 0xff57,
    space: 0x20,
    shift: 0xffe1,
    ctrl: 0xffe3,
    control: 0xffe3,
    alt: 0xffe9,
    meta: 0xffeb,
    super: 0xffeb,
  }),
  ...Array.from({ length: 12 }, (_, index): [string, number] => [`f${index + 1}`, 0xffbe + index]),
]);

/** X keysyms: Latin-1 characters are their own keysym, the rest of Unicode is 0x01000000 + code point. */
const characterKeysym = (character: string): number | undefined => {
  const code = character.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return code > 0xff ? 0x01000000 + code : undefined;
};

const press = (keysym: number): Input => ({ _tag: "Key", down: true, keysym });
const release = (keysym: number): Input => ({ _tag: "Key", down: false, keysym });

export const typeText = (text: string): Keys => {
  const inputs: Input[] = [];
  for (const character of text.replace(/\r\n?/g, "\n")) {
    const keysym =
      character === "\n" ? RETURN : character === "\t" ? TAB : characterKeysym(character);
    if (keysym === undefined) return { _tag: "Unsupported", key: character };
    inputs.push(press(keysym), release(keysym));
  }
  return { _tag: "Keys", inputs };
};

/** `ctrl+l`, `Return`, `ctrl+shift+t`, `ctrl++`: modifiers go down in order and up in reverse. */
export const keyCombo = (combo: string): Keys => {
  const keysyms: number[] = [];
  for (const name of combo.split(/\+(?!$)/)) {
    const keysym =
      NAMED_KEYS.get(name.toLowerCase()) ??
      ([...name].length === 1 ? characterKeysym(name) : undefined);
    if (keysym === undefined) return { _tag: "Unsupported", key: name };
    keysyms.push(keysym);
  }
  return { _tag: "Keys", inputs: [...keysyms.map(press), ...keysyms.toReversed().map(release)] };
};

export const hold = (held: Held, input: Input): Held => {
  if (input._tag === "Pointer") return { ...held, buttons: input.buttons, x: input.x, y: input.y };
  const keys = new Set(held.keys);
  if (input.down) keys.add(input.keysym);
  else keys.delete(input.keysym);
  return { ...held, keys };
};

export const releaseAll = (held: Held): ReadonlyArray<Input> => {
  const keys = [...held.keys].map(release);
  return held.buttons === 0
    ? keys
    : [...keys, { _tag: "Pointer", buttons: 0, x: held.x, y: held.y }];
};
