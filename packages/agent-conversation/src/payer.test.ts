import { describe, expect, it } from "vitest";

import { turnPayerLine, turnPayerWords } from "./payer.ts";

const names = new Map([
  ["u-yiannis", "Yiannis"],
  ["u-maria", "Maria"],
]);

describe("turnPayerWords", () => {
  it("names the payer of a turn someone else sent, with the account as it was then", () => {
    const turn = { author: "u-maria", billedUserId: "u-yiannis", billedAccountName: "default" };
    expect(turnPayerWords(turn, "u-maria", names)).toBe("billed to Yiannis's default");
    expect(turnPayerWords(turn, null, names)).toBe("billed to Yiannis's default");
    expect(turnPayerWords(turn, "u-yiannis", names)).toBe("billed to your default");
  });

  it("says no account when none was recorded, and a member when the roster has no name", () => {
    expect(
      turnPayerWords(
        { author: "u-maria", billedUserId: "u-yiannis", billedAccountName: null },
        null,
        names,
      ),
    ).toBe("billed to Yiannis");
    expect(
      turnPayerWords(
        { author: "u-maria", billedUserId: "u-gone", billedAccountName: "work" },
        null,
        names,
      ),
    ).toBe("billed to a member's work");
  });

  it("says nothing new when the sender paid, nobody sent it, or no payer was recorded", () => {
    expect(
      turnPayerWords(
        { author: "u-maria", billedUserId: "u-maria", billedAccountName: "work" },
        null,
        names,
      ),
    ).toBeNull();
    expect(
      turnPayerWords(
        { author: null, billedUserId: "u-yiannis", billedAccountName: "default" },
        null,
        names,
      ),
    ).toBeNull();
    expect(
      turnPayerWords(
        { author: "u-maria", billedUserId: null, billedAccountName: null },
        null,
        names,
      ),
    ).toBeNull();
    // A server from before payers sends neither field.
    expect(turnPayerWords({}, null, names)).toBeNull();
  });
});

describe("turnPayerLine", () => {
  it("says who sent a turn and who paid, for a client that does not know who is looking", () => {
    expect(
      turnPayerLine(
        { author: "u-maria", billedUserId: "u-yiannis", billedAccountName: "default" },
        names,
      ),
    ).toBe("sent by Maria · billed to Yiannis's default · observed");
    expect(
      turnPayerLine(
        { author: "u-yiannis", billedUserId: "u-yiannis", billedAccountName: "default" },
        names,
      ),
    ).toBeNull();
  });
});
