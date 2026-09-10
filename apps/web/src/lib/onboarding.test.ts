import { describe, expect, it } from "vitest";

import {
  defaultLoginMode,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  safeNextPath,
  splitDevices,
} from "./onboarding.ts";

describe("defaultLoginMode", () => {
  it("leads with registration only while the instance has no accounts", () => {
    expect(defaultLoginMode({ users: "none" })).toBe("sign-up");
    expect(defaultLoginMode({ users: "some" })).toBe("sign-in");
  });

  it("falls back to sign-in when the instance could not be asked", () => {
    expect(defaultLoginMode(undefined)).toBe("sign-in");
  });
});

describe("passwordProblem", () => {
  it("names the length floor before the mismatch", () => {
    expect(passwordProblem("short", "different")).toBe(
      `At least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  });

  it("names a mismatch once the length is fine", () => {
    expect(passwordProblem("long enough", "long enough!")).toBe("The two passwords differ.");
  });

  it("passes a matching pair", () => {
    expect(passwordProblem("long enough", "long enough")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeNextPath("/settings#devices")).toBe("/settings#devices");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});

describe("splitDevices", () => {
  it("tells CLI sign-ins from paired devices by platform", () => {
    const devices = [
      { id: "a", platform: "cli" },
      { id: "b", platform: "ios" },
      { id: "c", platform: "android" },
    ];
    expect(splitDevices(devices).machines.map((d) => d.id)).toEqual(["a"]);
    expect(splitDevices(devices).paired.map((d) => d.id)).toEqual(["b", "c"]);
  });
});
