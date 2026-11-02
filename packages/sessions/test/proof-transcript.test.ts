import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../src/native-convert.ts";
import { withPages } from "../src/transcript-pages.ts";

const image = "iVBORw0KGgo-proof-payload";
const text = {
  artifactId: "proof-1",
  label: "Board · checkpoint #2 · observed 14:02 UTC",
  message: "Recorded the screen as observed.",
};

describe("proof tools in the native transcript", () => {
  it("keeps the artifact reference and strips image blocks from the transcript view", () => {
    const event = {
      kind: "tool",
      name: "mcp__mend__proof_screenshot",
      args: '{"title":"Board","caption":"Empty board"}',
      argsFormat: "json",
      command: null,
      output: JSON.stringify([
        { type: "image", data: image },
        { type: "text", text: JSON.stringify(text) },
      ]),
    } satisfies CanonicalEvent;
    const entries = withPages([event], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ output: JSON.stringify(text), args: event.args });
    expect(JSON.stringify(entries)).not.toContain(image);
  });
});
