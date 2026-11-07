import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NativeFileRef, NativeTurnCutoff, forkSelectionOf } from "./session-history.ts";

describe("exact native fork boundaries", () => {
  it("requires a native Claude message cursor rather than Mend's logical turn id", () => {
    const decode = Schema.decodeUnknownSync(NativeTurnCutoff);
    expect(() =>
      decode({ provider: "claude", sessionId: "native", throughMessageId: "claude-turn-1" }),
    ).toThrow();
    expect(
      decode({
        provider: "claude",
        sessionId: "native",
        throughMessageId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({ provider: "claude" });
  });

  it.each([
    "/home/owner/.codex/auth.json",
    "../auth.json",
    ".codex/../auth.json",
    ".codex/auth.json",
    ".claude/settings.json",
    ".claude/shell-snapshots/a.sh",
  ])("refuses non-conversation seed path %s", (relativePath) => {
    expect(() =>
      Schema.decodeUnknownSync(NativeFileRef)({
        relativePath,
        sha256: "a".repeat(64),
        byteLength: 1,
      }),
    ).toThrow();
  });

  it("preserves explicit Default and Plan independently of later source settings", () => {
    const selected = {
      harness: "codex",
      model: null,
      effort: null,
      interactionMode: "plan",
    } as const;
    expect(
      forkSelectionOf(selected, {
        harness: "codex",
        model: "new-model",
        effort: "high",
        interactionMode: "default",
      }),
    ).toEqual(selected);
    expect(forkSelectionOf(null, selected)).toEqual(selected);
  });
});
