import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import type { KeptFiles } from "./kept-reviews.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import { SendEditor } from "./send-editor.js";
import {
  comment,
  FakeMend,
  keptIn,
  memoryFiles,
  noPaste,
  PROJECT,
  session,
  sessionReads,
  SETTLE,
} from "./test-fixtures.js";

interface OpenDocument {
  readonly uri: vscode.Uri;
  text: string;
  getText(): string;
  save(): Promise<boolean>;
}

const ui = vi.hoisted(() => ({
  commands: new Map<string, (...args: ReadonlyArray<unknown>) => unknown>(),
  providers: new Array<vscode.FileSystemProvider>(),
  documents: new Array<OpenDocument>(),
  /** The text of every untitled editor opened. */
  untitled: new Array<string>(),
  providerOfThisWindow(): vscode.FileSystemProvider | undefined {
    return this.providers.at(-1);
  },
}));

vi.mock("vscode", async () => {
  const base = await import("../test-vscode.js");
  class Uri {
    private constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
      readonly query: string,
    ) {}
    static from(parts: {
      readonly scheme: string;
      readonly authority?: string;
      readonly path?: string;
      readonly query?: string;
    }): Uri {
      return new Uri(parts.scheme, parts.authority ?? "", parts.path ?? "", parts.query ?? "");
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}?${this.query}`;
    }
  }
  class FileSystemError extends Error {
    static FileNotFound(cause?: unknown): FileSystemError {
      return new FileSystemError(String(cause));
    }
  }
  class Disposable {
    constructor(private readonly release: () => void) {}
    dispose(): void {
      this.release();
    }
  }
  return {
    ...base,
    Uri,
    FileSystemError,
    Disposable,
    FileType: { File: 1 },
    FileChangeType: { Changed: 1 },
    window: {
      ...base.window,
      showWarningMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
      showTextDocument: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
      activeTextEditor: undefined,
    },
    workspace: {
      ...base.workspace,
      textDocuments: ui.documents,
      registerFileSystemProvider: (_scheme: string, provider: vscode.FileSystemProvider) => {
        ui.providers.push(provider);
        return { dispose: () => undefined };
      },
      openTextDocument: async (target: vscode.Uri | { readonly content: string }) => {
        if ("content" in target) {
          ui.untitled.push(target.content);
          return { getText: () => target.content };
        }
        const uri = target;
        // VS Code hands back the document it has for a URI, loaded or not.
        const loaded = ui.documents.find((open) => open.uri.toString() === uri.toString());
        if (loaded !== undefined) return loaded;
        const provider = ui.providerOfThisWindow();
        if (provider === undefined) throw new Error("no provider for the review scheme");
        const opened: OpenDocument = {
          uri,
          text: new TextDecoder().decode(await provider.readFile(uri)),
          getText() {
            return this.text;
          },
          save: async () => true,
        };
        ui.documents.push(opened);
        return opened;
      },
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

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);
const decoded = (data: Uint8Array): string => new TextDecoder().decode(data);
const SAVE: { readonly create: boolean; readonly overwrite: boolean } = {
  create: false,
  overwrite: true,
};

const windowOn = async (files: KeptFiles, mend: FakeMend) => {
  const store = new ReviewStore(
    sessionReads("change-1"),
    mend,
    new ReviewMemory(memento()),
    keptIn("/global-storage/reviews", files),
    noPaste,
  );
  const editor = new SendEditor(store, (cause) => {
    throw cause;
  });
  const provider = ui.providerOfThisWindow();
  if (provider === undefined) throw new Error("Send review registered no files");
  store.follow(PROJECT, session("s1"));
  await vi.waitFor(() => expect(store.ready()).not.toBeNull(), SETTLE);
  return {
    store,
    provider,
    close: () => {
      editor.dispose();
      store.dispose();
    },
  };
};

/** Send review, and the review document it shows. */
const sendReview = async (): Promise<OpenDocument> => {
  await ui.commands.get("mend.change.sendReview")?.();
  const shown: unknown = vi.mocked(vscode.window.showTextDocument).mock.lastCall?.[0];
  const opened = ui.documents.find((document) => document === shown);
  if (opened === undefined) throw new Error("Send review showed no review document");
  return opened;
};

const mendWithOpen = (): FakeMend => {
  const mend = new FakeMend();
  mend.serverComments = [comment({ id: "c1" })];
  return mend;
};

beforeEach(() => {
  vi.mocked(vscode.window.showWarningMessage).mockClear();
  ui.commands.clear();
  ui.providers.length = 0;
  ui.documents.length = 0;
  ui.untitled.length = 0;
});

describe("Send review, chosen again", () => {
  it("reopens the session's one review, though no editor of it is loaded", async () => {
    const window = await windowOn(memoryFiles(), mendWithOpen());
    const first = await sendReview();
    // A tab VS Code restored and has not loaded yet, or one she closed: no document is open.
    ui.documents.length = 0;
    const again = await sendReview();
    expect(again.uri.toString()).toBe(first.uri.toString());
    window.close();
  });

  it("never drops a review she saved, however often another window chooses Send review", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const first = await windowOn(files, mend);
    const opened = await sendReview();
    await first.provider.writeFile(opened.uri, encoded("words saved in the first window"), SAVE);
    const second = await windowOn(files, mend);
    for (let times = 0; times < 6; times += 1) {
      ui.documents.length = 0;
      await sendReview();
    }
    expect(decoded(await first.provider.readFile(opened.uri))).toBe(
      "words saved in the first window",
    );
    first.close();
    second.close();
  });

  it("composes anew once her comments changed, and first opens the text she saved", async () => {
    const mend = mendWithOpen();
    const window = await windowOn(memoryFiles(), mend);
    const opened = await sendReview();
    await window.provider.writeFile(opened.uri, encoded("her saved words"), SAVE);
    mend.serverComments = [...mend.serverComments, comment({ id: "c2", line: 13 })];
    window.store.reread();
    await vi.waitFor(() => expect(window.store.compose()?.open).toEqual(["c1", "c2"]), SETTLE);
    const fresh = await sendReview();
    expect(fresh.uri.toString()).not.toBe(opened.uri.toString());
    expect(ui.untitled).toEqual(["her saved words"]);
    window.close();
  });
});

describe("a review she saved, when VS Code reloads", () => {
  it("opens with her words, and Send to session sends them", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const before = await windowOn(files, mend);
    const opened = await sendReview();
    const words = "Keep the limiter, and add a test for the burst case.";
    await before.provider.writeFile(opened.uri, encoded(words), SAVE);
    before.close();
    ui.documents.length = 0;

    const after = await windowOn(files, mend);
    const restored = decoded(await after.provider.readFile(opened.uri));
    expect(restored).toBe(words);
    ui.documents.push({ ...opened, text: restored });
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.delivered[0]?.instruction).toBe(words);
    expect(after.store.review().sends.at(-1)?.instruction).toBe(words);
    await expect(Promise.resolve().then(() => after.provider.stat(opened.uri))).rejects.toThrow();
    after.close();
  });

  it("keeps a save of words VS Code restored unsaved, which this window only looked at", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const before = await windowOn(files, mend);
    const opened = await sendReview();
    before.close();

    const after = await windowOn(files, mend);
    const words = "Typed before the reload, saved after it.";
    await after.provider.stat(opened.uri);
    await after.provider.writeFile(opened.uri, encoded(words), SAVE);
    expect(decoded(await after.provider.readFile(opened.uri))).toBe(words);
    after.close();
  });

  it("refuses a save of restored words over one another window made since this window looked", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const before = await windowOn(files, mend);
    const opened = await sendReview();
    before.close();

    const restored = await windowOn(files, mend);
    await restored.provider.stat(opened.uri);
    const other = await windowOn(files, mend);
    await other.provider.readFile(opened.uri);
    await other.provider.writeFile(opened.uri, encoded("words saved in the other window"), SAVE);
    await expect(
      Promise.resolve().then(() =>
        restored.provider.writeFile(opened.uri, encoded("words VS Code restored"), SAVE),
      ),
    ).rejects.toBeInstanceOf(vscode.FileSystemError);
    expect(decoded(await other.provider.readFile(opened.uri))).toBe(
      "words saved in the other window",
    );
    restored.close();
    other.close();
  });
});

describe("a review open in two windows", () => {
  it("refuses a save over one the other window made since this one read it", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const first = await windowOn(files, mend);
    const opened = await sendReview();
    const second = await windowOn(files, mend);
    await second.provider.readFile(opened.uri);
    await second.provider.writeFile(opened.uri, encoded("words saved in the second window"), SAVE);
    await expect(
      Promise.resolve().then(() =>
        first.provider.writeFile(opened.uri, encoded("words typed in the first window"), SAVE),
      ),
    ).rejects.toBeInstanceOf(vscode.FileSystemError);
    expect(decoded(await second.provider.readFile(opened.uri))).toBe(
      "words saved in the second window",
    );
    first.close();
    second.close();
  });

  it("refuses to send this window's text over a review the other window saved since, and keeps both", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const first = await windowOn(files, mend);
    const opened = await sendReview();
    const sendFromFirst = ui.commands.get("mend.change.sendToSession");
    const second = await windowOn(files, mend);
    await second.provider.readFile(opened.uri);
    await second.provider.writeFile(opened.uri, encoded("words saved in the second window"), SAVE);
    await sendFromFirst?.(opened.uri);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mend.delivered).toEqual([]);
    expect(first.store.review().sends).toEqual([]);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Your text stays in this editor/),
    );
    expect(decoded(await second.provider.readFile(opened.uri))).toBe(
      "words saved in the second window",
    );
    first.close();
    second.close();
  });
});
