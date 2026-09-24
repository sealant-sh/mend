import { useSyncExternalStore } from "react";

import { LIVE_PROCESS, openShell, type SessionProcessDto } from "#/lib/api";
import { queryClient } from "#/lib/queries";

/**
 * The client-owned layout of server-owned sessions and supporting processes.
 * Local storage remembers tabs and focus; the process index decides whether a
 * shell still exists. Detaching removes a view, never a process.
 */

export type Tab =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "shell"; readonly sessionId: string; readonly processId: string }
  /** Read-only durable output of one process; outlives the process itself. */
  | {
      readonly kind: "logs";
      readonly sessionId: string;
      readonly processId: string;
      readonly name: string;
    };

export interface ProjectTabs {
  readonly tabs: ReadonlyArray<Tab>;
  readonly focused: number;
}

export interface WorkbenchState {
  readonly focusedProjectId: string | null;
  readonly byProject: Record<string, ProjectTabs>;
  /** Session whose supporting shell is being opened. */
  readonly opening: string | null;
}

const KEY = "mend-workbench";
const EMPTY: WorkbenchState = { focusedProjectId: null, byProject: {}, opening: null };
const hydratedProjects = new Set<string>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseTab = (value: unknown): Tab | null => {
  if (!isRecord(value) || typeof value.sessionId !== "string") return null;
  if (value.kind === "session") return { kind: "session", sessionId: value.sessionId };
  if (value.kind === "shell" && typeof value.processId === "string") {
    return { kind: "shell", sessionId: value.sessionId, processId: value.processId };
  }
  if (value.kind === "logs" && typeof value.processId === "string") {
    return {
      kind: "logs",
      sessionId: value.sessionId,
      processId: value.processId,
      name: typeof value.name === "string" ? value.name : "logs",
    };
  }
  // Anything else (an older layout's shape, a shell tab with no process id) is dropped.
  return null;
};

const parseProjectTabs = (value: unknown): ProjectTabs | null => {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const tabs = value.tabs.flatMap((entry) => {
    const tab = parseTab(entry);
    return tab === null ? [] : [tab];
  });
  const focused =
    typeof value.focused === "number" && Number.isSafeInteger(value.focused)
      ? Math.max(0, Math.min(value.focused, Math.max(0, tabs.length - 1)))
      : 0;
  return { tabs, focused };
};

const read = (): WorkbenchState => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return EMPTY;
    const byProject: Record<string, ProjectTabs> = {};
    if (isRecord(parsed.byProject)) {
      for (const [projectId, value] of Object.entries(parsed.byProject)) {
        const projectTabs = parseProjectTabs(value);
        if (projectTabs !== null) byProject[projectId] = projectTabs;
      }
    }
    return {
      focusedProjectId:
        typeof parsed.focusedProjectId === "string" ? parsed.focusedProjectId : null,
      byProject,
      opening: null,
    };
  } catch {
    return EMPTY;
  }
};

let state: WorkbenchState = read();
const listeners = new Set<() => void>();

const set = (next: WorkbenchState) => {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...next, opening: null }));
  } catch {
    // Storage unavailable. The in-memory layout still works for this window.
  }
  for (const listener of listeners) listener();
};

/** Subscribe to the desktop's current tab layout. */
export const useWorkbench = (): WorkbenchState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );

const tabsOf = (projectId: string): ProjectTabs =>
  state.byProject[projectId] ?? { tabs: [], focused: 0 };

const tabKey = (tab: Tab): string =>
  tab.kind === "session"
    ? `s:${tab.sessionId}`
    : tab.kind === "shell"
      ? `p:${tab.processId}`
      : `l:${tab.processId}`;

const withTabs = (projectId: string, next: ProjectTabs): WorkbenchState => ({
  ...state,
  focusedProjectId: projectId,
  byProject: { ...state.byProject, [projectId]: next },
});

const addOrRaise = (projectId: string, tab: Tab) => {
  const current = tabsOf(projectId);
  const existing = current.tabs.findIndex((candidate) => tabKey(candidate) === tabKey(tab));
  set(
    withTabs(
      projectId,
      existing === -1
        ? { tabs: [...current.tabs, tab], focused: current.tabs.length }
        : { ...current, focused: existing },
    ),
  );
};

/** Local layout operations. Process lifecycle stays behind the Mend API. */
export const workbench = {
  focusProject: (projectId: string) => {
    if (state.focusedProjectId === projectId) return;
    set({ ...state, focusedProjectId: projectId });
  },

  focusTab: (projectId: string, index: number) => {
    const current = tabsOf(projectId);
    if (index < 0 || index >= current.tabs.length) return;
    set(withTabs(projectId, { ...current, focused: index }));
  },

  /** Open or raise the tab viewing a coding-agent session. */
  openSession: (projectId: string, sessionId: string) => {
    addOrRaise(projectId, { kind: "session", sessionId });
  },

  /** Open or raise one server-owned supporting shell. */
  openShell: (projectId: string, sessionId: string, processId: string) => {
    addOrRaise(projectId, { kind: "shell", sessionId, processId });
  },

  /** Open or raise the read-only durable logs of one process. */
  openLogs: (projectId: string, sessionId: string, processId: string, name: string) => {
    addOrRaise(projectId, { kind: "logs", sessionId, processId, name });
  },

  /** Detach one view without changing its server-owned process. */
  detachTab: (projectId: string, index: number) => {
    const current = tabsOf(projectId);
    const tabs = current.tabs.filter((_, candidate) => candidate !== index);
    const focused = Math.min(
      current.focused >= index ? current.focused - 1 : current.focused,
      tabs.length - 1,
    );
    set(withTabs(projectId, { tabs, focused: Math.max(0, focused) }));
  },

  /**
   * Reconcile saved layout with server facts. The first pass also restores
   * every live shell after an app restart; later absent tabs stay detached.
   */
  reconcileProject: (
    projectId: string,
    knownSessions: ReadonlySet<string>,
    shellProcesses: ReadonlyArray<SessionProcessDto>,
  ) => {
    const liveShells = shellProcesses.filter(
      (process) => process.kind === "shell" && LIVE_PROCESS.has(process.status),
    );
    const liveById = new Map(liveShells.map((process) => [process.id, process]));
    const current = tabsOf(projectId);
    let tabs = current.tabs.filter((tab) => {
      if (!knownSessions.has(tab.sessionId)) return false;
      // Logs read the durable record, so the tab outlives its process.
      if (tab.kind === "session" || tab.kind === "logs") return true;
      return liveById.has(tab.processId);
    });
    if (!hydratedProjects.has(projectId)) {
      hydratedProjects.add(projectId);
      const present = new Set(tabs.flatMap((tab) => (tab.kind === "shell" ? [tab.processId] : [])));
      tabs = [
        ...tabs,
        ...liveShells
          .filter((process) => !present.has(process.id))
          .map<Tab>((process) => ({
            kind: "shell",
            sessionId: process.sessionId,
            processId: process.id,
          })),
      ];
    }
    if (
      tabs.length === current.tabs.length &&
      tabs.every((tab, index) => tabKey(tab) === tabKey(current.tabs[index] ?? tab))
    ) {
      return;
    }
    set(
      withTabs(projectId, {
        tabs,
        focused: Math.max(0, Math.min(current.focused, tabs.length - 1)),
      }),
    );
  },
};

/** Open a supporting shell in one visible session and focus its process tab. */
export const openShellTab = async (projectId: string, sessionId: string): Promise<void> => {
  if (state.opening !== null) return;
  set({ ...state, opening: sessionId });
  try {
    const process = await openShell(sessionId);
    workbench.openShell(projectId, sessionId, process.id);
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId, "processes"] });
  } finally {
    set({ ...state, opening: null });
  }
};
