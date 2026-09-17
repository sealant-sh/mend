import { Config } from "effect";

const bareAddress = (address: string): string =>
  address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

const isLoopbackAddress = (address: string): boolean => {
  const bare = bareAddress(address);
  return bare === "::1" || bare.startsWith("127.");
};

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255 || part !== String(value)) return null;
    n = n * 256 + value;
  }
  return n;
};

/** IPv4 CIDR membership; a spec without a prefix is an exact address match. */
export const inCidr = (address: string, cidr: string): boolean => {
  const [base, bitsRaw] = cidr.split("/");
  const addr = ipv4ToInt(bareAddress(address));
  const net = ipv4ToInt(bareAddress(base ?? ""));
  if (addr === null || net === null) return bareAddress(address) === bareAddress(cidr);
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (addr & mask) >>> 0 === (net & mask) >>> 0;
};

/**
 * The one answer to "which address is this request from" (docs/adr/0004, "The access model"):
 * pairing, budgets and audit all key on it. Every trusted hop (the web tier, an ingress, caddy,
 * `tailscale serve`) APPENDS the address it saw to `x-forwarded-for`, so the honest client is the
 * rightmost entry that is not itself a trusted hop. Anything left of it is client-writable and is
 * never believed. A socket that is not a trusted hop is the client, headers ignored. Loopback is
 * always a trusted hop; other proxy sources are declared via `MEND_TRUSTED_PROXIES` CIDRs.
 */
/** Loopback, or inside `MEND_TRUSTED_PROXIES`: a hop whose forwarded entries are believed. */
export const isTrustedHop = (address: string, trustedProxies: ReadonlyArray<string>): boolean =>
  isLoopbackAddress(address) || trustedProxies.some((cidr) => inCidr(address, cidr));

export const clientAddressOf = (
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: ReadonlyArray<string> = [],
): string => {
  const address = remoteAddress ?? "unknown";
  if (remoteAddress === undefined || !isTrustedHop(remoteAddress, trustedProxies)) return address;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    const entry = entries[k];
    if (entry !== undefined && !isTrustedHop(entry, trustedProxies)) return entry;
  }
  return address;
};

const expandIpv6 = (address: string): ReadonlyArray<string> | null => {
  const [head = "", tail, ...rest] = address.split("::");
  if (rest.length > 0) return null;
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
};

/**
 * What a per-address window counts under. One IPv6 subscriber holds a /64 (2^64 addresses), so
 * IPv6 is counted by its /64; IPv4 and anything unparsed is counted as written.
 */
export const addressSubject = (address: string): string => {
  const bare = bareAddress(address.split("%")[0] ?? address);
  if (!bare.includes(":")) return bare;
  const groups = expandIpv6(bare);
  return groups === null ? bare : `${groups.slice(0, 4).join(":")}::/64`;
};

/** Whether a CIDR list trusts every IPv4 address, which makes every `x-forwarded-for` believable. */
export const trustsEveryAddress = (trustedProxies: ReadonlyArray<string>): boolean =>
  trustedProxies.some((cidr) => cidr.trim().endsWith("/0"));

/** `MEND_TRUSTED_PROXIES`: comma-separated CIDRs of the hops whose forwarded entries are believed. */
export const trustedProxyCidrs = Config.string("MEND_TRUSTED_PROXIES").pipe(
  Config.orElse(() => Config.succeed("")),
  Config.map((raw) =>
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  ),
);
