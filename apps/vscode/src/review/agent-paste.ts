import { attachableProcesses } from "../tty-protocol.js";
import type { SessionDetail } from "../types.js";

/** Where a G12 paste went: into the agent's input, or nowhere, and why. */
export type Pasted = "pasted" | "agent-gone" | "not-attached";

/** What a paste into a session's agent terminal does to the world, injected so it reads plain. */
export interface PasteEffects<Tab> {
  readonly detail: (sessionId: string) => Promise<SessionDetail>;
  /** Answer: the session's agent attached and shown in this window's panel. */
  readonly answer: (sessionId: string) => Promise<void>;
  /** The active terminal tab when it is one of this session's; null otherwise. */
  readonly activeTab: (sessionId: string) => Tab | null;
  /** The process a tab is attached to; null for any other tab. */
  readonly processOf: (tab: Tab) => string | null;
  /** The bracketed paste into the tab; false when its socket never opened. */
  readonly paste: (tab: Tab, text: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

const ATTACH_WAIT_MS = 10_000;
const ATTACH_POLL_MS = 100;

/**
 * Pastes the review into the one agent process Mend held it for (G12 fallback). Answer attaches
 * whatever the session runs now, and once the agent exits that is a supporting shell, where a
 * pasted line would run: so the paste goes only into a tab attached to that process, and only
 * while Mend lists the process live, read again right before the paste. A failure before the paste
 * pasted nothing, so it reads not attached; only the paste itself throws.
 */
export const pasteIntoAgent = async <Tab>(
  effects: PasteEffects<Tab>,
  sessionId: string,
  processId: string,
  text: string,
): Promise<Pasted> => {
  const found = await attach(effects, sessionId, processId).catch((): Pasted => "not-attached");
  if (typeof found === "string") return found;
  return (await effects.paste(found.tab, text)) ? "pasted" : "not-attached";
};

/** The tab attached to the agent process, while Mend lists it live; else why there is none. */
const attach = async <Tab>(
  effects: PasteEffects<Tab>,
  sessionId: string,
  processId: string,
): Promise<{ readonly tab: Tab } | Exclude<Pasted, "pasted">> => {
  const live = async (): Promise<boolean> =>
    attachableProcesses((await effects.detail(sessionId)).processes).some(
      (process) => process.id === processId && process.kind === "agent-pty",
    );
  if (!(await live())) return "agent-gone";
  await effects.answer(sessionId);
  for (let waited = 0; waited < ATTACH_WAIT_MS; waited += ATTACH_POLL_MS) {
    const tab = effects.activeTab(sessionId);
    if (tab !== null) {
      if (effects.processOf(tab) !== processId)
        return (await live()) ? "not-attached" : "agent-gone";
      return (await live()) ? { tab } : "agent-gone";
    }
    await effects.sleep(ATTACH_POLL_MS);
  }
  return "not-attached";
};
