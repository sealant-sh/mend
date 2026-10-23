import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import type { ToastClaims } from "../toast-claims.js";
import type { Project, Session } from "../types.js";
import type { PasteReview } from "./agent-paste.js";
import { CHANGE_SCHEME, ChangeContent } from "./change-content.js";
import { ChangeNote, NOTE_SCHEME } from "./change-note.js";
import { ChangeView } from "./change-view.js";
import { ReviewComments } from "./comments.js";
import type { KeptReviews } from "./kept-reviews.js";
import { RECORD_SCHEME, RecordContent } from "./record.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";
import { reviewToast } from "./review-toast.js";
import { SendEditor } from "./send-editor.js";

/** Review in the editor (story d), as the extension starts it: one owner, and its surfaces. */
export interface Review extends vscode.Disposable {
  /** A session row was selected, or a workspace window found its own session. */
  follow(project: Project, session: Session): void;
  /** `Mend: Review change`: follow the session and bring the Change section on screen. */
  show(project: Project, session: Session): Promise<void>;
  heard(event: EventPointer): void;
  /** First run holds the view: drop what the section shows. */
  forget(): void;
  /** Mend went offline or came back: Send review waits, and her comments stay. */
  setOffline(offline: boolean): void;
}

export const startReview = (deps: {
  readonly client: MendClient;
  readonly kept: KeptReviews;
  readonly onError: (cause: unknown) => void;
  /** The toast claims every window of this VS Code shares with the notifier. */
  readonly claims: Pick<ToastClaims, "claim" | "release">;
  /**
   * G12 fallback: the session's agent terminal attached here, the review pasted into that agent
   * process, without Enter.
   */
  readonly paste: PasteReview;
}): Review => {
  const client = new ReviewClient(
    async () => ({ connection: await deps.client.connection(), current: () => true }),
    (connection) => deps.client.refused(connection),
  );
  const store = new ReviewStore(
    deps.client,
    client,
    new ReviewMemory(deps.kept),
    deps.kept,
    deps.paste,
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
  const toast = reviewToast(store, deps.claims, deps.onError);
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
    new ReviewComments(store),
    new SendEditor(store, deps.onError),
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
    setOffline: (offline) => store.setOffline(offline),
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
};
