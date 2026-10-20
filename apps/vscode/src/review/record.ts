import * as vscode from "vscode";

/** Show record (story d, step 3): the session's transcript in a read-only editor (G9). */
export const RECORD_SCHEME = "mend-record";

export class RecordContent implements vscode.TextDocumentContentProvider {
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;
  readonly #texts = new Map<string, string>();

  /** Opens a transcript already read, under a URI of its own. */
  async show(sessionId: string, name: string, text: string): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: RECORD_SCHEME,
      authority: sessionId,
      path: `/record · ${name}.md`,
    });
    this.#texts.set(uri.toString(), text);
    this.#changed.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document, { preview: true });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#texts.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
