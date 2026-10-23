import * as vscode from "vscode";

import { samePlace } from "./kept-reviews.js";
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
  "Mend no longer keeps this review, so your words are open in a new editor beside it. The review was sent, composed again or left unused for 30 days. Copy your words where you need them.";

const ELSEWHERE =
  "You typed in an earlier review of this session that another window composed anew or sent since, so this review does not hold that text. Your text stays in its editor: copy what you need into this review.";

const UNREAD =
  "This window has not read this review, so your text is not saved over it. Your text stays in this editor.";

const touch = (store: ReviewStore, uri: vscode.Uri): void => {
  const ref = refOf(uri);
  if (ref !== null) void store.touchDocument(ref).catch(() => undefined);
};

class ReviewFiles implements vscode.FileSystemProvider {
  readonly #changed = new vscode.EventEmitter<Array<vscode.FileChangeEvent>>();
  readonly onDidChangeFile = this.#changed.event;
  /**
   * VS Code restores unsaved words over what it last looked at, and checks only by `mtime` and size
   * before a save, so a save is checked here against its revision.
   */
  readonly #based = new Map<string, number>();
  /** The untitled editor her words last opened in, per review, so a repeated save shows it again. */
  readonly #rescued = new Map<string, vscode.TextDocument>();

  constructor(private readonly store: ReviewStore) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const document = await this.#document(uri);
    if (!this.#based.has(uri.toString())) this.#based.set(uri.toString(), document.revision);
    // VS Code's check before a save sees a newer file only when its size differs from the size
    // the editor's text is based on, so a newer save of the same length would pass: the size is
    // the revision, never the same twice.
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: document.revision,
      size: document.revision,
    };
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    return [];
  }

  createDirectory(): void {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const document = await this.#document(uri);
    this.#based.set(uri.toString(), document.revision);
    touch(this.store, uri);
    return new TextEncoder().encode(document.text);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ref = refOf(uri);
    if (ref === null) throw vscode.FileSystemError.FileNotFound(uri);
    const revision = this.#based.get(uri.toString());
    if (revision === undefined) throw new vscode.FileSystemError(UNREAD);
    const text = new TextDecoder().decode(content);
    const saved = await this.store.saveDocument(ref, revision, text);
    if (saved.kind === "gone") {
      const shown = this.#rescued.get(uri.toString());
      const words =
        shown !== undefined && !shown.isClosed && shown.getText() === text
          ? shown
          : await vscode.workspace.openTextDocument({ content: text, language: "markdown" });
      this.#rescued.set(uri.toString(), words);
      await vscode.window.showTextDocument(words, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      throw new vscode.FileSystemError(GONE);
    }
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

/**
 * Closes the review's tabs, never reverting one: a tab holding words she typed asks to save them.
 */
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
      vscode.workspace.onDidChangeTextDocument(({ document }) => touch(store, document.uri)),
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
    const typed = await this.#saveOpen();
    if (typed === "unsaved") {
      void vscode.window.showWarningMessage(
        "VS Code did not save the review you are writing, so Send review did not compose it again. Your text stays in its editor.",
      );
      return;
    }
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
    if (typed === "elsewhere") void vscode.window.showWarningMessage(ELSEWHERE);
  }

  /**
   * Saves what she typed in every editor of the session's review: `unsaved` when VS Code could not
   * save the review kept now, `elsewhere` when an editor holds typing in a review another window
   * composed anew or sent since, which no save can keep.
   */
  async #saveOpen(): Promise<"saved" | "unsaved" | "elsewhere"> {
    const place = this.store.place();
    if (place === null) return "saved";
    const keptId = this.store.review().document?.composed.documentId ?? null;
    let typed: "saved" | "elsewhere" = "saved";
    for (const document of vscode.workspace.textDocuments) {
      const ref = refOf(document.uri);
      if (!document.isDirty || ref === null || !samePlace(ref.place, place)) continue;
      if (ref.id !== keptId) typed = "elsewhere";
      else if (!(await document.save())) return "unsaved";
    }
    return typed;
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
