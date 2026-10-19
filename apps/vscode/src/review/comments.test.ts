import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewComments } from "./comments.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import { FakeMend, PINNED, PROJECT, session, sessionReads, settle } from "./test-fixtures.js";

const ui = vi.hoisted(() => ({
  commands: new Map<string, (...args: ReadonlyArray<unknown>) => unknown>(),
  warn: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
}));

vi.mock("vscode", async () => {
  const base = await import("../test-vscode.js");
  class Range {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
    constructor(startLine: number, _startColumn: number, endLine: number, _endColumn: number) {
      this.start = { line: startLine };
      this.end = { line: endLine };
    }
  }
  class MarkdownString {
    value = "";
    isTrusted: unknown;
    appendText(text: string): this {
      this.value += text;
      return this;
    }
    appendMarkdown(text: string): this {
      this.value += text;
      return this;
    }
  }
  return {
    ...base,
    Range,
    MarkdownString,
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    Uri: { from: (parts: object) => ({ ...parts, toString: () => JSON.stringify(parts) }) },
    window: { ...base.window, showWarningMessage: ui.warn },
    workspace: { ...base.workspace, textDocuments: [] },
    commands: {
      ...base.commands,
      registerCommand: (id: string, run: (...args: ReadonlyArray<unknown>) => unknown) => {
        ui.commands.set(id, run);
        return { dispose: () => ui.commands.delete(id) };
      },
    },
    comments: {
      createCommentController: () => ({
        createCommentThread: () => ({ dispose: () => undefined, comments: [] }),
        dispose: () => undefined,
      }),
    },
  };
});

const memento = (): ReviewMemento => {
  const saved = new Map<string, unknown>();
  return {
    get: (key) => saved.get(key),
    update: async (key, value) => {
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
};

/** The thread VS Code opens under the `+` on line 3 of the pinned slice's new side. */
const replyOnLine3 = (text: string) => {
  const thread = {
    uri: {
      scheme: "mend-change",
      authority: "w1",
      path: "/src/auth/limit.ts",
      query: `at=${PINNED.head.id}&slice=${PINNED.id}`,
    },
    range: { start: { line: 2 }, end: { line: 2 } },
    comments: new Array<{ readonly body: unknown; readonly label?: string }>(),
    canReply: true,
    dispose: vi.fn(),
  };
  return { thread, text };
};

const submit = async (reply: ReturnType<typeof replyOnLine3>): Promise<void> => {
  await ui.commands.get("mend.review.addComment")?.(reply);
};

beforeEach(() => {
  ui.warn.mockClear();
});

describe("submitting a comment from its thread", () => {
  it("keeps the thread and her words, and says why, when the store did not keep it", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
    );
    const comments = new ReviewComments(store);
    const reply = replyOnLine3("Use the shared limiter");
    await submit(reply);
    expect(reply.thread.dispose).not.toHaveBeenCalled();
    expect(reply.thread.comments.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringMatching(/not kept/));
    comments.dispose();
  });

  it("closes the thread once the comment is pending", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
    );
    store.follow(PROJECT, session("s1"));
    await settle();
    const comments = new ReviewComments(store);
    const reply = replyOnLine3("Use the shared limiter");
    await submit(reply);
    expect(reply.thread.dispose).toHaveBeenCalled();
    expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
    expect(ui.warn).not.toHaveBeenCalled();
    comments.dispose();
  });
});
