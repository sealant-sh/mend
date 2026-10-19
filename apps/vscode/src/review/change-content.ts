import * as vscode from "vscode";

import { MendApiError } from "../mend-http.js";
import type { ReviewClient } from "./review-client.js";
import type { FileContents } from "./review-wire.js";

/**
 * A change's files at a checkpoint, as read-only documents VS Code's own diff editor compares:
 * `mend-change://<worktree>/<path>?at=<checkpoint>`. A checkpoint never changes, so what was read
 * once stays readable while Mend is offline.
 */
export const CHANGE_SCHEME = "mend-change";

export interface ChangeAddress {
  readonly worktreeId: string;
  readonly path: string;
  readonly at: string;
}

export const changeUri = (address: ChangeAddress): vscode.Uri =>
  vscode.Uri.from({
    scheme: CHANGE_SCHEME,
    authority: address.worktreeId,
    path: `/${address.path}`,
    query: new URLSearchParams({ at: address.at }).toString(),
  });

export const changeAddress = (uri: vscode.Uri): ChangeAddress | null => {
  const at = new URLSearchParams(uri.query).get("at");
  if (uri.scheme !== CHANGE_SCHEME || at === null || uri.authority === "") return null;
  return { worktreeId: uri.authority, path: uri.path.replace(/^\//, ""), at };
};

/** What the editor shows for a file's contents. */
export const documentText = (contents: FileContents): string => {
  switch (contents.kind) {
    case "absent":
      return "";
    case "binary":
      return `binary file · ${contents.size} bytes · not shown`;
    case "text":
      return contents.text;
  }
};

export class ChangeContent implements vscode.TextDocumentContentProvider {
  readonly #read = new Map<string, string>();

  constructor(private readonly client: Pick<ReviewClient, "contents">) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const known = this.#read.get(key);
    if (known !== undefined) return known;
    const address = changeAddress(uri);
    if (address === null) return "";
    try {
      const shown = documentText(
        await this.client.contents(address.worktreeId, address.path, address.at),
      );
      this.#read.set(key, shown);
      return shown;
    } catch (cause) {
      // A side the file is not on (added, deleted) answers 404: the diff shows it empty.
      if (cause instanceof MendApiError && cause.status === 404) {
        this.#read.set(key, "");
        return "";
      }
      throw cause;
    }
  }
}
