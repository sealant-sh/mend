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

class ReviewFiles implements vscode.FileSystemProvider {
  readonly #changed = new vscode.EventEmitter<Array<vscode.FileChangeEvent>>();
  readonly onDidChangeFile = this.#changed.event;
  readonly #read = new Map<string, number>();

  constructor(private readonly store: ReviewStore) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const document = await this.#document(uri);
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
    this.#read.set(uri.toString(), document.revision);
    return new TextEncoder().encode(document.text);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ref = refOf(uri);
    if (ref === null) throw vscode.FileSystemError.FileNotFound(uri);
    const revision = this.#read.get(uri.toString());
    const saved = await this.store.saveDocument(
      ref,
      revision === undefined ? { kind: "restored" } : { kind: "read", revision },
      new TextDecoder().decode(content),
    );
    if (saved.kind === "gone") throw vscode.FileSystemError.FileNotFound(GONE);
    if (saved.kind === "newer") throw new vscode.FileSystemError(NEWER);
    this.#read.set(uri.toString(), saved.revision);
  }

  delete(): void {}

  rename(): void {}

  dispose(): void {
    this.#changed.dispose();
  }

  async #document(uri: vscode.Uri): Promise<ReviewDocument> {
    const ref = refOf(uri);
    const document = ref === null ? null : await this.store.document(ref);
    if (document === null) throw vscode.FileSystemError.FileNotFound(uri);
    return document;
  }
}

const closeWithoutSaving = async (document: vscode.TextDocument): Promise<void> => {
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
};

export class SendEditor implements vscode.Disposable {
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly store: ReviewStore,
    private readonly onError: (cause: unknown) => void,
  ) {
    const files = new ReviewFiles(store);
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

  async #open(): Promise<void> {
    const composition = this.store.compose();
    if (composition === null) return;
    const open = vscode.workspace.textDocuments.find(
      (candidate) => refOf(candidate.uri)?.place.sessionId === composition.sessionId,
    );
    const document =
      open ??
      (await vscode.workspace.openTextDocument(
        documentUri(await this.store.keepDocument(composition), composition.sessionName),
      ));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async #send(uri: vscode.Uri | undefined): Promise<void> {
    if (uri === undefined || uri.scheme !== REVIEW_SCHEME) return;
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (document === undefined) return;
    try {
      const ref = refOf(uri);
      const kept = ref === null ? null : await this.store.document(ref);
      if (kept === null) {
        void vscode.window.showWarningMessage(
          "Mend does not know which comments this review lists, so nothing was sent. Your text stays in this editor: close it and choose Send review again.",
        );
        return;
      }
      const sent = await this.store.send(kept.composed, document.getText());
      // Not recorded: the editor stays, and her words in it.
      if (!sent.sent) {
        void vscode.window.showWarningMessage(sent.words);
        return;
      }
      await closeWithoutSaving(document);
    } catch (cause) {
      this.onError(cause);
    }
  }
}
