import type { AgentEventItem } from "@mend/domain/workbench";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { compactMendProofCall, withMendProofResult } from "../src/mend-proof-call.ts";
import {
  ProofMissingParams,
  ProofScreenshotParams,
  ProofVideoStartParams,
  ProofVideoStopParams,
} from "../src/mend-proof-tools.ts";

const IMAGE = "iVBORw0KGgo-proof-binary";
const reference = {
  artifactId: "proof-1",
  label: "Task board · before · base abcdef1 · observed 14:02 UTC",
  message: "Recorded the screen as observed.",
};
const output = {
  content: [
    { type: "image", data: IMAGE, mimeType: "image/png" },
    { type: "text", text: JSON.stringify(reference) },
  ],
};
const item = (name = "proof_screenshot"): AgentEventItem => ({
  providerItemId: "call",
  providerTurnId: "turn",
  kind: "tool-call",
  status: "completed",
  title: name,
  text: IMAGE,
  data: {
    type: "tool_use",
    name: `mcp__mend__${name}`,
    input: { title: "Board", caption: "Task visible", side: "before" },
    result: output,
  },
});

describe("proof tool catalog and compaction", () => {
  it("bounds metadata and refuses an absent side or missing reason", () => {
    const valid = { title: "Board", caption: "Visible task", side: "before" };
    expect(Schema.is(ProofScreenshotParams)(valid)).toBe(true);
    expect(Schema.is(ProofScreenshotParams)({ ...valid, title: "a".repeat(121) })).toBe(false);
    expect(Schema.is(ProofScreenshotParams)({ ...valid, caption: "a".repeat(1001) })).toBe(false);
    expect(Schema.is(ProofScreenshotParams)({ ...valid, side: "unknown" })).toBe(false);
    expect(
      Schema.is(ProofMissingParams)({
        title: "Board",
        side: "before",
        kind: "screenshot",
        reason: "",
      }),
    ).toBe(false);
  });
  it("bounds after video metadata and accepts an empty stop", () => {
    const valid = { title: "Board", caption: "Visible task" };
    expect(Schema.is(ProofVideoStartParams)(valid)).toBe(true);
    expect(Schema.is(ProofVideoStartParams)({ ...valid, title: "a".repeat(121) })).toBe(false);
    expect(Schema.is(ProofVideoStartParams)({ ...valid, caption: "a".repeat(1001) })).toBe(false);
    expect(Schema.is(ProofVideoStopParams)({})).toBe(true);
    expect(Schema.is(ProofVideoStopParams)(42)).toBe(false);
    expect(Schema.is(ProofVideoStopParams)({ side: "before" })).toBe(false);
  });
  it.each(["proof_video_start", "proof_video_stop"])(
    "compacts %s with its artifact label",
    (name) => {
      const compact = compactMendProofCall(item(name));
      expect(compact.data).toMatchObject({ mendProofCall: reference });
      expect(JSON.stringify(compact)).not.toContain(IMAGE);
      expect(compactMendProofCall(compact)).toEqual(compact);
    },
  );
  it("keeps the artifact id and drops Codex image blocks, repeatedly", () => {
    const compact = compactMendProofCall(item());
    expect(compact.text).toBeNull();
    expect(compact.data).toMatchObject({ mendProofCall: reference });
    expect(JSON.stringify(compact)).not.toContain(IMAGE);
    expect(compactMendProofCall(compact)).toEqual(compact);
  });
  it.each([
    output,
    output.content,
    JSON.stringify(output),
    `Wall time: 0.1 seconds\nOutput:\n${JSON.stringify(output.content)}`,
  ])("keeps Claude and rollout result references", (answer) => {
    const compact = withMendProofResult(item(), answer);
    expect(compact?.data).toMatchObject({ mendProofCall: reference });
    expect(JSON.stringify(compact)).not.toContain(IMAGE);
  });
  it("drops unreadable results and leaves another server's tools alone", () => {
    expect(
      compactMendProofCall({
        ...item(),
        data: { type: "mcpToolCall", tool: "proof_screenshot", server: "another", result: output },
      }).data,
    ).toHaveProperty("result");
    expect(
      JSON.stringify(withMendProofResult(item(), [{ type: "image", data: IMAGE }])),
    ).not.toContain(IMAGE);
  });
});
