import { describe, expect, it } from "vitest";

import { recordText } from "./record-text.js";
import { baseName, parseReadPass, parseWorktreeChain } from "./review-wire.js";

/** `GET /changes/:id/passes` with its read pass in `status`. */
const pass = (status: string, detail: string | null = null) => [
  { kind: "tour", status: "completed", startedAt: "x", finishedAt: "y" },
  {
    kind: "read",
    status,
    detail,
    findings: 2,
    startedAt: "2026-10-19T10:42:00.000Z",
    finishedAt: status === "running" ? null : "2026-10-19T10:43:00.000Z",
  },
];

describe("what Mend's review routes answer", () => {
  it("orders the chain by ordinal and names its base by the ref it started from", () => {
    const chain = parseWorktreeChain({
      worktree: { id: "w1", baseRef: "refs/heads/main", baseSha: "abc1234def" },
      checkpoints: [
        { id: "b", ordinal: 1, trigger: "user-mark", createdAt: "2026-10-19T10:01:00.000Z" },
        { id: "a", ordinal: 0, trigger: "session-start", createdAt: "2026-10-19T10:00:00.000Z" },
      ],
    });
    expect(chain.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["a", "b"]);
    expect(chain.baseName).toBe("main");
    expect(baseName(null, "abc1234def")).toBe("abc1234");
  });

  it("reads Mend's read of the change: reading, read, or failed in Mend's words", () => {
    expect(parseReadPass(pass("running"))).toEqual({
      kind: "reading",
      since: "2026-10-19T10:42:00.000Z",
    });
    expect(parseReadPass(pass("completed"))).toMatchObject({ kind: "read", findings: 2 });
    expect(parseReadPass(pass("failed", "authentication_failed"))).toMatchObject({
      kind: "failed",
      words: "authentication_failed",
    });
    expect(parseReadPass([])).toBe(null);
  });
});

describe("Show record (G9)", () => {
  it("opens the whole transcript, the evidence it was asked for on top", () => {
    const text = recordText({
      name: "add-rate-limit",
      evidence: "seq 214 · pnpm test auth · never ran",
      entries: [
        { kind: "user", text: "add rate limiting", name: null, command: null, output: null },
        { kind: "tool", text: null, name: "Bash", command: "pnpm lint", output: "ok" },
      ],
    });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "# Record · add-rate-limit",
      "",
      "Evidence: seq 214 · pnpm test auth · never ran",
      "",
      "The whole transcript: Mend cannot open it at a record sequence yet.",
    ]);
    expect(text).toContain("## tool · Bash");
    expect(text).toContain("$ pnpm lint");
  });
});
