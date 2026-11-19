import { describe, expect, it } from "vitest";

import { nameProblem, newPasswordProblem, passwordLine, passwordRefusal } from "./account.ts";

const now = new Date("2026-11-18T12:00:00Z");

describe("the line under Password", () => {
  it("says when it was set, if it never changed", () => {
    const created = new Date("2026-03-02T09:00:00Z");
    expect(passwordLine({ createdAt: created, updatedAt: created }, now)).toBe(
      "You set it on 2 March.",
    );
  });

  it("says when it last changed, with the year when it isn't this one", () => {
    expect(
      passwordLine(
        {
          createdAt: new Date("2025-01-10T09:00:00Z"),
          updatedAt: new Date("2025-06-05T09:00:00Z"),
        },
        now,
      ),
    ).toBe("You last changed it on 5 June 2025.");
  });
});

describe("changing a name", () => {
  it("refuses an empty one before sending it", () => {
    expect(nameProblem("   ")).toBe("Your name can't be empty.");
    expect(nameProblem("Ada Lovelace")).toBeNull();
  });
});

describe("changing a password", () => {
  it("checks the fields before sending them", () => {
    expect(newPasswordProblem("", "long enough")?.field).toBe("current");
    expect(newPasswordProblem("old password", "short")).toEqual({
      field: "new",
      message: "Use at least 8 characters.",
    });
    expect(newPasswordProblem("same password", "same password")?.field).toBe("new");
    expect(newPasswordProblem("old password", "new password")).toBeNull();
  });

  it("puts each refusal beside the field it is about", () => {
    expect(passwordRefusal({ code: "INVALID_PASSWORD" })).toEqual({
      field: "current",
      message: "That isn't your current password.",
    });
    expect(passwordRefusal({ code: "PASSWORD_TOO_SHORT" }).field).toBe("new");
    expect(passwordRefusal({ status: 429 }).message).toBe(
      "Too many tries. Wait a minute, then try again.",
    );
    expect(passwordRefusal({ message: "Network error" })).toEqual({
      field: "form",
      message: "Mend didn't change your password. Network error",
    });
  });
});
