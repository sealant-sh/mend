import { describe, expect, it } from "vitest";

import { exposureDetail, exposureLine } from "./exposure.ts";

describe("how this server is reached", () => {
  it("says what the operator declared, then the scheme the server observed", () => {
    expect(exposureLine({ declared: "private", originScheme: "https", arrivedVia: "direct" })).toBe(
      "exposure · private · https",
    );
  });

  it("adds a trusted proxy when the request came through one", () => {
    expect(
      exposureLine({ declared: "public", originScheme: "https", arrivedVia: "trusted-proxy" }),
    ).toBe("exposure · public · https · via proxy");
  });

  it("names the kinds of address on the host, without the addresses", () => {
    expect(exposureDetail({ addressKinds: ["loopback", "private"] })).toBe(
      "Declared by the operator. Addresses on the host: loopback, private.",
    );
    expect(exposureDetail({ addressKinds: [] })).toBe("Declared by the operator.");
  });
});
