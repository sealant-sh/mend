import { describe, expect, it } from "vitest";

import { clientAddressOf, inCidr, trustsEveryAddress } from "./client-address.ts";

describe("the client address resolver", () => {
  it("is the socket's address when the socket is not a trusted hop, whatever the headers say", () => {
    expect(clientAddressOf("203.0.113.9", "10.0.0.1, 198.51.100.7", ["10.0.0.0/8"])).toBe(
      "203.0.113.9",
    );
  });

  it("is the rightmost forwarded entry that is not a trusted hop", () => {
    // client-written, client, ingress: only the ingress's own append is believed.
    expect(
      clientAddressOf("10.244.0.5", "1.2.3.4, 198.51.100.7, 10.244.0.9", ["10.244.0.0/16"]),
    ).toBe("198.51.100.7");
  });

  it("treats loopback as a trusted hop and falls back to the socket when every entry is trusted", () => {
    expect(clientAddressOf("127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    expect(clientAddressOf("::ffff:127.0.0.1", "127.0.0.1")).toBe("::ffff:127.0.0.1");
    expect(clientAddressOf(undefined, "198.51.100.7")).toBe("unknown");
  });

  it("knows a CIDR list that believes everyone", () => {
    expect(trustsEveryAddress(["10.0.0.0/8"])).toBe(false);
    expect(trustsEveryAddress(["10.0.0.0/8", "0.0.0.0/0"])).toBe(true);
    expect(inCidr("198.51.100.7", "0.0.0.0/0")).toBe(true);
  });
});
