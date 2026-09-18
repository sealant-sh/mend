import { describe, expect, it } from "vitest";

import {
  addressKindOf,
  arrivedThroughAnEdge,
  detectTailnetAddress,
  observedAddressKinds,
} from "./machine.ts";

const iface = (address: string, internal = false) => [
  {
    address,
    netmask: "255.192.0.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  },
];

describe("detectTailnetAddress", () => {
  it("finds a CGNAT-range IPv4 address on any interface", () => {
    expect(
      detectTailnetAddress({ lo: iface("127.0.0.1", true), tailscale0: iface("100.101.1.5") }),
    ).toBe("100.101.1.5");
  });

  it("ignores addresses outside 100.64.0.0/10", () => {
    expect(
      detectTailnetAddress({ eth0: iface("100.20.0.1"), wlan0: iface("192.168.1.10") }),
    ).toBeNull();
  });

  it("treats the range edges as tailnet", () => {
    expect(detectTailnetAddress({ a: iface("100.64.0.1") })).toBe("100.64.0.1");
    expect(detectTailnetAddress({ b: iface("100.127.255.254") })).toBe("100.127.255.254");
    expect(detectTailnetAddress({ c: iface("100.128.0.1") })).toBeNull();
  });
});

describe("the kinds of address a host holds", () => {
  it("names an address by the network it belongs to, and 100.64.0.0/10 as what it is", () => {
    expect(addressKindOf("127.0.0.1", "IPv4")).toBe("loopback");
    expect(addressKindOf("10.0.0.216", "IPv4")).toBe("private");
    expect(addressKindOf("172.20.1.4", "IPv4")).toBe("private");
    expect(addressKindOf("192.168.1.10", "IPv4")).toBe("private");
    // Tailscale numbers nodes from carrier-grade NAT space, and so do carriers.
    expect(addressKindOf("100.101.1.5", "IPv4")).toBe("cgnat");
    expect(addressKindOf("169.254.10.1", "IPv4")).toBe("link-local");
    expect(addressKindOf("49.12.133.97", "IPv4")).toBe("public");
    expect(addressKindOf("172.32.0.1", "IPv4")).toBe("public");
    expect(addressKindOf("::1", "IPv6")).toBe("loopback");
    expect(addressKindOf("fe80::1", "IPv6")).toBe("link-local");
    expect(addressKindOf("fd7a:115c:a1e0::1", "IPv6")).toBe("private");
    expect(addressKindOf("2a01:4f8::1", "IPv6")).toBe("public");
  });

  it("reports each kind once, in a fixed order, and no address", () => {
    const kinds = observedAddressKinds({
      eth0: iface("49.12.133.97"),
      tailscale0: iface("100.101.1.5"),
      lo: iface("127.0.0.1", true),
      docker0: iface("172.17.0.1"),
      br0: iface("10.0.0.1"),
    });
    expect(kinds).toEqual(["loopback", "private", "cgnat", "public"]);
    expect(JSON.stringify(kinds)).not.toMatch(/\d+\.\d+/);
  });
});

describe("whether the asking request came through an edge", () => {
  const EDGE = ["192.168.250.0/28"];

  it("is not told by this process's own peer, which is always the web tier", () => {
    // The bundle: a browser straight to the web tier, which appends the browser's address.
    expect(arrivedThroughAnEdge("127.0.0.1", "203.0.113.9", EDGE)).toBe(false);
    // A browser on the machine itself.
    expect(arrivedThroughAnEdge("127.0.0.1", "127.0.0.1", EDGE)).toBe(false);
    // The chart: the web Pod is inside the trusted range, and that alone says nothing.
    expect(arrivedThroughAnEdge("10.244.1.4", "10.244.2.9", ["10.244.0.0/16"])).toBe(false);
  });

  it("is told by the entry the web tier appended being a proxy the operator named", () => {
    expect(arrivedThroughAnEdge("127.0.0.1", "203.0.113.9, 192.168.250.2", EDGE)).toBe(true);
    expect(arrivedThroughAnEdge("10.244.1.4", "203.0.113.9, 10.244.3.7", ["10.244.0.0/16"])).toBe(
      true,
    );
    // A proxy on this machine (tailscale serve, a host Caddy) forwards from loopback.
    expect(arrivedThroughAnEdge("127.0.0.1", "100.101.102.103, 127.0.0.1", [])).toBe(true);
  });

  it("believes no forwarded entry from a peer that is not a trusted hop", () => {
    expect(arrivedThroughAnEdge("203.0.113.9", "1.2.3.4, 192.168.250.2", EDGE)).toBe(false);
    expect(arrivedThroughAnEdge(undefined, "1.2.3.4, 192.168.250.2", EDGE)).toBe(false);
    // A client that writes its own X-Forwarded-For: the web tier appends the client, not a hop.
    expect(arrivedThroughAnEdge("127.0.0.1", "192.168.250.2, 203.0.113.9", EDGE)).toBe(false);
  });
});
