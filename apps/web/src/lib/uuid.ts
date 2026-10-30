/**
 * A random UUID v4 from `crypto.getRandomValues`. `crypto.randomUUID` exists only in a secure
 * context, and Mend is served over plain http on a private network.
 */
export const uuidV4 = (): string => {
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) =>
    index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte,
  );
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
