import * as vscode from "vscode";

import { refusedSignIn } from "../error-toast.js";
import type { ToastClaims } from "../toast-claims.js";
import type { RetryTarget, ReviewFailure, ReviewStore } from "./review-store.js";

/** How long the status bar says what a Retry delivery found instead of sending. */
const SAID_MS = 10_000;

/**
 * Retry delivery from any of its buttons: a toast VS Code cannot close may be clicked after the
 * review was sent, so what Retry found instead of sending is said in the status bar.
 */
export const retryDelivery = async (
  store: Pick<ReviewStore, "retry">,
  target: RetryTarget,
): Promise<void> => {
  const retried = await store.retry(target);
  if (!retried.retried) vscode.window.setStatusBarMessage(retried.words, SAID_MS);
};

/**
 * A review failure toasts once in this VS Code (rule 14): claimed as the notifier claims its
 * toasts, then checked again, since a delivery may have been retried while the claim was made.
 */
export const reviewToast =
  (
    store: Pick<ReviewStore, "stillFails" | "retry">,
    claims: Pick<ToastClaims, "claim" | "release">,
    onError: (cause: unknown) => void,
  ) =>
  async (failure: ReviewFailure): Promise<void> => {
    // A refused sign-in reads as it does on every surface: Mend's words with Connect.
    if (refusedSignIn(failure.cause)) {
      onError(failure.cause);
      return;
    }
    if (!(await claims.claim(failure.key, failure.at))) return;
    if (!(await store.stillFails(failure))) {
      await claims.release(failure.key, failure.at);
      return;
    }
    const show =
      failure.tone === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    const actions = [
      ...(failure.retry === null ? [] : ["Retry delivery"]),
      ...(failure.text === null ? [] : ["Show its text"]),
    ];
    const picked = await show(failure.words, ...actions);
    if (picked === "Retry delivery" && failure.retry !== null)
      await retryDelivery(store, failure.retry);
    if (picked === "Show its text" && failure.text !== null) {
      // Her words of a review that was stopped, to copy from: nothing she wrote is lost.
      const document = await vscode.workspace.openTextDocument({
        content: failure.text,
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }
  };
