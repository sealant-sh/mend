import type { ComponentType, ReactNode } from "react";

import { CHANGE_VIEW } from "./views/change-view.tsx";
import { PREVIEW_VIEW } from "./views/preview-view.tsx";
import { TERMINAL_VIEW } from "./views/terminal-view.tsx";

/** Where a view opens: the workspace of the session whose page this is. */
export interface ViewPlace {
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly projectId: string;
}

/** What a view's tab and its "+" item say after its name. */
export interface ViewFacts {
  /** Change: lines added and removed. */
  readonly added?: number;
  readonly removed?: number;
  /** Anything else, muted mono: Preview's ":3000", Checks' "2 passed", Terminal's "1 shell". */
  readonly fact?: string;
}

/**
 * A workspace view a tab can hold (ADR 0026): Change, Checks, Preview, Terminal, Screen, Record,
 * Details. Each view's PR adds its entry to `WORKSPACE_VIEWS`; the "+" menu lists only what is
 * there, in that order.
 */
export interface WorkspaceView {
  /** The view's key, in its tab's key (`view:<id>`) and its path (`/sessions/<id>/<id>`). */
  readonly id: string;
  /** Its name in the tab and the menu: "Terminal". */
  readonly name: string;
  /** Its Lucide icon, sized by the tab and the menu. */
  readonly icon: ReactNode;
  /** A hook: the facts its tab and menu item show now. Called once per tab or item. */
  readonly useFacts: (place: ViewPlace) => ViewFacts;
  /** What the tab's body shows. It stays mounted while the tab moves or another tab shows. */
  readonly Body: ComponentType<{ readonly place: ViewPlace }>;
}

/** The views built so far, in the "+" menu's order: Change, Checks, Preview, Terminal, … */
export const WORKSPACE_VIEWS: ReadonlyArray<WorkspaceView> = [
  CHANGE_VIEW,
  PREVIEW_VIEW,
  TERMINAL_VIEW,
];

export const workspaceView = (id: string): WorkspaceView | undefined =>
  WORKSPACE_VIEWS.find((view) => view.id === id);
