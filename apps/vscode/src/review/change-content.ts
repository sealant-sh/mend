import * as vscode from "vscode";

import type { MendConnection } from "../config.js";
import { ContentReader, type ChangeAddress } from "./content-reader.js";
import type { ReviewClient } from "./review-client.js";

/**
 * A change's files at a checkpoint, as read-only documents VS Code's own diff editor compares:
 * `mend-change://<worktree>/<path>?at=<checkpoint>`, with `absent=1` on the side a file is not on.
 */
export const CHANGE_SCHEME = "mend-change";

export const changeUri = (address: ChangeAddress): vscode.Uri =>
  vscode.Uri.from({
    scheme: CHANGE_SCHEME,
    authority: address.worktreeId,
    path: `/${address.path}`,
    query: new URLSearchParams({
      at: address.at,
      ...(address.absent ? { absent: "1" } : {}),
    }).toString(),
  });

export const changeAddress = (uri: vscode.Uri): ChangeAddress | null => {
  const query = new URLSearchParams(uri.query);
  const at = query.get("at");
  if (uri.scheme !== CHANGE_SCHEME || at === null || uri.authority === "") return null;
  return {
    worktreeId: uri.authority,
    path: uri.path.replace(/^\//, ""),
    at,
    absent: query.get("absent") === "1",
  };
};

export class ChangeContent implements vscode.TextDocumentContentProvider {
  readonly #reader: ContentReader;

  constructor(client: Pick<ReviewClient, "contents">, connection: () => Promise<MendConnection>) {
    this.#reader = new ContentReader(client, connection);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const address = changeAddress(uri);
    return address === null ? "" : this.#reader.read(address, uri.toString());
  }

  /** Sign-out, or first run took the view back: nothing read stays. */
  clear(): void {
    this.#reader.clear();
  }
}
