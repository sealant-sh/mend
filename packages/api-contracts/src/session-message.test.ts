import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SendSessionMessageRequest } from "./sessions.ts";

const decode = Schema.decodeUnknownSync(SendSessionMessageRequest, { onExcessProperty: "error" });
describe("message request", () => {
  it.each([
    { input: "" },
    { input: " \n" },
    { input: "words", queue: false },
    { input: "words", queue: "true" },
    { input: "words", clientMessageId: "wrong" },
    { input: "words", author: "alice" },
    { input: "words", turnId: "turn" },
    { input: "words", sendSteersRunningTurn: false },
  ])("rejects %j", (input) => expect(() => decode(input)).toThrow());
  it("keeps exact words and supports omitted and literal-true queue", () => {
    for (const body of [{ input: "  keep this\n" }, { input: "  keep this\n", queue: true }])
      expect(decode(body)).toEqual(body);
  });
  it("accepts equivalent UUID spellings", () => {
    for (const key of Array.from({ length: 30 }, () => crypto.randomUUID())) {
      expect(
        decode({
          input: "words",
          clientMessageId: key.toUpperCase(),
        }).clientMessageId?.toLowerCase(),
      ).toBe(key.toLowerCase());
    }
  });
});
