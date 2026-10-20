import * as vscode from "vscode";

import type { MendConnection } from "../config.js";
import { ContentReader, type ChangeAddress } from "./content-reader.js";
import type { ReviewClient } from "./review-client.js";

export type { ChangeAddress } from "./content-reader.js";

/**
 * A change's files at a checkpoint, as read-only documents VS Code's own diff editor compares:
 * `mend-change://<worktree>/<path>?at=<checkpoint>`, with `absent=1` on the side a file is not on.
 * The pinned slice's new side also names the slice (`&slice=<id>`): only those documents take
 * comments (G10), and a comment thread hangs on the document of the checkpoint it was written at.
 */
export const CHANGE_SCHEME = "mend-change";

/** The address as a URI's parts, and back: pure, so placement is tested without VS Code. */
export const addressParts = (
  address: ChangeAddress,
): { readonly authority: string; readonly path: string; readonly query: string } => ({
  authority: address.worktreeId,
  path: `/${address.path}`,
  query: new URLSearchParams({
    at: address.at,
    ...(address.absent ? { absent: "1" } : {}),
    ...(address.slice === null ? {} : { slice: address.slice }),
  }).toString(),
});

export const partsAddress = (parts: {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
}): ChangeAddress | null => {
  const query = new URLSearchParams(parts.query);
  const at = query.get("at");
  if (parts.scheme !== CHANGE_SCHEME || at === null || parts.authority === "") return null;
  return {
    worktreeId: parts.authority,
    path: parts.path.replace(/^\//, ""),
    at,
    absent: query.get("absent") === "1",
    slice: query.get("slice"),
  };
};

export const changeUri = (address: ChangeAddress): vscode.Uri =>
  vscode.Uri.from({ scheme: CHANGE_SCHEME, ...addressParts(address) });

export const changeAddress = (uri: vscode.Uri): ChangeAddress | null => partsAddress(uri);

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
