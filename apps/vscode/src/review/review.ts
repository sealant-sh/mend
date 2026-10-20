import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import { refusedSignIn } from "../error-toast.js";
import type { ToastClaims } from "../toast-claims.js";
import type { Project, Session } from "../types.js";
import { CHANGE_SCHEME, ChangeContent } from "./change-content.js";
import { ChangeNote, NOTE_SCHEME } from "./change-note.js";
import { ChangeView } from "./change-view.js";
import { ReviewComments } from "./comments.js";
import { KeptReviews } from "./kept-reviews.js";
import { RECORD_SCHEME, RecordContent } from "./record.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore, type ReviewFailure } from "./review-store.js";

/** Review in the editor (story d), as the extension starts it: one owner, and its surfaces. */
export interface Review extends vscode.Disposable {
  /** A session row was selected, or a workspace window found its own session. */
  follow(project: Project, session: Session): void;
  /** `Mend: Review change`: follow the session and bring the Change section on screen. */
  show(project: Project, session: Session): Promise<void>;
  heard(event: EventPointer): void;
  /** First run holds the view: drop what the section shows. */
  forget(): void;
}

export const startReview = (deps: {
  readonly client: MendClient;
  readonly memento: ReviewMemento;
  /** Where her pending comments are kept, in the global storage every window shares. */
  readonly keptDirectory: string;
  readonly onError: (cause: unknown) => void;
  /** The toast claims every window of this VS Code shares with the notifier. */
  readonly claims: Pick<ToastClaims, "claim" | "release">;
}): Review => {
  const client = new ReviewClient(
    () => deps.client.connection(),
    (connection) => deps.client.refused(connection),
  );
  const store = new ReviewStore(
    deps.client,
    client,
    new ReviewMemory(deps.memento),
    new KeptReviews(deps.keptDirectory),
  );
  const note = new ChangeNote(() => store.ready());
  const record = new RecordContent();
  const view = new ChangeView(
    store,
    record,
    deps.onError,
    async () => (await deps.client.connection()).url,
  );
  const content = new ChangeContent(client, () => deps.client.connection());
  const comments = new ReviewComments(store);
  /**
   * A review failure toasts once in this VS Code (rule 14): claimed as the notifier claims its
   * toasts, then checked again, since Mend may have moved on while the claim was made.
   */
  const toast = async (failure: ReviewFailure): Promise<void> => {
    // A refused sign-in reads as it does on every surface: Mend's words with Connect.
    if (refusedSignIn(failure.cause)) {
      deps.onError(failure.cause);
      return;
    }
    if (!(await deps.claims.claim(failure.key, failure.at))) return;
    if (!store.stillFails(failure)) {
      await deps.claims.release(failure.key, failure.at);
      return;
    }
    void vscode.window.showErrorMessage(failure.words);
  };
  const disposables: ReadonlyArray<vscode.Disposable> = [
    vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, content),
    vscode.workspace.registerTextDocumentContentProvider(RECORD_SCHEME, record),
    vscode.workspace.registerTextDocumentContentProvider(NOTE_SCHEME, note),
    store.onDidChange(() => note.redraw()),
    store.onDidFail((failure) => void toast(failure)),
    // Her comments are kept per machine: a window coming to the front reads what another kept.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void store.reloadReview();
    }),
    comments,
    note,
    record,
    view,
    store,
  ];
  return {
    follow: (project, session) => store.follow(project, session),
    show: async (project, session) => {
      store.follow(project, session);
      await view.reveal();
    },
    heard: (event) => store.heard(event),
    forget: () => {
      store.forget();
      content.clear();
    },
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
};
