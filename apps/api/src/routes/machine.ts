import { hostname, networkInterfaces, platform } from "node:os";

import { MachineView, MendApi, type AddressKind } from "@mend/api-contracts";
import { isTrustedHop, NetworkConfig, trustedProxyCidrs } from "@mend/network";
import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ExposureConfig } from "../exposure.ts";

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

/** The first IPv4 address in 100.64.0.0/10 bound to any interface. Kept for older clients. */
export const detectTailnetAddress = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null => {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        addressKindOf(entry.address, "IPv4") === "cgnat"
      ) {
        return entry.address;
      }
    }
  }
  return null;
};

const KIND_ORDER: ReadonlyArray<AddressKind> = [
  "loopback",
  "private",
  "cgnat",
  "link-local",
  "public",
];

/** The kinds of address the host holds, each once, in a fixed order. No address leaves the server. */
export const observedAddressKinds = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): ReadonlyArray<AddressKind> => {
  const seen = new Set<AddressKind>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) seen.add(addressKindOf(entry.address, entry.family));
  }
  return KIND_ORDER.filter((kind) => seen.has(kind));
};

/**
 * Whether the request that asked came through an edge in front of the web tier. This process's
 * own peer is always the web tier (loopback in the bundle, a Pod in the chart), which appends the
 * address IT saw; so that hop says nothing. What says something is the entry the web tier
 * appended: when it is a trusted hop and another entry stands before it, a proxy the operator
 * named (or one on this machine) forwarded a client. A browser that reached the web tier directly
 * leaves one entry, its own address.
 */
export const arrivedThroughAnEdge = (
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: ReadonlyArray<string>,
): boolean => {
  // Forwarded entries are believed only from a trusted hop; anything else wrote its own.
  if (peer === undefined || !isTrustedHop(peer, trustedProxies)) return false;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const webTierSaw = entries.at(-1);
  return (
    entries.length >= 2 && webTierSaw !== undefined && isTrustedHop(webTierSaw, trustedProxies)
  );
};

/** Whether a browser origin names this machine's own loopback: it is reachable from here only. */
export const originOnMachine = (appUrl: string): boolean => {
  try {
    const host = new URL(appUrl).hostname;
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
};

export const readMachine = (exposure: NonNullable<MachineView["exposure"]>): MachineView => {
  const address = detectTailnetAddress();
  return new MachineView({
    hostname: hostname(),
    platform: platform(),
    tailnet:
      address === null
        ? { status: "not-detected", address: null }
        : { status: "reachable", address },
    exposure,
  });
};

export const MachineGroupLive = HttpApiBuilder.group(MendApi, "machine", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const exposure = yield* ExposureConfig;
      const network = yield* NetworkConfig;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trusted = yield* trustedProxyCidrs.pipe(Effect.orDie);
      const viaProxy = arrivedThroughAnEdge(
        Option.getOrUndefined(request.remoteAddress),
        request.headers["x-forwarded-for"],
        trusted,
      );
      return readMachine({
        declared: exposure.exposure,
        originScheme: network.appUrl.startsWith("https://") ? "https" : "http",
        originOnMachine: originOnMachine(network.appUrl),
        arrivedVia: viaProxy ? "trusted-proxy" : "direct",
        addressKinds: observedAddressKinds(),
        gateOpen: exposure.gate.filter((outcome) => outcome.established === "open").length,
      });
    }),
  ),
);
