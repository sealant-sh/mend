import { useEffect } from "react";

/** The sessions the Terminal view has opened a shell for on its own in this page. */
const openedOnOwn = new Set<string>();

/**
 * Whether the Terminal view opens a shell by itself: the person can open one, the workspace runs,
 * and it is read to have no live terminal to show. A watcher never opens one, and a stopped
 * workspace waits for its button: looking doesn't start it.
 */
export const wantsShellOnOwn = (view: {
  /** The session a shell would open on; null when the person can't open one. */
  readonly opensOn: string | null;
  readonly workspaceRuns: boolean;
  /** The live terminals, once every session's processes are read; null until then. */
  readonly liveTerminals: number | null;
}): boolean => view.opensOn !== null && view.workspaceRuns && view.liveTerminals === 0;

/**
 * Opens that shell once per session in this page: a second visit, a shell the person closed, and
 * React running the effect twice in development open no other. A reload reads the shell already
 * open.
 */
export const useShellOnOwn = (
  sessionId: string | null,
  wanted: boolean,
  openShell: (sessionId: string) => void,
) => {
  // The view showing for the first time is the event; its body stays mounted from then on.
  useEffect(() => {
    if (!wanted || sessionId === null || openedOnOwn.has(sessionId)) return;
    openedOnOwn.add(sessionId);
    openShell(sessionId);
  }, [wanted, sessionId, openShell]);
};
