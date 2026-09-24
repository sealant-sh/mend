import { describe, expect, it } from "vitest";

import type { AgentInputQuestionDto, AgentRequestDto } from "./feed.ts";
import {
  answersComplete,
  composeAnswers,
  recordedAnswers,
  requestAsk,
  requestDetailText,
  requestName,
  requestOutcome,
  toggleChoice,
} from "./requests.ts";

const request = (overrides: Partial<AgentRequestDto> = {}): AgentRequestDto => ({
  id: "request-1",
  turnId: "turn-1",
  kind: "command-approval",
  title: null,
  detail: null,
  questions: null,
  status: "pending",
  decision: null,
  answers: null,
  createdAt: "2026-08-21T10:00:00.000Z",
  ...overrides,
});

const pick: AgentInputQuestionDto = {
  id: "pick",
  header: "Branch",
  question: "Which branch?",
  options: [
    { label: "main", description: null },
    { label: "next", description: "the release train" },
  ],
  multiSelect: false,
};
const many: AgentInputQuestionDto = { ...pick, id: "many", header: null, multiSelect: true };

describe("request words", () => {
  it("names the request by its title, else by what it asks", () => {
    expect(requestName(request())).toBe("Run this command?");
    expect(requestName(request({ kind: "user-input" }))).toBe("The agent needs an answer");
    expect(requestName(request({ title: "Delete build/?" }))).toBe("Delete build/?");
  });

  it("says how a settled request ended", () => {
    expect(requestOutcome(request({ status: "resolved", decision: "accept-for-session" }))).toBe(
      "allowed for session",
    );
    expect(requestOutcome(request({ status: "resolved", answers: { pick: ["main"] } }))).toBe(
      "answered",
    );
    expect(requestOutcome(request({ status: "cancelled" }))).toBe("cancelled");
  });

  it("shows a request's input when it carries one", () => {
    expect(requestDetailText({ input: { command: "rm -rf build" } })).toBe(
      '{\n  "command": "rm -rf build"\n}',
    );
    expect(requestDetailText("")).toBeNull();
    expect(requestDetailText({})).toBeNull();
    expect(requestDetailText(undefined)).toBeNull();
  });

  it("knows a user-input request without questions cannot be answered here", () => {
    expect(requestAsk(request())).toBe("decision");
    expect(requestAsk(request({ kind: "user-input", questions: [pick] }))).toBe("answers");
    expect(requestAsk(request({ kind: "user-input", questions: [] }))).toBe("unanswerable");
  });
});

describe("answers", () => {
  it("replaces a single choice and accumulates multi-select choices", () => {
    const one = toggleChoice(toggleChoice({}, "pick", "main", false), "pick", "next", false);
    expect(one).toEqual({ pick: ["next"] });
    const both = toggleChoice(toggleChoice({}, "many", "main", true), "many", "next", true);
    expect(both).toEqual({ many: ["main", "next"] });
    expect(toggleChoice(both, "many", "main", true)).toEqual({ many: ["next"] });
  });

  it("lets a written answer replace a single choice and join multi-select choices", () => {
    expect(
      composeAnswers(
        [pick, many],
        { pick: ["main"], many: ["main"] },
        { pick: " dev ", many: "x" },
      ),
    ).toEqual({ pick: ["dev"], many: ["main", "x"] });
  });

  it("is complete only when every question has a choice or a written answer", () => {
    expect(answersComplete([pick, many], { pick: ["main"] }, {})).toBe(false);
    expect(answersComplete([pick, many], { pick: ["main"] }, { many: "x" })).toBe(true);
    expect(answersComplete([pick], {}, { pick: "   " })).toBe(false);
  });

  it("labels recorded answers with the question they answered", () => {
    expect(
      recordedAnswers(
        request({ questions: [pick, many], answers: { pick: ["main"], many: ["next"], gone: [] } }),
      ),
    ).toEqual([
      { question: "Branch", answers: ["main"] },
      { question: "Which branch?", answers: ["next"] },
      { question: "gone", answers: [] },
    ]);
  });
});
