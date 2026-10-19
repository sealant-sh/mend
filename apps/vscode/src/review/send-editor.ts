import * as vscode from "vscode";

import type { Composed, ReviewStore } from "./review-store.js";

/**
 * Send review (story d, step 6): an editor with the instruction Mend will send, which she edits
 * like any file, and **Send to session** in its title. The text lives in memory under
 * `mend-review://<session>/review · <name>.md` until she sends it.
 */
export const REVIEW_SCHEME = "mend-review";

class ReviewFiles implements vscode.FileSystemProvider {
  readonly #changed = new vscode.EventEmitter<Array<vscode.FileChangeEvent>>();
  readonly onDidChangeFile = this.#changed.event;
  readonly #files = new Map<string, { data: Uint8Array; mtime: number }>();

  put(uri: vscode.Uri, text: string): void {
    this.#files.set(uri.toString(), { data: new TextEncoder().encode(text), mtime: Date.now() });
    this.#changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  forget(uri: vscode.Uri): void {
    this.#files.delete(uri.toString());
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.#files.get(uri.toString());
    if (file === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: file.mtime,
      mtime: file.mtime,
      size: file.data.byteLength,
    };
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    return [];
  }

  createDirectory(): void {}

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.#files.get(uri.toString());
    if (file === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return file.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    this.#files.set(uri.toString(), { data: content, mtime: Date.now() });
  }

  delete(uri: vscode.Uri): void {
    this.#files.delete(uri.toString());
  }

  rename(): void {}

  dispose(): void {
    this.#changed.dispose();
  }
}

export class SendEditor implements vscode.Disposable {
  readonly #files = new ReviewFiles();
  /** What each open review editor was composed with: Send to session sends exactly that. */
  readonly #composed = new Map<string, Composed>();
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly store: ReviewStore,
    private readonly onError: (cause: unknown) => void,
  ) {
    this.#disposables = [
      vscode.workspace.registerFileSystemProvider(REVIEW_SCHEME, this.#files, {
        isCaseSensitive: true,
      }),
      this.#files,
      vscode.commands.registerCommand("mend.change.sendReview", () => this.#open()),
      vscode.commands.registerCommand("mend.change.sendToSession", (uri?: unknown) =>
        this.#send(uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri),
      ),
      vscode.commands.registerCommand("mend.change.retryDelivery", () => {
        const target = store.retryTarget();
        return target === null ? undefined : store.retry(target);
      }),
      // The disabled twins of Send review: their titles say why, and they do nothing.
      vscode.commands.registerCommand("mend.change.sendReviewOffline", () => undefined),
      vscode.commands.registerCommand("mend.change.sendReviewNotHers", () => undefined),
    ];
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async #open(): Promise<void> {
    const composed = this.store.compose();
    if (composed === null) return;
    const uri = vscode.Uri.from({
      scheme: REVIEW_SCHEME,
      authority: composed.sessionId,
      path: `/review · ${composed.sessionName}.md`,
    });
    const open = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    // A review she is already editing is shown as she left it, never composed over.
    if (open === undefined || !this.#composed.has(uri.toString())) {
      this.#composed.set(uri.toString(), composed);
      this.#files.put(uri, composed.text);
    }
    const document = open ?? (await vscode.workspace.openTextDocument(uri));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async #send(uri: vscode.Uri | undefined): Promise<void> {
    if (uri === undefined || uri.scheme !== REVIEW_SCHEME) return;
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (document === undefined) return;
    const composed = this.#composed.get(uri.toString());
    if (composed === undefined || composed.sessionId !== uri.authority) {
      void vscode.window.showWarningMessage(
        "Mend does not know which comments this review lists, so nothing was sent. Your text stays in this editor: close it and choose Send review again.",
      );
      return;
    }
    try {
      const sent = await this.store.send(composed, document.getText());
      // Not recorded: the editor stays, and her words in it.
      if (!sent.sent) {
        void vscode.window.showWarningMessage(sent.words);
        return;
      }
      // Her edits are the text: kept before the editor closes, so closing never asks to save.
      await document.save();
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      this.#files.forget(uri);
      this.#composed.delete(uri.toString());
    } catch (cause) {
      this.onError(cause);
    }
  }
}
