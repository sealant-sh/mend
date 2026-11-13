import { useSyncExternalStore } from "react";

/**
 * Which face the left rail shows (BRIEF.md §sidebar), remembered per
 * machine. `tree` is the place tree — projects open into their sessions,
 * each session into its harness and shells. `inbox` is the flat
 * cross-project list; focusing one project there reveals its sub-views
 * behind a compact switcher. Same shape as lib/theme.ts: module state + one
 * localStorage key + useSyncExternalStore.
 */

export type SidebarView = "tree" | "inbox";
export type ProjectSubView = "inbox" | "services" | "prs" | "files";

export interface SidebarViewState {
  readonly view: SidebarView;
  /** The project the inbox view is narrowed to; null = every project. */
  readonly inboxProjectId: string | null;
  readonly subView: ProjectSubView;
}

const KEY = "mend-sidebar-view";
const FALLBACK: SidebarViewState = { view: "tree", inboxProjectId: null, subView: "inbox" };
const VIEWS: ReadonlyArray<SidebarView> = ["tree", "inbox"];
const SUB_VIEWS: ReadonlyArray<ProjectSubView> = ["inbox", "services", "prs", "files"];

const isView = (value: unknown): value is SidebarView => VIEWS.some((view) => view === value);
const isSubView = (value: unknown): value is ProjectSubView =>
  SUB_VIEWS.some((view) => view === value);

const read = (): SidebarViewState => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return FALLBACK;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return FALLBACK;
    const record = parsed as { view?: unknown; inboxProjectId?: unknown; subView?: unknown };
    return {
      view: isView(record.view) ? record.view : FALLBACK.view,
      inboxProjectId: typeof record.inboxProjectId === "string" ? record.inboxProjectId : null,
      subView: isSubView(record.subView) ? record.subView : FALLBACK.subView,
    };
  } catch {
    return FALLBACK;
  }
};

let state: SidebarViewState = read();
const listeners = new Set<() => void>();

const set = (next: SidebarViewState) => {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the choice still holds for this window.
  }
  for (const listener of listeners) listener();
};

export const useSidebarView = (): SidebarViewState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );

export const sidebarView = {
  setView: (view: SidebarView) => set({ ...state, view }),
  /** Ctrl+Shift+B walks tree → inbox → tree. */
  cycle: () => set({ ...state, view: state.view === "tree" ? "inbox" : "tree" }),
  /** Narrow the inbox to one project (null widens back to all) and land on its inbox. */
  focusProject: (projectId: string | null) =>
    set({ ...state, view: "inbox", inboxProjectId: projectId, subView: "inbox" }),
  setSubView: (subView: ProjectSubView) => set({ ...state, subView }),
};
