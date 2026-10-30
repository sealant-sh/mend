import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import {
  continuationOf,
  defaultLoginMode,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  safeNextPath,
  splitDevices,
  withContinuation,
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
  // fast-check builds its Unicode reverse lookup on first construction. Build the
  // arbitrary during collection so the deadline measures the seeded property run.
  const arbitraryNext = FastCheck.oneof(
    FastCheck.string({ unit: "binary", maxLength: 128 }),
    FastCheck.string({ unit: "binary", maxLength: 128 }).map((suffix) => `/${suffix}`),
    FastCheck.array(
      FastCheck.constantFrom(
        "/",
        "\\",
        "\t",
        "\r",
        "\n",
        " ",
        "\0",
        "evil.example",
        "mend.invalid",
        "[::1]",
        "%2f",
        "%5c",
        "?",
        "#",
        "@",
      ),
      { maxLength: 12 },
    ).map((parts) => parts.join("")),
  );

  it.each([
    "/",
    "/settings#devices",
    "/projects/project-1/sessions?view=change&slice=2#comment-3",
    "/search?next=https://evil.example/path#result",
    "/nested//path",
    "/projects/.././/settings?view=change#devices",
    "/\tsettings?label=a\tb#c\nd",
    "/encoded/%2F%5C?query=%09%0A%0D",
    "/files?path=C:\\repo\\file#back\\slash",
    "/café?filter=日本語#résumé",
  ])("preserves a same-origin path, query and fragment (%j)", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    "",
    "settings",
    "?next=/settings",
    "#devices",
    "\t/settings",
    "\n/settings",
    "\r/settings",
    " /settings",
    "\t//evil.example/",
    "https://evil.example/",
    "https://mend.example/settings",
    "javascript:alert(1)",
    "//evil.example/",
    "/\\evil.example/",
    "/\\\\evil.example/",
    "/\t/evil.example/",
    "/\n/evil.example/",
    "/\r/evil.example/",
    "/\t\\evil.example/",
    "/\r\n\t/evil.example/",
    "/\\mend.invalid/",
    "/\t/mend.invalid/",
    "/\\",
    "/\t/",
  ])("falls back for an unsafe or nonrelative next value (%j)", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it.each([undefined, null, 42, {}, ["/settings"]])(
    "falls back for a nonstring next value (%j)",
    (value) => {
      expect(safeNextPath(value)).toBe("/");
    },
  );

  it("every generated result resolves to the current origin under WHATWG URL parsing", () => {
    FastCheck.assert(
      FastCheck.property(arbitraryNext, (input) => {
        const next = safeNextPath(input);
        for (const base of [
          "https://mend.example/login",
          "http://127.0.0.1:3100/welcome",
          "https://mend.invalid/login",
          "https://other.example:8443/login",
        ]) {
          expect(new URL(next, base).origin, JSON.stringify(input)).toBe(new URL(base).origin);
        }
      }),
      { numRuns: 2_000, seed: 20261012 },
    );
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

describe("where sign-in returns to", () => {
  const SLACK_LINK = "/slack/link#msl_SYN_SLACK_CODE";

  it("carries a handed-over link through sign-in and the next step in the fragment", () => {
    const login = new URL(withContinuation("/login", SLACK_LINK), "https://mend.example");
    expect(login.search).toBe("");
    expect(continuationOf(login)).toBe(SLACK_LINK);
    const welcome = new URL(withContinuation("/welcome", continuationOf(login)), login);
    expect(welcome.pathname).toBe("/welcome");
    expect(welcome.search).toBe("");
    expect(continuationOf(welcome)).toBe(SLACK_LINK);
  });

  it("still reads the query a server-sent walk carries", () => {
    expect(continuationOf({ search: "?next=%2Fpreview-auth%3Fpreview%3Dp1", hash: "" })).toBe(
      "/preview-auth?preview=p1",
    );
  });

  it("returns to the workbench from an unsafe continuation", () => {
    expect(continuationOf({ search: "", hash: "#next=https%3A%2F%2Fevil.example%2F" })).toBe("/");
    expect(continuationOf({ search: "?next=%2F%2Fevil.example", hash: "" })).toBe("/");
    expect(withContinuation("/login", "/")).toBe("/login");
  });
});
