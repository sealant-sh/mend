import * as vscode from "vscode";

import { MendApiError } from "./mend-http.js";

/** What a refused sign-in offers, wherever it surfaces: the one action that helps (rule 14). */
export const CONNECT = "Connect to server";

/** Mend refused the token: what it read before is no longer hers to see. */
export const refusedSignIn = (cause: unknown): cause is MendApiError =>
  cause instanceof MendApiError && cause.status === 401;

/**
 * An error's one toast. A refused sign-in reads Mend's own `Signed out — sign in again.` with
 * Connect, whichever read or click met it, so every surface says it in the same words; any other
 * error reads `words`, with `otherwise` when one is given. True when she picked `otherwise`.
 */
export const showErrorToast = async (
  cause: unknown,
  words: string,
  otherwise?: string,
): Promise<boolean> => {
  if (refusedSignIn(cause)) {
    if ((await vscode.window.showErrorMessage(cause.message, CONNECT)) === CONNECT)
      await vscode.commands.executeCommand("mend.connect");
    return false;
  }
  if (otherwise === undefined) {
    await vscode.window.showErrorMessage(words);
    return false;
  }
  return (await vscode.window.showErrorMessage(words, otherwise)) === otherwise;
};
