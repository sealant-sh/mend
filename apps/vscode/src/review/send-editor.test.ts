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

/** What VS Code keeps of the file an editor's text is based on, with the text and its backups. */
interface BaseStat {
  readonly mtime: number;
  readonly size: number;
}

interface OpenDocument {
  readonly uri: vscode.Uri;
  text: string;
  version: number;
  isDirty: boolean;
  base: BaseStat;
  getText(): string;
  save(): Promise<boolean>;
}

const etag = ({ mtime, size }: BaseStat): string => `${mtime.toString(29)}${size.toString(31)}`;

/**
 * VS Code's own check before it saves an editor (`validateWriteFile` in its `fileService.ts`): the
 * file changed since the editor's base only when its `mtime` is newer and the etag of the base's
 * `mtime` with the file's size is not the base's etag, so a newer file of the same size passes.
 */
const modifiedSince = (base: BaseStat, stat: BaseStat): boolean =>
  base.mtime < stat.mtime && etag(base) !== etag({ mtime: base.mtime, size: stat.size });

const ui = vi.hoisted(() => ({
  commands: new Map<string, (...args: ReadonlyArray<unknown>) => unknown>(),
  providers: new Array<vscode.FileSystemProvider>(),
  documents: new Array<OpenDocument>(),
  providerOfThisWindow(): vscode.FileSystemProvider | undefined {
    return this.providers.at(-1);
  },
  /** A review's editor as VS Code holds it: a save makes VS Code's check, then writes. */
  editor(
    provider: vscode.FileSystemProvider,
    uri: vscode.Uri,
    text: string,
    base: BaseStat,
    isDirty = false,
  ): OpenDocument {
    return {
      uri,
      text,
      version: 1,
      isDirty,
      base,
      getText() {
        return this.text;
      },
      async save() {
        if (!this.isDirty) return true;
        if (modifiedSince(this.base, await provider.stat(uri))) return false;
        try {
          await provider.writeFile(uri, new TextEncoder().encode(this.text), {
            create: false,
            overwrite: true,
          });
        } catch {
          return false;
        }
        this.base = await provider.stat(uri);
        this.isDirty = false;
        return true;
      },
    };
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
  class TabInputText {
    constructor(readonly uri: Uri) {}
  }
  return {
    ...base,
    Uri,
    FileSystemError,
    Disposable,
    TabInputText,
    FileType: { File: 1 },
    FileChangeType: { Changed: 1 },
    window: {
      ...base.window,
      showWarningMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
      showTextDocument: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
      activeTextEditor: undefined,
      /** A tab per loaded review; closing one never reverts it, and a dirty one asks to save. */
      tabGroups: {
        get all() {
          return [
            { tabs: ui.documents.map((document) => ({ input: new TabInputText(document.uri) })) },
          ];
        },
        close: vi.fn(async (..._: ReadonlyArray<unknown>) => true),
      },
    },
    workspace: {
      ...base.workspace,
      textDocuments: ui.documents,
      registerFileSystemProvider: (_scheme: string, provider: vscode.FileSystemProvider) => {
        ui.providers.push(provider);
        return { dispose: () => undefined };
      },
      openTextDocument: async (uri: vscode.Uri) => {
        // VS Code hands back the document it has for a URI, loaded or not.
        const loaded = ui.documents.find((open) => open.uri.toString() === uri.toString());
        if (loaded !== undefined) return loaded;
        const provider = ui.providerOfThisWindow();
        if (provider === undefined) throw new Error("no provider for the review scheme");
        const text = new TextDecoder().decode(await provider.readFile(uri));
        const opened = ui.editor(provider, uri, text, await provider.stat(uri));
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
  vi.mocked(vscode.commands.executeCommand).mockClear();
  vi.mocked(vscode.window.tabGroups.close).mockClear();
  ui.commands.clear();
  ui.providers.length = 0;
  ui.documents.length = 0;
});

describe("Send to session", () => {
  it("leaves the editor open with words she typed while it sent, and says what was sent", async () => {
    const mend = mendWithOpen();
    const window = await windowOn(memoryFiles(), mend);
    const opened = await sendReview();
    const sending = ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    opened.text = `${opened.text}\nAnd keep the burst test.`;
    opened.version += 1;
    opened.isDirty = true;
    await sending;
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.delivered[0]?.instruction).not.toContain("And keep the burst test.");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.revertAndCloseActiveEditor",
    );
    expect(opened.text).toContain("And keep the burst test.");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/typed since .* not sent/),
    );
    window.close();
  });

  it("closes the review's tab, never reverting it", async () => {
    const window = await windowOn(memoryFiles(), mendWithOpen());
    const opened = await sendReview();
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    expect(vscode.window.tabGroups.close).toHaveBeenCalledWith([
      expect.objectContaining({ input: expect.objectContaining({ uri: opened.uri }) }),
    ]);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.revertAndCloseActiveEditor",
    );
    window.close();
  });

  it("never discards words she types while VS Code closes the editor", async () => {
    const window = await windowOn(memoryFiles(), mendWithOpen());
    const opened = await sendReview();
    vi.mocked(vscode.window.tabGroups.close).mockImplementationOnce(async () => {
      opened.text = `${opened.text}\nTyped as it closed.`;
      opened.version += 1;
      opened.isDirty = true;
      return false;
    });
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.revertAndCloseActiveEditor",
    );
    expect(opened.text).toContain("Typed as it closed.");
    window.close();
  });
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

  it("composes anew once her comments changed, with the text she saved after it", async () => {
    const mend = mendWithOpen();
    const window = await windowOn(memoryFiles(), mend);
    const opened = await sendReview();
    await window.provider.writeFile(opened.uri, encoded("her saved words"), SAVE);
    mend.serverComments = [...mend.serverComments, comment({ id: "c2", line: 13 })];
    window.store.reread();
    await vi.waitFor(() => expect(window.store.compose()?.open).toEqual(["c1", "c2"]), SETTLE);
    const fresh = await sendReview();
    expect(fresh.uri.toString()).not.toBe(opened.uri.toString());
    expect(fresh.text).toMatch(/Your earlier text[^]*her saved words/);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/The text you saved follows it/),
    );
    window.close();
  });

  it("carries the text she saved once more when composed anew again before she saves", async () => {
    const mend = mendWithOpen();
    const window = await windowOn(memoryFiles(), mend);
    const opened = await sendReview();
    await window.provider.writeFile(opened.uri, encoded("her saved words"), SAVE);
    for (const id of ["c2", "c3"]) {
      mend.serverComments = [...mend.serverComments, comment({ id, line: 13 })];
      window.store.reread();
      await vi.waitFor(() => expect(window.store.compose()?.open).toContain(id), SETTLE);
      ui.documents.length = 0;
      await sendReview();
    }
    const last = await sendReview();
    expect(last.text).toContain("her saved words");
    window.close();
  });
});

describe("Send review, with words VS Code held", () => {
  it("composes them in, so Send to session sends at once", async () => {
    let full = false;
    const base = memoryFiles();
    const files: KeptFiles = {
      ...base,
      writeFile: async (path, text) => {
        if (full) throw new Error("the disk is full.");
        await base.writeFile(path, text);
      },
    };
    const mend = mendWithOpen();
    mend.serverComments = [
      ...mend.serverComments,
      comment({ id: "d1", state: "draft", line: 13, author: { kind: "mend", name: "Mend" } }),
    ];
    const window = await windowOn(files, mend);
    full = true;
    await window.store.accept("d1", "I ran them by hand");
    full = false;
    const opened = await sendReview();
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(window.store.review().sends.at(-1)?.instruction).toContain("I ran them by hand");
    window.close();
  });
});

describe("a review composed anew over one she saved", () => {
  it("holds the text she saved, kept before any editor shows it", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const window = await windowOn(files, mend);
    const opened = await sendReview();
    await window.provider.writeFile(opened.uri, encoded("her saved words"), SAVE);
    mend.serverComments = [...mend.serverComments, comment({ id: "c2", line: 13 })];
    window.store.reread();
    await vi.waitFor(() => expect(window.store.compose()?.open).toEqual(["c1", "c2"]), SETTLE);
    const composition = window.store.compose();
    if (composition === null) throw new Error("nothing composed");
    const kept = await window.store.keepDocument(composition);
    // VS Code reloads before any editor opens.
    window.close();
    const after = await windowOn(files, mend);
    const document = await after.store.document(kept.ref);
    expect(document?.text).toContain(composition.text);
    expect(document?.text).toContain("her saved words");
    after.close();
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

describe("words VS Code restored unsaved", () => {
  it("are never sent over a review another window saved since they were typed", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const before = await windowOn(files, mend);
    const opened = await sendReview();
    const base = await before.provider.stat(opened.uri);
    before.close();
    ui.documents.length = 0;

    const other = await windowOn(files, mend);
    await other.provider.readFile(opened.uri);
    await other.provider.writeFile(opened.uri, encoded("words saved in the other window"), SAVE);
    other.close();

    const restored = await windowOn(files, mend);
    await restored.provider.stat(opened.uri);
    const backup = ui.editor(restored.provider, opened.uri, "words VS Code restored", base, true);
    ui.documents.push(backup);
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mend.delivered).toEqual([]);
    expect(decoded(await restored.provider.readFile(opened.uri))).toBe(
      "words saved in the other window",
    );
    expect(backup.text).toBe("words VS Code restored");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Your text stays in this editor/),
    );
    restored.close();
  });

  it("are never sent over a review another window saved since, of the same length", async () => {
    const files = memoryFiles();
    const mend = mendWithOpen();
    const before = await windowOn(files, mend);
    const opened = await sendReview();
    await before.provider.writeFile(opened.uri, encoded("her saved text A"), SAVE);
    const base = await before.provider.stat(opened.uri);
    before.close();
    ui.documents.length = 0;

    const other = await windowOn(files, mend);
    await other.provider.readFile(opened.uri);
    await other.provider.writeFile(opened.uri, encoded("her saved text B"), SAVE);
    other.close();

    const restored = await windowOn(files, mend);
    await restored.provider.stat(opened.uri);
    const backup = ui.editor(restored.provider, opened.uri, "words VS Code restored", base, true);
    ui.documents.push(backup);
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mend.delivered).toEqual([]);
    expect(decoded(await restored.provider.readFile(opened.uri))).toBe("her saved text B");
    expect(backup.text).toBe("words VS Code restored");
    restored.close();
  });

  it("are saved, then sent as saved", async () => {
    const mend = mendWithOpen();
    const window = await windowOn(memoryFiles(), mend);
    const opened = await sendReview();
    opened.text = "Typed, and sent without a save.";
    opened.version += 1;
    opened.isDirty = true;
    await ui.commands.get("mend.change.sendToSession")?.(opened.uri);
    await vi.waitFor(() => expect(mend.delivered).toHaveLength(1), SETTLE);
    expect(mend.delivered[0]?.instruction).toBe("Typed, and sent without a save.");
    expect(opened.isDirty).toBe(false);
    window.close();
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
