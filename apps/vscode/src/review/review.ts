import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import type { Project, Session } from "../types.js";
import { CHANGE_SCHEME, ChangeContent } from "./change-content.js";
import { ChangeView } from "./change-view.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory, type ReviewMemento } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";

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
  readonly onError: (cause: unknown) => void;
}): Review => {
  const client = new ReviewClient(() => deps.client.connection());
  const store = new ReviewStore(deps.client, client, new ReviewMemory(deps.memento));
  const view = new ChangeView(
    store,
    deps.onError,
    async () => (await deps.client.connection()).url,
  );
  const content = new ChangeContent(client, () => deps.client.connection());
  const provider = vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, content);
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
      provider.dispose();
      view.dispose();
      store.dispose();
    },
  };
};
