import { describe, expect, it } from "vitest";

import { isLoopbackHostname, serviceConnectCommand, serviceReach } from "./service.ts";

const loopback = {
  scope: "loopback" as const,
  browserUrl: "http://127.0.0.1:43127/",
  transport: "tcp" as const,
};
const tailnet = {
  scope: "private" as const,
  browserUrl: "http://100.64.0.7:43127/",
  transport: "tcp" as const,
};

describe("isLoopbackHostname", () => {
  it("names this machine for localhost, 127/8 and ::1 only", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of ["alpha.mend.run", "10.0.0.216", "100.64.0.7", "[fd7a::1]"]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("serviceReach", () => {
  it("opens a loopback endpoint only from the Mend host itself", () => {
    expect(serviceReach([loopback], true)).toEqual({
      kind: "direct",
      browserUrl: "http://127.0.0.1:43127/",
    });
    expect(serviceReach([loopback], false)).toEqual({ kind: "tunnel" });
  });

  it("prefers a private-interface endpoint, which a remote client on that network reaches", () => {
    expect(serviceReach([loopback, tailnet], false)).toEqual({
      kind: "direct",
      browserUrl: "http://100.64.0.7:43127/",
    });
  });

  it("offers no Open without a browser scheme, and no tunnel for UDP", () => {
    expect(serviceReach([{ ...loopback, browserUrl: null }], true)).toEqual({
      kind: "direct",
      browserUrl: null,
    });
    expect(serviceReach([{ ...loopback, browserUrl: null, transport: "udp" }], false)).toEqual({
      kind: "none",
    });
    expect(serviceReach([], false)).toEqual({ kind: "none" });
  });

  it("names the CLI command that tunnels it", () => {
    expect(serviceConnectCommand("web")).toBe("mend service connect web");
  });
});
