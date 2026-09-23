import { describe, expect, it } from "vitest";

import { answersFromMention } from "./answer.ts";

const retries = {
  id: "q-retries",
  options: [{ label: "Keep 3" }, { label: "Make it configurable" }],
  multiSelect: false,
};
const files = {
  id: "q-files",
  options: [{ label: "src/login.ts" }, { label: "src/retry.ts" }, { label: "README.md" }],
  multiSelect: true,
};

describe("answersFromMention", () => {
  it("answers one question with an option by label or number, or with the owner's words", () => {
    expect(answersFromMention([retries], "make it configurable.")).toEqual({
      kind: "answers",
      answers: { "q-retries": ["Make it configurable"] },
    });
    expect(answersFromMention([retries], "1")).toEqual({
      kind: "answers",
      answers: { "q-retries": ["Keep 3"] },
    });
    expect(answersFromMention([retries], "neither, use the env var\nand log it")).toEqual({
      kind: "answers",
      answers: { "q-retries": ["neither, use the env var\nand log it"] },
    });
  });

  it("takes several options for a multi-select, only when every one names an option", () => {
    expect(answersFromMention([files], "src/login.ts, 3")).toEqual({
      kind: "answers",
      answers: { "q-files": ["src/login.ts", "README.md"] },
    });
    expect(answersFromMention([files], "src/login.ts, the tests")).toEqual({
      kind: "answers",
      answers: { "q-files": ["src/login.ts, the tests"] },
    });
  });

  it("answers several questions one line each, in order, and refuses any other count", () => {
    expect(answersFromMention([retries, files], "2\n\nsrc/retry.ts")).toEqual({
      kind: "answers",
      answers: { "q-retries": ["Make it configurable"], "q-files": ["src/retry.ts"] },
    });
    expect(answersFromMention([retries, files], "2")).toEqual({
      kind: "refused",
      reason: "the agent asked 2 questions · answer one per line, in order",
    });
  });

  it("refuses an empty answer, and a question with nothing to answer", () => {
    expect(answersFromMention([retries], "  ")).toMatchObject({ kind: "refused" });
    expect(answersFromMention(null, "yes")).toMatchObject({ kind: "refused" });
    expect(answersFromMention([], "yes")).toMatchObject({ kind: "refused" });
  });
});
