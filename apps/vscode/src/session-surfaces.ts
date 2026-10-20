import * as vscode from "vscode";

import { refusedSignIn, showErrorToast } from "./error-toast.js";
import type { Launches, RetryAnswer } from "./launches.js";
import { displaySession } from "./session-lines.js";
import {
  ownLine,
  transitions,
  waitsOf,
  type Notification,
  type WindowModel,
} from "./session-model.js";
import type { SessionStore, StoreChange } from "./session-store.js";
import type { ToastClaims } from "./toast-claims.js";
import { statusColor } from "./tree.js";

/**
 * The status bar (rules 9 and 10): `Mend · 1 needs you · 2 finished` in any window, and in a
 * session's workspace window its dot and `add-rate-limit · running`, two items so the dot alone
 * takes the status colour. Either opens what helps: the Mend view, or the session picker.
 */
export class MendStatusBar implements vscode.Disposable {
  readonly #dot = vscode.window.createStatusBarItem(
    "mend.status.dot",
    vscode.StatusBarAlignment.Left,
    31,
  );
  readonly #text = vscode.window.createStatusBarItem(
    "mend.status",
    vscode.StatusBarAlignment.Left,
    30,
  );

  constructor() {
    this.#dot.name = "Mend session status";
    this.#text.name = "Mend";
  }

  dispose(): void {
    this.#dot.dispose();
    this.#text.dispose();
  }

  /** Not connected: no status to say. */
  hide(): void {
    this.#dot.hide();
    this.#text.hide();
  }

  update(model: WindowModel): void {
    const { statusBar } = model;
    const command =
      model.kind === "workspace" ? "mend.pickSession" : "workbench.view.extension.mend";
    this.#text.text = statusBar.text;
    this.#text.tooltip = statusBar.tooltip;
    this.#text.command = command;
    this.#text.show();
    if (statusBar.dot === null) {
      this.#dot.hide();
      return;
    }
    this.#dot.text = statusBar.dot === "stopped" ? "$(circle-large-outline)" : "$(circle-filled)";
    this.#dot.color = new vscode.ThemeColor(statusColor(statusBar.dot));
    this.#dot.tooltip = statusBar.tooltip;
    this.#dot.command = command;
    this.#dot.show();
  }
}

/**
 * Toasts (rules 12-14): only in the focused window, only when a session needs her or one she
 * started finished, and never for what this window already shows. A wait that ends is withdrawn:
 * VS Code cannot close a toast it showed, so the toast's button then does nothing but say how the
 * session reads now.
 */
export class Notifier {
  readonly #raised = new Set<string>();
  readonly #withdrawn = new Set<string>();
  #errorSaid: string | null = null;

  constructor(
    private readonly store: Pick<SessionStore, "showing" | "model" | "error">,
    private readonly claims: Pick<ToastClaims, "claim" | "release">,
    private readonly launches: Pick<Launches, "offer" | "relaunch">,
  ) {}

  changed({ prev, next }: StoreChange): void {
    const notified = transitions(prev, next, {
      focused: vscode.window.state.focused,
      showing: this.store.showing(),
      raised: this.#raised,
    });
    for (const notification of notified) {
      if (notification.kind === "withdrawn") {
        this.#withdrawn.add(notification.key);
        void this.claims.release(notification.key, notification.at);
        continue;
      }
      this.#raised.add(notification.key);
      this.#withdrawn.delete(notification.key);
      if (notification.quiet === null) void this.#toast(notification);
    }
    this.#sayError();
  }

  async #toast(notification: Exclude<Notification, { readonly kind: "withdrawn" }>): Promise<void> {
    // Another window may have toasted it already, focused when its own read landed.
    if (!(await this.claims.claim(notification.key, notification.at))) return;
    // Claiming took a while: she may have looked away, or at the session, or the wait ended.
    if (!this.#stillToasts(notification)) {
      await this.claims.release(notification.key, notification.at);
      return;
    }
    if (notification.kind === "launchFailed") {
      // A read just now decides: Retry only for a launch that failed or never started.
      const { sessionId } = notification;
      const offer = await this.launches.offer(sessionId);
      // The offer waits for a launch on its way, so she may have looked away meanwhile.
      if (offer.kind === "moved" || !this.#stillToasts(notification)) {
        await this.claims.release(notification.key, notification.at);
        return;
      }
      if (offer.kind === "none") {
        void vscode.window.showErrorMessage(notification.text);
        return;
      }
      const picked = await vscode.window.showErrorMessage(notification.text, "Retry");
      if (picked === "Retry")
        await this.#sayRetry(
          sessionId,
          await this.launches.relaunch(sessionId, notification.settledAt),
        );
      return;
    }
    const actions = notification.kind === "waits" ? ["Answer"] : ["Review", "Open"];
    const picked = await vscode.window.showInformationMessage(notification.text, ...actions);
    if (picked === undefined) return;
    if (this.#withdrawn.has(notification.key)) {
      const now = this.store.model()?.sessions.get(notification.sessionId);
      if (now !== undefined) vscode.window.setStatusBarMessage(`${now.name} · ${now.line}`, 5_000);
      return;
    }
    const command =
      picked === "Answer" ? "mend.answer" : picked === "Review" ? "mend.reviewChange" : "mend.open";
    await vscode.commands.executeCommand(command, notification.sessionId);
  }

  /** A Retry Mend refused says how the session reads now; an agent already running offers Open. */
  async #sayRetry(sessionId: string, answer: RetryAnswer): Promise<void> {
    if (answer.kind === "sent" || answer.kind === "held") return;
    const name =
      answer.read === null
        ? (this.store.model()?.sessions.get(sessionId)?.name ?? sessionId)
        : displaySession(answer.read);
    if (answer.kind === "movedOn") {
      void vscode.window.showInformationMessage(
        answer.read === null
          ? `${name} · ${answer.said}`
          : `${name} moved on · ${ownLine(answer.read)} · nothing launched`,
      );
      return;
    }
    const state = answer.read?.status === "starting" ? "starting" : "running";
    const picked = await vscode.window.showInformationMessage(
      `${name} · an agent is already ${state} · nothing launched`,
      "Open",
    );
    if (picked === "Open") await vscode.commands.executeCommand("mend.open", sessionId);
  }

  #stillToasts(notification: Exclude<Notification, { readonly kind: "withdrawn" }>): boolean {
    return (
      vscode.window.state.focused &&
      // Rule 14: a failed launch's toast carries Retry, which its row does not.
      (notification.kind === "launchFailed" || !this.store.showing().has(notification.sessionId)) &&
      (notification.kind !== "waits" || waitsOf(this.store.model()).has(notification.key))
    );
  }

  /** A refused sign-in toasts once, with the one action that helps; going offline never toasts. */
  #sayError(): void {
    const error = this.store.error();
    const words = error instanceof Error ? error.message : null;
    if (words === this.#errorSaid) return;
    this.#errorSaid = words;
    if (!vscode.window.state.focused || !refusedSignIn(error)) return;
    void showErrorToast(error, error.message);
  }
}
