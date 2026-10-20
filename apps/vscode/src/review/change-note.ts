import * as vscode from "vscode";

import type { ChangeRead } from "./change-rows.js";
import { checkpointName, filePath } from "./slices.js";

/**
 * The change's own note: a read-only document the comments about the change as a whole hang on,
 * since a comment thread needs a document and a line. `mend-change-note://<change>/the whole change`.
 */
export const NOTE_SCHEME = "mend-change-note";

export const noteUri = (changeId: string): vscode.Uri =>
  vscode.Uri.from({ scheme: NOTE_SCHEME, authority: changeId, path: "/the whole change" });

export const noteChange = (uri: vscode.Uri): string | null =>
  uri.scheme === NOTE_SCHEME && uri.authority !== "" ? uri.authority : null;

/** What the note says: the change it is about, the slice pinned for review and its files. */
export const noteText = (read: ChangeRead): string =>
  [
    `${read.sessionName} · the whole change`,
    "",
    `Comments about the change as a whole hang on the first line. Pinned for review: ${read.chain.baseName} → ${checkpointName(read.pinned.head, read.chain.baseName)}, ${read.pinnedDiff.files.length} ${read.pinnedDiff.files.length === 1 ? "file" : "files"}.`,
    "",
    ...read.pinnedDiff.files.map((file) => `  ${filePath(file)}`),
    "",
  ].join("\n");

export class ChangeNote implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  constructor(private readonly ready: () => ChangeRead | null) {}

  /** The followed change was read again: an open note shows what it read. */
  redraw(): void {
    const read = this.ready();
    if (read !== null) this.#changed.fire(noteUri(read.changeId));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const read = this.ready();
    if (read === null || read.changeId !== noteChange(uri))
      return "Select this change's session to read its note.\n";
    return noteText(read);
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
