import { describe, expect, it } from "vitest";

import {
  composeInstruction,
  OFFLINE_WORDS,
  sendOffer,
  textToSend,
  type InstructionComment,
} from "./instruction.js";
import type { ChangeFile } from "./review-wire.js";
import { SESSION } from "./test-fixtures.js";

const file = (path: string, additions: number, deletions: number): ChangeFile => ({
  oldPath: path,
  newPath: path,
  status: "modified",
  additions,
  deletions,
  binary: false,
  hunks: [],
});

const FILES = [
  file("src/auth/limit.ts", 100, 10),
  file("src/auth/login.ts", 10, 4),
  file("src/auth/limit.test.ts", 8, 0),
  file("src/auth/throttle.ts", 2, 4),
];

const at = (
  path: string,
  line: number,
  body: string,
  createdAt: string,
  evidence: InstructionComment["evidence"] = [],
): InstructionComment => ({ path, line, endLine: line, body, evidence, createdAt });

describe("the instruction Send review opens (story d, step 6)", () => {
  it("lists her comments in the diff's order, each with its file and line, as the storyboard has it", () => {
    const text = composeInstruction({
      sessionName: "add-rate-limit",
      baseName: "main",
      headOrdinal: 6,
      files: FILES,
      comments: [
        // Written out of order: login.ts first, then limit.ts line 13, then line 12.
        at("src/auth/login.ts", 6, "Return a response here.", "2026-10-19T10:40:00.000Z"),
        at(
          "src/auth/limit.ts",
          13,
          "Nothing in this session ran the tests after limit.ts changed, so the 429 branch on line 13 never ran.",
          "2026-10-19T10:41:00.000Z",
          [{ runId: "run-1", sequence: "214", excerpt: "pnpm test auth · never ran" }],
        ),
        at(
          "src/auth/limit.ts",
          12,
          "Use the shared limiter from guard.ts",
          "2026-10-19T10:42:00.000Z",
        ),
      ],
    });
    expect(text).toBe(
      [
        "# Review for add-rate-limit",
        "",
        "<!-- Mend sends this text to add-rate-limit once. Edit it freely. -->",
        "",
        "Slice: main → checkpoint 6 · 4 files · +120 -18",
        "",
        "## 1 · src/auth/limit.ts:12",
        "Use the shared limiter from guard.ts",
        "",
        "## 2 · src/auth/limit.ts:13",
        "Nothing in this session ran the tests after limit.ts changed, so the 429 branch on line 13 never ran. (seq 214 · pnpm test auth · never ran)",
        "",
        "## 3 · src/auth/login.ts:6",
        "Return a response here.",
        "",
        "## What to do",
        "Address each comment above, then say what you changed for each one.",
        "",
      ].join("\n"),
    );
  });

  it("sends her edited text without Mend's note line", () => {
    const editor = [
      "# Review for add-rate-limit",
      "",
      "<!-- Mend sends this text to add-rate-limit once. Edit it freely. -->",
      "",
      "## 1 · src/auth/limit.ts:12",
      "Use guard.ts, and say why.",
    ].join("\n");
    expect(textToSend(editor, "add-rate-limit")).toBe(
      [
        "# Review for add-rate-limit",
        "",
        "## 1 · src/auth/limit.ts:12",
        "Use guard.ts, and say why.",
      ].join("\n"),
    );
  });
});

describe("who Send review is offered to", () => {
  const base = {
    session: SESSION,
    viewer: "dana",
    ownerName: "Dana",
    agent: null,
    offline: false,
    count: 2,
    open: null,
  } as const;

  it("is her own session's owner", () => {
    expect(sendOffer(base)).toEqual({ kind: "ready", count: 2 });
  });

  it("is not offered on Ana's session while shared control is off", () => {
    const anas = { ...base, session: { ...SESSION, ownerUserId: "ana" }, ownerName: "Ana" };
    expect(sendOffer(anas).kind).toBe("hidden");
    expect(
      sendOffer({
        ...anas,
        session: { ...anas.session, sharedControlEnabledAt: "2026-10-19T10:00:00.000Z" },
      }),
    ).toEqual({ kind: "ready", count: 2 });
  });

  it("is disabled on Ana's live terminal agent even with shared control on, as Mend refuses it", () => {
    const offer = sendOffer({
      ...base,
      session: {
        ...SESSION,
        ownerUserId: "ana",
        sharedControlEnabledAt: "2026-10-19T10:00:00.000Z",
      },
      ownerName: "Ana",
      agent: { kind: "terminal", name: "claude", hers: false },
    });
    expect(offer).toEqual({
      kind: "disabled",
      why: "claude runs in Ana's terminal · only Ana sends it a review",
    });
  });

  it("is disabled offline with her comments kept, and says so", () => {
    expect(sendOffer({ ...base, offline: true })).toEqual({ kind: "disabled", why: OFFLINE_WORDS });
    expect(OFFLINE_WORDS).toBe("Mend is offline; your comments are kept");
  });

  it("is Retry delivery after a failed one, and waits while one is sending", () => {
    expect(sendOffer({ ...base, open: "failed" })).toEqual({ kind: "retry" });
    expect(sendOffer({ ...base, open: "sending" })).toEqual({ kind: "busy" });
  });
});
