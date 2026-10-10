import { MendApi, PairClaimRequest } from "@mend/api-contracts";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Schema } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import {
  DEVICE_CODE_PREFIX,
  DEVICE_TOKEN_PREFIX,
  claimAddress,
  cliAuthVerifyPath,
  secondsUntil,
  configuredOriginForRequest,
  inCidr,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  generatePairingCode,
  groupPairingCode,
  hashDeviceToken,
  makeClaimLimiter,
  mintCliDeviceCode,
  mintDeviceToken,
  normalisePairingCode,
} from "./devices.ts";

describe("pairing codes", () => {
  it("draws every character from the unambiguous alphabet", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const character of code) expect(PAIRING_ALPHABET).toContain(character);
    }
  });

  it("excludes the shapes people mistype", () => {
    for (const character of "01OIL") expect(PAIRING_ALPHABET).not.toContain(character);
  });

  it("discards biased bytes rather than folding them", () => {
    // 240..255 would fold onto the first ten characters; they must be skipped.
    const bytes = [250, 251, 252, 253, 254, 255, 0, 1, 2, 3, 4, 5, 6, 7];
    let offset = 0;
    const code = generatePairingCode((count) => {
      const slice = bytes.slice(offset, offset + count);
      offset += count;
      return Uint8Array.from(slice);
    });
    expect(code).toBe("23456789");
  });

  it("normalises dashes, spaces and case to the stored form", () => {
    expect(normalisePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalisePairingCode(" ABCD efgh ")).toBe("ABCDEFGH");
    expect(normalisePairingCode("ABCD-EFGH")).toBe("ABCDEFGH");
  });

  it("groups a code for reading aloud without changing what is stored", () => {
    expect(groupPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(normalisePairingCode(groupPairingCode("ABCDEFGH"))).toBe("ABCDEFGH");
    expect(groupPairingCode("SHORT")).toBe("SHORT");
  });
});

describe("device tokens", () => {
  it("mints a prefixed, unguessable token", () => {
    const token = mintDeviceToken();
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    // 32 bytes base64url — no padding, and never the same twice.
    expect(token.slice(DEVICE_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintDeviceToken()).not.toBe(token);
  });

  it("stores a sha256 hex digest, never the token", () => {
    const hash = hashDeviceToken("mdt_example");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("mdt_");
    expect(hashDeviceToken("mdt_example")).toBe(hash);
  });
});

describe("cli authorize", () => {
  it("mints a device code as strong as a token, under its own prefix", () => {
    const code = mintCliDeviceCode();
    expect(code.startsWith(DEVICE_CODE_PREFIX)).toBe(true);
    expect(code.slice(DEVICE_CODE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintCliDeviceCode()).not.toBe(code);
  });

  it("points the browser at the grouped code on /authorize", () => {
    expect(cliAuthVerifyPath("ABCDEFGH")).toBe("/authorize?code=ABCD-EFGH");
  });

  it("counts the seconds left on the server's own clock, never below zero", () => {
    const now = Date.parse("2026-10-11T02:00:00Z");
    expect(secondsUntil(new Date(now + 600_000), now)).toBe(600);
    expect(secondsUntil(new Date(now + 1_999), now)).toBe(1);
    expect(secondsUntil(new Date(now - 5_000), now)).toBe(0);
  });
});

describe("claim rate limit", () => {
  it("lets ten failures a minute through and then answers with a wait", () => {
    const limiter = makeClaimLimiter();
    const start = 1_000_000;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.retryAfter("10.0.0.1", start)).toBeNull();
      limiter.recordFailure("10.0.0.1", start);
    }
    expect(limiter.retryAfter("10.0.0.1", start)).toBe(60);
    // The budget is per address.
    expect(limiter.retryAfter("10.0.0.2", start)).toBeNull();
  });

  it("frees the address again once the window has rolled past", () => {
    const limiter = makeClaimLimiter();
    const start = 1_000_000;
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.recordFailure("10.0.0.1", start);
    expect(limiter.retryAfter("10.0.0.1", start + 30_000)).toBe(30);
    expect(limiter.retryAfter("10.0.0.1", start + 60_001)).toBeNull();
  });
});

describe("who a failed claim is counted against", () => {
  it("keys on the socket address when the claim arrived on one", () => {
    expect(claimAddress("10.0.0.4", undefined)).toBe("10.0.0.4");
    // A header from a direct client is its own word for itself: ignored.
    expect(claimAddress("10.0.0.4", "203.0.113.9")).toBe("10.0.0.4");
  });

  it("keys on the RIGHTMOST untrusted forwarded entry when the socket is a trusted hop", () => {
    // Trusted hops append what they saw; anything left of the last untrusted
    // entry is client-writable and never believed. Here 10.0.0.1 is what the
    // loopback proxy actually observed — the leading entry is the client's own
    // (spoofable) claim.
    expect(claimAddress("127.0.0.1", "203.0.113.9, 10.0.0.1")).toBe("10.0.0.1");
    expect(claimAddress("::1", " 203.0.113.9 ")).toBe("203.0.113.9");
    expect(claimAddress("::ffff:127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
  });

  it("walks past declared trusted-proxy hops to the real client", () => {
    // Kubernetes: the API's peer is the web pod; the web tier appended the
    // phone's address. The pod CIDR is declared via MEND_TRUSTED_PROXIES.
    expect(claimAddress("10.244.1.7", "192.168.1.20", ["10.244.0.0/16"])).toBe("192.168.1.20");
    // Two trusted hops (LB pod then web pod): skip both appended entries.
    expect(claimAddress("10.244.1.7", "192.168.1.20, 10.244.2.9", ["10.244.0.0/16"])).toBe(
      "192.168.1.20",
    );
    // A peer outside the trusted set is the client, headers ignored.
    expect(claimAddress("10.9.9.9", "203.0.113.9", ["10.244.0.0/16"])).toBe("10.9.9.9");
  });

  it("falls back to the address when there is nothing better", () => {
    expect(claimAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(claimAddress("127.0.0.1", "  ")).toBe("127.0.0.1");
    expect(claimAddress(undefined, undefined)).toBe("unknown");
    // No socket address means no trusted hop: the header alone is never believed.
    expect(claimAddress(undefined, "203.0.113.9")).toBe("unknown");
    // Every forwarded entry trusted (proxy talking to itself): key on the socket.
    expect(claimAddress("127.0.0.1", "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("inCidr", () => {
  it("matches IPv4 prefixes and exact addresses, including v4-mapped v6", () => {
    expect(inCidr("10.244.3.4", "10.244.0.0/16")).toBe(true);
    expect(inCidr("10.245.0.1", "10.244.0.0/16")).toBe(false);
    expect(inCidr("::ffff:10.244.3.4", "10.244.0.0/16")).toBe(true);
    expect(inCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(inCidr("fd7a::1", "fd7a::1")).toBe(true);
    expect(inCidr("10.0.0.5", "10.0.0.0/99")).toBe(false);
  });
});

describe("the configured pairing address", () => {
  const decodeOrigin = Schema.decodeUnknownSync(PublicOrigin);
  const network = makePublicNetwork(decodeOrigin("http://localhost:3105"), [
    decodeOrigin("http://mac-mini.local:3105"),
    decodeOrigin("http://192.168.1.20:3105"),
  ]);

  it("keeps an allowed Origin or Host address", () => {
    expect(
      configuredOriginForRequest(network, {
        origin: "http://192.168.1.20:3105",
        host: "spoofed.invalid",
      }),
    ).toBe("http://192.168.1.20:3105");
    expect(configuredOriginForRequest(network, { host: "mac-mini.local:3105" })).toBe(
      "http://mac-mini.local:3105",
    );
  });

  it("ignores unlisted Host and forwarded values", () => {
    expect(
      configuredOriginForRequest(network, {
        host: "172.18.0.4:3105",
        "x-forwarded-host": "mac-mini.local:3105",
        "x-forwarded-proto": "http",
      }),
    ).toBe("http://localhost:3105");
  });
});

describe("the pairing contract", () => {
  it("keeps unknown, spent and rate-limited as separate statuses", () => {
    const statuses = new Map<string, ReadonlySet<number>>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        statuses.set(endpoint.name, new Set(errors.keys()));
      },
    });
    const claim = statuses.get("claim");
    expect(claim?.has(404)).toBe(true);
    expect(claim?.has(410)).toBe(true);
    expect(claim?.has(429)).toBe(true);
    expect(claim?.has(500)).toBe(false);
    expect(statuses.get("revoke")?.has(404)).toBe(true);
  });

  it("accepts only the platforms a device can report", () => {
    const decode = Schema.decodeUnknownSync(PairClaimRequest);
    expect(decode({ code: "ABCD-EFGH", name: "phone", platform: "ios" }).platform).toBe("ios");
    expect(() => decode({ code: "ABCD-EFGH", name: "phone", platform: "watch" })).toThrow();
  });
});
