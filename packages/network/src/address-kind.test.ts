import { describe, expect, it } from "vitest";

import { addressKindOf } from "./address-kind.ts";

describe("the kind of an address", () => {
  it.each([
    "fe80::",
    "fe81::1",
    "fe90::1",
    "feaf:1234::1",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "FE90::1%eth0",
    "fe90:0000:0000:0000:0000:0000:0000:0001",
  ])("reports %s within the complete fe80::/10 link-local prefix", (address) => {
    expect(addressKindOf(address, "IPv6")).toBe("link-local");
  });

  it.each(["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fec0::"])(
    "does not extend the link-local prefix to its neighboring boundary %s",
    (address) => {
      expect(addressKindOf(address, "IPv6")).not.toBe("link-local");
    },
  );

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
});
