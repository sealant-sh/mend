/** What kind of network an address belongs to. An observation about the address, nothing more. */
export const ADDRESS_KINDS = ["loopback", "private", "cgnat", "link-local", "public"] as const;

export type AddressKind = (typeof ADDRESS_KINDS)[number];

const octets = (address: string): ReadonlyArray<number> | null => {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? parts : null;
};

/**
 * What kind of network an address belongs to. 100.64.0.0/10 is carrier-grade NAT space: Tailscale
 * numbers its nodes from it, and so do carriers, so it is reported as what it is, `cgnat`, and
 * never as "tailnet".
 */
export const addressKindOf = (address: string, family: "IPv4" | "IPv6"): AddressKind => {
  if (family === "IPv6") {
    const lower = address.toLowerCase();
    if (lower === "::1") return "loopback";
    if (lower.startsWith("fe80:")) return "link-local";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    return "public";
  }
  const parts = octets(address);
  const first = parts?.[0];
  const second = parts?.[1];
  if (first === undefined || second === undefined) return "public";
  if (first === 127) return "loopback";
  if (first === 10) return "private";
  if (first === 172 && second >= 16 && second <= 31) return "private";
  if (first === 192 && second === 168) return "private";
  if (first === 100 && second >= 64 && second <= 127) return "cgnat";
  if (first === 169 && second === 254) return "link-local";
  return "public";
};
