import { describe, expect, it } from "vitest";

import { exposureLine } from "./shell.tsx";

describe("the shell's exposure line", () => {
  it("states what was declared, then what was observed, and nothing about who can reach it", () => {
    expect(exposureLine({ declared: "loopback", originScheme: "http", arrivedVia: "direct" })).toBe(
      "exposure · loopback · http",
    );
    expect(
      exposureLine({ declared: "public", originScheme: "https", arrivedVia: "trusted-proxy" }),
    ).toBe("exposure · public · https · via proxy");
    for (const declared of ["loopback", "private", "public"] as const) {
      expect(exposureLine({ declared, originScheme: "https", arrivedVia: "direct" })).not.toMatch(
        /reachable|tailnet|safe/,
      );
    }
  });
});
