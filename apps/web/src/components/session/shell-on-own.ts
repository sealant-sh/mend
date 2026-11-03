import { useEffect } from "react";

/** The sessions whose Terminal tab has opened a shell on its own in this page. */
const openedOnOwn = new Set<string>();

/**
 * Whether the Terminal tab opens a shell by itself: it shows, the person types there, the agent
 * works in a conversation that is running, and the workspace is read to have no shell open. A
 * reader never opens one, and a stopped session waits for its button: looking does not resume it.
 */
export const wantsShellOnOwn = (tab: {
  readonly shown: boolean;
  readonly terminalInput: boolean;
  readonly agentLive: boolean;
  readonly conversationLive: boolean;
  /** The open shells, once the workspace's processes are read; null until then. */
  readonly shells: number | null;
}): boolean =>
  tab.shown && tab.terminalInput && tab.agentLive && tab.conversationLive && tab.shells === 0;

/**
 * Opens that shell once per session in this page: a second visit to the tab, a shell the person
 * closed, and React running the effect twice in development open no other. A reload reads the
 * shell already open.
 */
export const useShellOnOwn = (
  sessionId: string,
  wanted: boolean,
  openShell: (input: { readonly id: string }) => void,
) => {
  // Opening the tab is the event, and the tab is a component that stays mounted once shown.
  useEffect(() => {
    if (!wanted || openedOnOwn.has(sessionId)) return;
    openedOnOwn.add(sessionId);
    openShell({ id: sessionId });
  }, [wanted, sessionId, openShell]);
};
