import * as vscode from "vscode";

import type { ReviewDocument } from "./pending.js";
import type { DocumentRef, ReviewStore } from "./review-store.js";
import { retryDelivery } from "./review-toast.js";

export const REVIEW_SCHEME = "mend-review";

const documentUri = (ref: DocumentRef, sessionName: string): vscode.Uri =>
  vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    authority: ref.place.sessionId,
    path: `/review · ${sessionName}.md`,
    query: new URLSearchParams({
      url: ref.place.url,
      viewer: ref.place.viewer,
      id: ref.id,
    }).toString(),
  });

const refOf = (uri: vscode.Uri): DocumentRef | null => {
  const query = new URLSearchParams(uri.query);
  const url = query.get("url");
  const viewer = query.get("viewer");
  const id = query.get("id");
  return uri.scheme !== REVIEW_SCHEME || url === null || viewer === null || id === null
    ? null
    : { place: { url, viewer, sessionId: uri.authority }, id };
};

const NEWER =
  "Another window saved this review since this editor read it, so your text is not saved over it. Your text stays in this editor.";

const GONE =
  "This review was sent, or VS Code no longer keeps it, so your text is not saved. Your text stays in this editor.";

const UNREAD =
  "This window has not read this review, so your text is not saved over it. Your text stays in this editor.";

class ReviewFiles implements vscode.FileSystemProvider {
  readonly #changed = new vscode.EventEmitter<Array<vscode.FileChangeEvent>>();
  readonly onDidChangeFile = this.#changed.event;
  /**
   * The revision each editor's text is based on: the first this window looked at, or the one it
   * read or saved since. VS Code restores unsaved words over what it last looked at, and checks
   * only by `mtime` before a save, so a save is checked here against this revision.
   */
  readonly #based = new Map<string, number>();

  constructor(private readonly store: ReviewStore) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const document = await this.#document(uri);
    if (!this.#based.has(uri.toString())) this.#based.set(uri.toString(), document.revision);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: document.revision,
      size: new TextEncoder().encode(document.text).byteLength,
    };
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    return [];
  }

  createDirectory(): void {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const document = await this.#document(uri);
    this.#based.set(uri.toString(), document.revision);
    return new TextEncoder().encode(document.text);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ref = refOf(uri);
    if (ref === null) throw vscode.FileSystemError.FileNotFound(uri);
    const revision = this.#based.get(uri.toString());
    if (revision === undefined) throw new vscode.FileSystemError(UNREAD);
    const saved = await this.store.saveDocument(ref, revision, new TextDecoder().decode(content));
    if (saved.kind === "gone") throw vscode.FileSystemError.FileNotFound(GONE);
    if (saved.kind === "newer") throw new vscode.FileSystemError(NEWER);
    this.#based.set(uri.toString(), saved.revision);
  }

  delete(): void {}

  rename(): void {}

  dispose(): void {
    this.#changed.dispose();
  }

  /** The revision the text of this review's editor is based on; undefined before it was read. */
  basedOn(uri: vscode.Uri): number | undefined {
    return this.#based.get(uri.toString());
  }

  async #document(uri: vscode.Uri): Promise<ReviewDocument> {
    const ref = refOf(uri);
    const document = ref === null ? null : await this.store.document(ref);
    if (document === null) throw vscode.FileSystemError.FileNotFound(uri);
    return document;
  }
}

/** Closes the review's tabs, never reverting one: a tab holding words she typed asks to save them. */
const closeTabs = async (uri: vscode.Uri): Promise<void> => {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
};

export class SendEditor implements vscode.Disposable {
  readonly #disposables: ReadonlyArray<vscode.Disposable>;
  readonly #files: ReviewFiles;

  constructor(
    private readonly store: ReviewStore,
    private readonly onError: (cause: unknown) => void,
  ) {
    const files = new ReviewFiles(store);
    this.#files = files;
    this.#disposables = [
      vscode.workspace.registerFileSystemProvider(REVIEW_SCHEME, files, {
        isCaseSensitive: true,
      }),
      files,
      vscode.commands.registerCommand("mend.change.sendReview", () => this.#open()),
      vscode.commands.registerCommand("mend.change.sendToSession", (uri?: unknown) =>
        this.#send(uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri),
      ),
      vscode.commands.registerCommand("mend.change.retryDelivery", () => {
        const target = store.retryTarget();
        return target === null ? undefined : retryDelivery(store, target);
      }),
      // The disabled twins of Send review: their titles say why, and they do nothing.
      vscode.commands.registerCommand("mend.change.sendReviewOffline", () => undefined),
      vscode.commands.registerCommand("mend.change.sendReviewNotHers", () => undefined),
    ];
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** The session's one review, at one URI, so a tab VS Code restored is that same review. */
  async #open(): Promise<void> {
    // Words this window holds are kept first, so the review lists them and is current when sent.
    await this.store.reloadReview();
    const composition = this.store.compose();
    if (composition === null) return;
    const kept = await this.store.keepDocument(composition);
    if (kept.carried)
      void vscode.window.showInformationMessage(
        'Your comments changed since you saved this review, so Send review composed it again. The text you saved follows it, under "Your earlier text".',
      );
    const document = await vscode.workspace.openTextDocument(
      documentUri(kept.ref, kept.document.composed.sessionName),
    );
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async #send(uri: vscode.Uri | undefined): Promise<void> {
    if (uri === undefined || uri.scheme !== REVIEW_SCHEME) return;
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (document === undefined) return;
    try {
      // Saved through VS Code first: its own check refuses a save over a newer one, as for
      // words it restored from a backup of an older revision.
      if (document.isDirty && !(await document.save())) {
        void vscode.window.showWarningMessage(
          "VS Code did not save this review, so nothing was sent. Your text stays in this editor.",
        );
        return;
      }
      const ref = refOf(uri);
      const revision = this.#files.basedOn(uri);
      if (ref === null || revision === undefined) {
        void vscode.window.showWarningMessage(
          "Mend does not know which comments this review lists, so nothing was sent. Your text stays in this editor: close it and choose Send review again.",
        );
        return;
      }
      const sent = await this.store.send(ref, revision);
      // Not recorded: the editor stays, and her words in it.
      if (!sent.sent) {
        void vscode.window.showWarningMessage(sent.words);
        return;
      }
      if (document.isDirty)
        void vscode.window.showInformationMessage(
          "Mend sent the review as you saved it when you chose Send to session. What you typed since was not sent.",
        );
      await closeTabs(uri);
    } catch (cause) {
      this.onError(cause);
    }
  }
}
