import { it } from "@mend/test-ci/effect-vitest";
import { describe, expect } from "vitest";

import { screenReportOf } from "./script.ts";

describe("screenReportOf", () => {
  it("reads the script's status lines and nothing else", () => {
    expect(screenReportOf("mend-screen ready\r")).toEqual({ _tag: "Ready" });
    expect(screenReportOf("mend-screen degraded xfwm4")).toEqual({
      _tag: "Degraded",
      reason: "client-failed",
    });
    expect(screenReportOf("mend-screen degraded openbox")).toEqual({
      _tag: "Degraded",
      reason: "client-failed",
    });
    expect(screenReportOf("mend-screen browser sandbox off")).toEqual({
      _tag: "BrowserSandboxOff",
    });
    expect(screenReportOf(" vncext: Listening for VNC connections")).toBeNull();
  });
});
