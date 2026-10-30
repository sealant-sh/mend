/**
 * Random bytes from Web Crypto, or from Math.random where the runtime has none: Hermes ships no
 * `crypto` global and the app adds no polyfill. Callers need values that do not repeat, not
 * secrets an attacker could not guess.
 */
export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return bytes;
};

/** A UUID v4, the shape the server checks a message key against. */
export const uuidV4 = (): string => {
  const bytes = Array.from(randomBytes(16), (byte, index) =>
    index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte,
  );
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
