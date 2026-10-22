import { describe, expect, it, vi } from "vitest";

import { changeUri } from "./change-content.js";
import { fileRow, type ChangeRow } from "./change-rows.js";
import { ChangeView } from "./change-view.js";
import { RecordContent } from "./record.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import {
  FakeMend,
  FILES,
  keptIn,
  PINNED,
  PROJECT,
  session,
  sessionReads,
  storage,
  noPaste,
  SETTLE,
} from "./test-fixtures.js";

const ui = vi.hoisted(() => ({
  commands: new Map<string, (...args: ReadonlyArray<unknown>) => unknown>(),
}));

vi.mock("vscode", async () => {
  const base = await import("../test-vscode.js");
  class Range {
    constructor(
      readonly startLine: number,
      readonly startColumn: number,
      readonly endLine: number,
      readonly endColumn: number,
    ) {}
  }
  return {
    ...base,
    Range,
    EventEmitter: base.EventEmitter,
    Uri: { from: (parts: object) => ({ ...parts, toString: () => JSON.stringify(parts) }) },
    window: {
      ...base.window,
      createTreeView: () => ({ dispose: () => undefined }),
      registerFileDecorationProvider: () => ({ dispose: () => undefined }),
    },
    workspace: {
      ...base.workspace,
      registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
    },
    commands: {
      ...base.commands,
      registerCommand: (id: string, run: (...args: ReadonlyArray<unknown>) => unknown) => {
        ui.commands.set(id, run);
        return { dispose: () => ui.commands.delete(id) };
      },
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

describe("opening a pending comment's row", () => {
  it("opens the diff its file's row opens, with no base side for an added file", async () => {
    const vscode = await import("vscode");
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      new ReviewMemory(memento()),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const view = new ChangeView(
      store,
      new RecordContent(),
      () => undefined,
      async () => "",
    );
    const added = FILES.find((file) => file.status === "added");
    if (added === undefined || added.newPath === null) throw new Error("no added file");
    await store.comment({
      at: {
        worktreeId: "w1",
        path: added.newPath,
        at: PINNED.head.id,
        absent: false,
        slice: PINNED.id,
      },
      line: 3,
      endLine: 3,
      body: "Use the shared limiter",
    });
    const comments = view
      .getChildren()
      .find((row): row is Extract<ChangeRow, { kind: "comments" }> => row.kind === "comments");
    const [row] = comments?.comments ?? [];
    await ui.commands.get("mend.change.openComment")?.(row);
    const opened = vi
      .mocked(vscode.commands.executeCommand)
      .mock.calls.find(([command]) => command === "vscode.diff");
    const read = store.ready();
    if (opened === undefined || read === null) throw new Error("no diff opened");
    const { left, right } = fileRow(added, read);
    expect(opened.slice(1, 3).map(String)).toEqual([changeUri(left), changeUri(right)].map(String));
    view.dispose();
    store.dispose();
  });
});
