import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import {
  accountProblems,
  authFailureOf,
  continuationOf,
  emailProblem,
  fixFieldsNote,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  safeNextPath,
} from "./onboarding.ts";
import { signInPath } from "./sign-in.ts";

describe("the account fields", () => {
  it("asks for a whole email address", () => {
    expect(emailProblem("")).toBe("Enter your email address.");
    expect(emailProblem("ada@northwind")).toBe(
      "Enter a whole email address, like ada@example.com.",
    );
    expect(emailProblem("  ada@northwind.dev ")).toBeNull();
  });

  it("names the length floor and how far short the password is", () => {
    expect(passwordProblem("")).toBe("Enter a password.");
    expect(passwordProblem("short1")).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters. This one has 6.`,
    );
    expect(passwordProblem("long enough")).toBeNull();
  });

  it("reports each field's problem at once, and the mismatch only for a long enough password", () => {
    expect(
      accountProblems({ email: "ada@northwind", password: "long enough", confirm: "long" }),
    ).toEqual({
      email: "Enter a whole email address, like ada@example.com.",
      confirm: "The passwords don't match.",
    });
    expect(accountProblems({ password: "short", confirm: "other" })).toEqual({
      password: `Use at least ${MIN_PASSWORD_LENGTH} characters. This one has 5.`,
    });
    expect(
      accountProblems({
        email: "ada@northwind.dev",
        password: "long enough",
        confirm: "long enough",
      }),
    ).toEqual({});
  });

  it("counts the fields left to fix", () => {
    expect(fixFieldsNote(1)).toBe("Fix the field above to continue.");
    expect(fixFieldsNote(2)).toBe("Fix the 2 fields above to continue.");
  });
});

describe("authFailureOf", () => {
  it("reads a refused password as wrong credentials", () => {
    expect(
      authFailureOf({
        status: 401,
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      }),
    ).toEqual({ kind: "wrong-credentials" });
  });

  it("reads a request that never left, and a proxy with no API behind it, as unreachable", () => {
    expect(authFailureOf({ thrown: new TypeError("Failed to fetch") })).toEqual({
      kind: "unreachable",
    });
    for (const status of [0, 502, 503, 504]) {
      expect(authFailureOf({ status })).toEqual({ kind: "unreachable" });
    }
  });

  it("passes any other refusal on in the server's words", () => {
    expect(authFailureOf({ status: 403, message: "Accounts are created by invitation." })).toEqual({
      kind: "refused",
      message: "Accounts are created by invitation.",
    });
    expect(authFailureOf({ status: 500 })).toEqual({
      kind: "refused",
      message: "The server refused it and gave no reason.",
    });
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

describe("where sign-in returns to", () => {
  const SLACK_LINK = "/slack/link#msl_SYN_SLACK_CODE";

  it("carries a handed-over link through sign-in in the fragment", () => {
    const login = new URL(signInPath(SLACK_LINK), "https://mend.example");
    expect(login.pathname).toBe("/login");
    expect(login.search).toBe("");
    expect(continuationOf(login)).toBe(SLACK_LINK);
  });

  it("still reads the query a server-sent walk carries", () => {
    expect(continuationOf({ search: "?next=%2Fpreview-auth%3Fpreview%3Dp1", hash: "" })).toBe(
      "/preview-auth?preview=p1",
    );
  });

  it("returns to the workbench from an unsafe continuation", () => {
    expect(continuationOf({ search: "", hash: "#next=https%3A%2F%2Fevil.example%2F" })).toBe("/");
    expect(continuationOf({ search: "?next=%2F%2Fevil.example", hash: "" })).toBe("/");
    expect(signInPath("/")).toBe("/login");
  });
});
