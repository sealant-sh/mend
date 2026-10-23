import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewComments } from "./comments.js";
import { NODE_FILES, type KeptFiles } from "./kept-reviews.js";
import { ReviewStore } from "./review-store.js";
import type { ServerComment } from "./review-wire.js";
import {
  comment,
  FakeMend,
  keptIn,
  PINNED,
  PROJECT,
  session,
  sessionReads,
  slowFiles,
  storage,
  noPaste,
  SETTLE,
  sendComposed,
  pinsInMemory,
} from "./test-fixtures.js";

interface Thread {
  readonly uri: { readonly scheme: string };
  comments: ReadonlyArray<{ readonly body: unknown; readonly mode?: number }>;
  disposed: boolean;
  dispose(): void;
}

interface Controller {
  readonly id: string;
  options: { readonly prompt?: string };
  readonly threads: Array<Thread>;
}

const ui = vi.hoisted(() => ({
  commands: new Map<string, (...args: ReadonlyArray<unknown>) => unknown>(),
  warn: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  controllers: new Array<Controller>(),
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
      createCommentController: (id: string) => {
        const controller: Controller = { id, options: {}, threads: [] };
        ui.controllers.push(controller);
        return Object.assign(controller, {
          createCommentThread: (uri: { readonly scheme: string }) => {
            const thread: Thread = {
              uri,
              comments: [],
              disposed: false,
              dispose: () => {
                thread.disposed = true;
                controller.threads.splice(controller.threads.indexOf(thread), 1);
              },
            };
            controller.threads.push(thread);
            return thread;
          },
          dispose: () => undefined,
        });
      },
    },
  };
});

/** The threads VS Code shows: a disposed one is gone, and so is every word in it. */
const liveThreads = (): ReadonlyArray<Thread> =>
  ui.controllers.flatMap((controller) => controller.threads);

/** Every word the live threads show. */
const shownWords = (): ReadonlyArray<string> =>
  liveThreads().flatMap((thread) =>
    thread.comments.map(({ body }) =>
      typeof body === "string"
        ? body
        : typeof body === "object" && body !== null && "value" in body
          ? String(body.value)
          : "",
    ),
  );

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
  ui.controllers.length = 0;
});

describe("submitting a comment from its thread", () => {
  it("keeps the thread and her words, and says why, when the store did not keep it", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      pinsInMemory(),
      keptIn(await storage()),
      noPaste,
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
      pinsInMemory(),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const comments = new ReviewComments(store);
    const reply = replyOnLine3("Use the shared limiter");
    await submit(reply);
    expect(reply.thread.dispose).toHaveBeenCalled();
    expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
    expect(ui.warn).not.toHaveBeenCalled();
    comments.dispose();
  });
});

describe("a double click", () => {
  it("on Add keeps one pending comment, not two", async () => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      new FakeMend(),
      pinsInMemory(),
      keptIn(await storage(), slowFiles(30)),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    const comments = new ReviewComments(store);
    const reply = replyOnLine3("Use the shared limiter");
    await Promise.all([submit(reply), submit(reply)]);
    expect(store.review().pending.map(({ body }) => body)).toEqual(["Use the shared limiter"]);
    comments.dispose();
  });
});

describe("the reply box", () => {
  it("asks for a comment on the whole change on the change's note, and on the line elsewhere", async () => {
    const mend = new FakeMend();
    mend.serverComments = [
      comment({ id: "d1", state: "draft", file: null, line: null, endLine: null }),
      comment({ id: "d2", state: "draft", line: 3 }),
    ];
    const store = new ReviewStore(
      sessionReads("change-1"),
      mend,
      pinsInMemory(),
      keptIn(await storage()),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    const comments = new ReviewComments(store);
    await vi.waitFor(
      () => expect(ui.controllers.flatMap((controller) => controller.threads)).toHaveLength(2),
      SETTLE,
    );
    const promptFor = (scheme: string): ReadonlyArray<string | undefined> =>
      ui.controllers
        .filter((controller) => controller.threads.some(({ uri }) => uri.scheme === scheme))
        .map((controller) => controller.options.prompt);
    expect(promptFor("mend-change-note")).toEqual(["Comment on the whole change"]);
    expect(promptFor("mend-change")).toEqual(["Comment on this line"]);
    comments.dispose();
    store.dispose();
  });
});

describe("saving an edit to a pending comment", () => {
  it("keeps her edited words as a new pending comment at its place, and says so, when another window already sent the comment", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    const window = async () => {
      const store = new ReviewStore(
        sessionReads("change-1"),
        mend,
        pinsInMemory(),
        keptIn(directory),
        noPaste,
      );
      store.follow(PROJECT, session("s1"));
      await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
      return store;
    };
    const sender = await window();
    const editor = await window();
    const comments = new ReviewComments(editor);
    await sender.comment({
      at: {
        worktreeId: "w1",
        path: "src/auth/limit.ts",
        at: PINNED.head.id,
        absent: false,
        slice: PINNED.id,
      },
      line: 3,
      endLine: 3,
      body: "Use the shared limiter",
    });
    await editor.reloadReview();
    const thread = liveThreads().at(0);
    if (thread === undefined) throw new Error("no thread drawn");
    await ui.commands.get("mend.review.edit")?.(thread.comments[0]);
    const [editing] = thread.comments;
    if (editing === undefined) throw new Error("not editing");
    Object.assign(editing, { body: "Use guard.ts instead" });
    const composed = sender.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(sender, composed, composed.text)).toEqual({ sent: true });
    await ui.commands.get("mend.review.save")?.(editing);
    expect(
      editor
        .review()
        .pending.map(({ path, line, endLine, body }) => ({ path, line, endLine, body })),
    ).toEqual([{ path: "src/auth/limit.ts", line: 3, endLine: 3, body: "Use guard.ts instead" }]);
    expect(shownWords()).toContain("Use guard.ts instead");
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already sent.*kept as a new pending comment/),
    );
    comments.dispose();
    sender.dispose();
    editor.dispose();
  });

  it("keeps her edited words in the review store when VS Code could not write them, though another window sent the comment and its thread is redrawn", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    let full = false;
    const fillable: KeptFiles = {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (full) throw new Error("the disk is full.");
        await NODE_FILES.writeFile(path, text);
      },
    };
    const window = async (files: KeptFiles) => {
      const store = new ReviewStore(
        sessionReads("change-1"),
        mend,
        pinsInMemory(),
        keptIn(directory, files),
        noPaste,
      );
      store.follow(PROJECT, session("s1"));
      await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
      return store;
    };
    const sender = await window(NODE_FILES);
    const editor = await window(fillable);
    const comments = new ReviewComments(editor);
    await sender.comment({
      at: {
        worktreeId: "w1",
        path: "src/auth/limit.ts",
        at: PINNED.head.id,
        absent: false,
        slice: PINNED.id,
      },
      line: 3,
      endLine: 3,
      body: "Use the shared limiter",
    });
    await editor.reloadReview();
    const thread = liveThreads().at(0);
    if (thread === undefined) throw new Error("no thread drawn");
    await ui.commands.get("mend.review.edit")?.(thread.comments[0]);
    const [editing] = thread.comments;
    if (editing === undefined) throw new Error("not editing");
    Object.assign(editing, { body: "Use guard.ts instead" });
    const composed = sender.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(sender, composed, composed.text)).toEqual({ sent: true });
    full = true;
    await ui.commands.get("mend.review.save")?.(editing);
    await editor.reloadReview();
    expect(editor.held().map((words) => words.comment.body)).toEqual(["Use guard.ts instead"]);
    expect(shownWords()).toContain("Use guard.ts instead");
    comments.dispose();
    sender.dispose();
    editor.dispose();
  });
});

const twoWindows = async () => {
  const directory = await storage();
  const mend = new FakeMend();
  const disk = { full: false };
  const fillable: KeptFiles = {
    ...NODE_FILES,
    writeFile: async (path, text) => {
      if (disk.full) throw new Error("the disk is full.");
      await NODE_FILES.writeFile(path, text);
    },
  };
  const window = async (files: KeptFiles) => {
    const store = new ReviewStore(
      sessionReads("change-1"),
      mend,
      pinsInMemory(),
      keptIn(directory, files),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
    return store;
  };
  const sender = await window(NODE_FILES);
  const editor = await window(fillable);
  await sender.comment({
    at: {
      worktreeId: "w1",
      path: "src/auth/limit.ts",
      at: PINNED.head.id,
      absent: false,
      slice: PINNED.id,
    },
    line: 3,
    endLine: 3,
    body: "Use the shared limiter",
  });
  await editor.reloadReview();
  const [shown] = editor.review().pending;
  if (shown === undefined) throw new Error("no pending comment");
  const sendIt = async () => {
    const composed = sender.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(sender, composed, composed.text)).toEqual({ sent: true });
  };
  return {
    sender,
    editor,
    disk,
    pendingId: shown.id,
    sendIt,
    bodies: () => editor.review().pending.map(({ body }) => body),
    done: () => {
      sender.dispose();
      editor.dispose();
    },
  };
};

describe("an edit VS Code could not write", () => {
  it("is kept once when she saves it again from its not-kept thread, after another window sent the comment", async () => {
    const { editor, disk, sendIt, bodies, done } = await twoWindows();
    const comments = new ReviewComments(editor);
    const saveFromThread = async (body: string) => {
      const thread = liveThreads().at(0);
      if (thread === undefined) throw new Error("no thread drawn");
      await ui.commands.get("mend.review.edit")?.(thread.comments[0]);
      const [editing] = thread.comments;
      if (editing === undefined) throw new Error("not editing");
      Object.assign(editing, { body });
      await ui.commands.get("mend.review.save")?.(editing);
    };
    await sendIt();
    disk.full = true;
    await saveFromThread("Use guard.ts instead");
    disk.full = false;
    await saveFromThread("Use guard.ts, and test the burst");
    expect(bodies()).toEqual(["Use guard.ts, and test the burst"]);
    comments.dispose();
    done();
  });

  it("is kept once when two reads of the review recover it at the same time", async () => {
    const { editor, disk, pendingId, sendIt, bodies, done } = await twoWindows();
    await sendIt();
    disk.full = true;
    await editor.edit(pendingId, "Use guard.ts instead");
    disk.full = false;
    await Promise.all([editor.reloadReview(), editor.reloadReview()]);
    expect(bodies()).toEqual(["Use guard.ts instead"]);
    done();
  });

  it("never overwrites words another window saved to the comment since, and keeps both", async () => {
    const { sender, editor, disk, pendingId, bodies, done } = await twoWindows();
    disk.full = true;
    await editor.edit(pendingId, "Older failed edit");
    disk.full = false;
    expect(await sender.edit(pendingId, "Newer successful edit")).toEqual({ kept: true });
    await editor.reloadReview();
    expect(bodies()).toEqual(
      expect.arrayContaining(["Newer successful edit", "Older failed edit"]),
    );
    expect(bodies()).toHaveLength(2);
    done();
  });
});

/**
 * VS Code's editor for a comment in edit mode, as VS Code keeps it: by the comment object, while
 * that object stays in edit mode in a thread that is not disposed. What she types reaches the
 * extension only when she saves, as the comment's body.
 */
const EDITING = 0;
const typed = new WeakMap<object, string>();

const startEditing = async (thread: Thread) => {
  await ui.commands.get("mend.review.edit")?.(thread.comments[0]);
  const [editing] = thread.comments;
  if (editing === undefined || editing.mode !== EDITING) throw new Error("not editing");
  return editing;
};

/** The words her open editors hold. */
const openEdits = (): ReadonlyArray<string> =>
  liveThreads().flatMap((thread) =>
    thread.comments.flatMap((shown) => {
      const words = typed.get(shown);
      return shown.mode === EDITING && words !== undefined ? [words] : [];
    }),
  );

const saveEdit = async (editing: object): Promise<void> => {
  Object.assign(editing, { body: typed.get(editing) });
  await ui.commands.get("mend.review.save")?.(editing);
};

describe("her words in an open edit, when another window changes the review", () => {
  const WORDS = "Use guard.ts instead";

  it("stay in her editor when another window sends the comment, and are kept once as a new pending comment at its place when she saves", async () => {
    const { editor, sendIt, done } = await twoWindows();
    const comments = new ReviewComments(editor);
    const [thread] = liveThreads();
    if (thread === undefined) throw new Error("no thread drawn");
    typed.set(await startEditing(thread), WORDS);
    const [editing] = thread.comments;
    if (editing === undefined) throw new Error("not editing");
    await sendIt();
    await editor.reloadReview();
    expect(openEdits()).toEqual([WORDS]);
    await saveEdit(editing);
    expect(openEdits()).toEqual([]);
    const place = () =>
      editor
        .review()
        .pending.map(({ path, line, endLine, body }) => ({ path, line, endLine, body }));
    expect(place()).toEqual([{ path: "src/auth/limit.ts", line: 3, endLine: 3, body: WORDS }]);
    expect(ui.warn).toHaveBeenCalledTimes(1);
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already sent.*kept as a new pending comment at the same place/),
    );
    await editor.reloadReview();
    expect(place()).toEqual([{ path: "src/auth/limit.ts", line: 3, endLine: 3, body: WORDS }]);
    expect(shownWords().filter((words) => words.includes(WORDS))).toHaveLength(1);
    comments.dispose();
    done();
  });

  it("stay in her editor when another window deletes the comment, and are kept as a new pending comment at its place when she saves", async () => {
    const { sender, editor, pendingId, done } = await twoWindows();
    const comments = new ReviewComments(editor);
    const [thread] = liveThreads();
    if (thread === undefined) throw new Error("no thread drawn");
    const editing = await startEditing(thread);
    typed.set(editing, WORDS);
    await sender.remove(pendingId);
    await editor.reloadReview();
    expect(openEdits()).toEqual([WORDS]);
    await saveEdit(editing);
    expect(editor.review().pending.map(({ path, line, body }) => ({ path, line, body }))).toEqual([
      { path: "src/auth/limit.ts", line: 3, body: WORDS },
    ]);
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringMatching(/deleted in another window.*kept as a new pending comment/),
    );
    comments.dispose();
    done();
  });

  it("stay in her editor when another window edits the comment, and both words are kept when she saves", async () => {
    const { sender, editor, pendingId, bodies, done } = await twoWindows();
    const comments = new ReviewComments(editor);
    const [thread] = liveThreads();
    if (thread === undefined) throw new Error("no thread drawn");
    const editing = await startEditing(thread);
    typed.set(editing, WORDS);
    expect(await sender.edit(pendingId, "Count the burst per key")).toEqual({ kept: true });
    await editor.reloadReview();
    expect(openEdits()).toEqual([WORDS]);
    await saveEdit(editing);
    expect(bodies()).toEqual(expect.arrayContaining(["Count the burst per key", WORDS]));
    expect(bodies()).toHaveLength(2);
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Another window changed this comment.*kept as a new pending comment/),
    );
    comments.dispose();
    done();
  });

  it("stay in her editor of an accepted Mend draft when another window sends it, and are kept as a new pending comment when she saves", async () => {
    const directory = await storage();
    const mend = new FakeMend();
    mend.serverComments = [comment({ id: "d1", state: "draft", line: 3 })];
    const window = async () => {
      const store = new ReviewStore(
        sessionReads("change-1"),
        mend,
        pinsInMemory(),
        keptIn(directory),
        noPaste,
      );
      store.follow(PROJECT, session("s1"));
      await vi.waitFor(() => expect(store.ready()?.comments).toHaveLength(1), SETTLE);
      return store;
    };
    const sender = await window();
    const editor = await window();
    expect(await sender.accept("d1", "")).toEqual({ kept: true });
    const comments = new ReviewComments(editor);
    await editor.reloadReview();
    const [thread] = liveThreads();
    if (thread === undefined) throw new Error("no thread drawn");
    const editing = await startEditing(thread);
    typed.set(editing, WORDS);
    const composed = sender.compose();
    if (composed === null) throw new Error("nothing composed");
    expect(await sendComposed(sender, composed, composed.text)).toEqual({ sent: true });
    await editor.reloadReview();
    expect(openEdits()).toEqual([WORDS]);
    await saveEdit(editing);
    expect(editor.review().pending.map(({ line, body }) => ({ line, body }))).toEqual([
      { line: 3, body: WORDS },
    ]);
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already sent.*kept as a new pending comment/),
    );
    comments.dispose();
    sender.dispose();
    editor.dispose();
  });

  it("stay in her editor when the section follows another session, and are kept under the session she edited", async () => {
    const { editor, done } = await twoWindows();
    const comments = new ReviewComments(editor);
    const [thread] = liveThreads();
    if (thread === undefined) throw new Error("no thread drawn");
    const editing = await startEditing(thread);
    typed.set(editing, WORDS);
    editor.follow(PROJECT, session("s2"));
    await vi.waitFor(() => expect(editor.ready()?.sessionId).toBe("s2"), SETTLE);
    expect(openEdits()).toEqual([WORDS]);
    await saveEdit(editing);
    expect(editor.review().pending).toEqual([]);
    editor.follow(PROJECT, session("s1"));
    await vi.waitFor(() => expect(editor.ready()?.sessionId).toBe("s1"), SETTLE);
    expect(editor.review().pending.map(({ body }) => body)).toEqual([WORDS]);
    comments.dispose();
    done();
  });
});

describe("her words under a Mend draft", () => {
  const WORDS = "I ran them by hand";
  const DRAFT = comment({
    id: "d1",
    state: "draft",
    line: 3,
    author: { kind: "mend", name: "Mend" },
    body: "Nothing in this session ran the tests.",
  });
  const fullDisk: KeptFiles = {
    ...NODE_FILES,
    writeFile: async () => {
      throw new Error("the disk is full.");
    },
  };

  const underDraft = async (mend: FakeMend, files: KeptFiles = NODE_FILES) => {
    mend.serverComments = [DRAFT];
    const store = new ReviewStore(
      sessionReads("change-1"),
      mend,
      pinsInMemory(),
      keptIn(await storage(), files),
      noPaste,
    );
    store.follow(PROJECT, session("s1"));
    const comments = new ReviewComments(store);
    await vi.waitFor(
      () => expect(ui.controllers.flatMap((controller) => controller.threads)).toHaveLength(1),
      SETTLE,
    );
    const thread = liveThreads().at(0);
    if (thread === undefined) throw new Error("no draft drawn");
    const keptOrHeld = (): ReadonlyArray<unknown> => [
      ...store.review().pending.map(({ body }) => body),
      ...shownWords(),
    ];
    return {
      store,
      thread,
      reply: { thread, text: WORDS },
      keptOrHeld,
      done: () => {
        comments.dispose();
        store.dispose();
      },
    };
  };

  it("stay in the thread, with why, when VS Code could not keep an Accept", async () => {
    const { reply, keptOrHeld, done } = await underDraft(new FakeMend(), fullDisk);
    await Promise.resolve(ui.commands.get("mend.review.accept")?.(reply)).catch(() => undefined);
    expect(keptOrHeld()).toContain(WORDS);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringMatching(/the disk is full/));
    done();
  });

  it("stay when VS Code could not keep a Dismiss", async () => {
    const { reply, keptOrHeld, done } = await underDraft(new FakeMend(), fullDisk);
    await Promise.resolve(ui.commands.get("mend.review.dismiss")?.(reply)).catch(() => undefined);
    expect(keptOrHeld()).toContain(WORDS);
    done();
  });

  it("stay when Mend refused the Dismiss", async () => {
    class Refusing extends FakeMend {
      override async setCommentState(): Promise<ServerComment> {
        throw new Error("Mend is restarting.");
      }
    }
    const { reply, keptOrHeld, done } = await underDraft(new Refusing());
    await ui.commands.get("mend.review.dismiss")?.(reply);
    expect(keptOrHeld()).toContain(WORDS);
    done();
  });

  it("stay when the draft's thread is drawn away, after VS Code could not keep an Accept", async () => {
    const mend = new FakeMend();
    const { store, reply, done } = await underDraft(mend, fullDisk);
    await Promise.resolve(ui.commands.get("mend.review.accept")?.(reply)).catch(() => undefined);
    mend.serverComments = [{ ...DRAFT, state: "dismissed" }];
    store.reread();
    await vi.waitFor(
      () => expect(shownWords()).not.toContain("Nothing in this session ran the tests."),
      SETTLE,
    );
    expect(shownWords()).toContain(WORDS);
    done();
  });

  it.each(["accept", "dismiss"])(
    "are kept at the draft's place when %s arrives after the draft's thread was redrawn away",
    async (gesture) => {
      const mend = new FakeMend();
      const { store, thread, done } = await underDraft(mend);
      mend.serverComments = [{ ...DRAFT, state: "dismissed" }];
      store.reread();
      await vi.waitFor(() => expect(thread.disposed).toBe(true), SETTLE);
      await ui.commands.get(`mend.review.${gesture}`)?.({ thread, text: WORDS });
      expect(store.review().pending.map(({ path, line, body }) => ({ path, line, body }))).toEqual([
        { path: DRAFT.file, line: DRAFT.line, body: WORDS },
      ]);
      expect(shownWords()).toContain(WORDS);
      done();
    },
  );

  it.each(["accept", "dismiss"])(
    "are kept under the session whose thread showed the draft when %s arrives after another session on the change showed it",
    async (gesture) => {
      const { store, thread, done } = await underDraft(new FakeMend());
      store.follow(PROJECT, session("s2"));
      await vi.waitFor(() => expect(store.ready()?.sessionId).toBe("s2"), SETTLE);
      expect(thread.disposed).toBe(true);
      await ui.commands.get(`mend.review.${gesture}`)?.({ thread, text: WORDS });
      expect(store.review().pending).toEqual([]);
      store.follow(PROJECT, session("s1"));
      await vi.waitFor(() => expect(store.ready()?.sessionId).toBe("s1"), SETTLE);
      expect(store.review().pending.map(({ body }) => body)).toContain(WORDS);
      done();
    },
  );

  it("stay in the draft's thread while it is redrawn and after the draft is gone, where Mend could not name her account", async () => {
    const mend = new FakeMend();
    mend.serverComments = [DRAFT];
    const unnamed = { ...sessionReads("change-1"), accountOf: async () => null };
    const store = new ReviewStore(unnamed, mend, pinsInMemory(), keptIn(await storage()), noPaste);
    store.follow(PROJECT, session("s1"));
    const comments = new ReviewComments(store);
    await vi.waitFor(() => expect(liveThreads()).toHaveLength(1), SETTLE);
    const [thread] = liveThreads();
    await ui.commands.get("mend.review.accept")?.({ thread, text: WORDS });
    expect(ui.warn).toHaveBeenCalledWith(expect.stringMatching(/could not say which account/));
    expect(shownWords()).toContain(WORDS);
    const reread = "Nothing in this session ran the tests, read again.";
    mend.serverComments = [{ ...DRAFT, body: reread }];
    store.reread();
    await vi.waitFor(() => expect(shownWords()).toContain(reread), SETTLE);
    expect(shownWords()).toContain(WORDS);
    mend.serverComments = [{ ...DRAFT, state: "dismissed" }];
    store.reread();
    await vi.waitFor(() => expect(shownWords()).not.toContain(reread), SETTLE);
    expect(shownWords()).toContain(WORDS);
    comments.dispose();
    store.dispose();
  });

  it("are held in this window, and kept the next time this window reads the review", async () => {
    let full = true;
    const fullUntilFreed: KeptFiles = {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (full) throw new Error("the disk is full.");
        await NODE_FILES.writeFile(path, text);
      },
    };
    const { store, reply, done } = await underDraft(new FakeMend(), fullUntilFreed);
    await Promise.resolve(ui.commands.get("mend.review.accept")?.(reply)).catch(() => undefined);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringMatching(/in this window/));
    expect(store.held().map((words) => words.comment.body)).toEqual([WORDS]);
    full = false;
    await store.reloadReview();
    expect(store.held()).toEqual([]);
    expect(store.review().pending.map(({ body }) => body)).toContain(WORDS);
    done();
  });

  it("are not dropped by a newer reply, held or kept", async () => {
    let full = true;
    const fullUntilFreed: KeptFiles = {
      ...NODE_FILES,
      writeFile: async (path, text) => {
        if (full) throw new Error("the disk is full.");
        await NODE_FILES.writeFile(path, text);
      },
    };
    const { store, thread, done } = await underDraft(new FakeMend(), fullUntilFreed);
    const accept = (text: string) =>
      Promise.resolve(ui.commands.get("mend.review.accept")?.({ thread, text })).catch(
        () => undefined,
      );
    await accept(WORDS);
    await accept("and on CI");
    expect(shownWords()).toEqual(expect.arrayContaining([WORDS, "and on CI"]));
    full = false;
    await accept("then merged");
    expect(store.review().pending.map(({ body }) => body)).toEqual(
      expect.arrayContaining([WORDS, "and on CI", "then merged"]),
    );
    done();
  });
});
