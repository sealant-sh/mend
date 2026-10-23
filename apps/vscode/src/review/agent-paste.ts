import type { MendConnection } from "../config.js";
import { attachableProcesses } from "../tty-protocol.js";
import type { SessionDetail } from "../types.js";
import { Unbound, type SessionReads } from "./binding.js";

/** Where a G12 paste went: into the agent's input, or nowhere, and why. */
export type Pasted = "pasted" | "agent-gone" | "not-attached";

/**
 * The paste of a send's review into the agent process `processId`, its reads of Mend made through
 * `reads`, bound to the send: one that refuses throws `Unbound`, and nothing is pasted. `bound`
 * throws `Unbound` once VS Code's connection is not the send's.
 */
export type PasteReview = (
  sessionId: string,
  processId: string,
  text: string,
  reads: SessionReads,
  bound: () => Promise<MendConnection>,
) => Promise<Pasted>;

/** What a paste into a session's agent terminal does to the world, injected so it reads plain. */
export interface PasteEffects<Tab> {
  readonly detail: (sessionId: string) => Promise<SessionDetail>;
  /**
   * VS Code's connection while it is the send's; throws `Unbound` otherwise. Asked after the last
   * read, right before the write: she can sign out while that read is out.
   */
  readonly bound: () => Promise<MendConnection>;
  /** Answer: the session's agent attached and shown in this window's panel. */
  readonly answer: (sessionId: string) => Promise<void>;
  /** The active terminal tab when it is one of this session's; null otherwise. */
  readonly activeTab: (sessionId: string) => Tab | null;
  /** The process a tab is attached to; null for any other tab. */
  readonly processOf: (tab: Tab) => string | null;
  /**
   * The bracketed paste into the tab, once its socket is open and `ready` answers true, asked right
   * before the write; false when the socket never opened or `ready` said no. Throws what `ready`
   * throws, and then writes nothing.
   */
  readonly paste: (tab: Tab, text: string, ready: () => Promise<boolean>) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

const ATTACH_WAIT_MS = 10_000;
const ATTACH_POLL_MS = 100;

/**
 * Pastes the review into the one agent process Mend held it for (G12 fallback). Answer attaches
 * whatever the session runs now, and once the agent exits that is a supporting shell, where a
 * pasted line would run: so the paste goes only into a tab attached to that process, and only
 * while Mend lists the process live, read again once the tab's socket is open, right before the
 * write, since the socket can take seconds to open. A failure before the write pasted nothing, so
 * it reads not attached; only the write itself throws, and a connection that is not the send's,
 * which pasted nothing either.
 */
export const pasteIntoAgent = async <Tab>(
  effects: PasteEffects<Tab>,
  sessionId: string,
  processId: string,
  text: string,
): Promise<Pasted> => {
  const found = await attach(effects, sessionId, processId).catch((cause: unknown): Pasted => {
    if (cause instanceof Unbound) throw cause;
    return "not-attached";
  });
  if (typeof found === "string") return found;
  let unwritten: Exclude<Pasted, "pasted"> = "not-attached";
  const written = await effects.paste(found.tab, text, async () => {
    try {
      if (await live(effects, sessionId, processId)) {
        await effects.bound();
        return true;
      }
      unwritten = "agent-gone";
    } catch (cause) {
      if (cause instanceof Unbound) throw cause;
    }
    return false;
  });
  return written ? "pasted" : unwritten;
};

/** Whether Mend lists the agent process live in the session now. */
const live = async <Tab>(
  effects: PasteEffects<Tab>,
  sessionId: string,
  processId: string,
): Promise<boolean> =>
  attachableProcesses((await effects.detail(sessionId)).processes).some(
    (process) => process.id === processId && process.kind === "agent-pty",
  );

/** The tab attached to the agent process, while Mend lists it live; else why there is none. */
const attach = async <Tab>(
  effects: PasteEffects<Tab>,
  sessionId: string,
  processId: string,
): Promise<{ readonly tab: Tab } | Exclude<Pasted, "pasted">> => {
  const listed = (): Promise<boolean> => live(effects, sessionId, processId);
  if (!(await listed())) return "agent-gone";
  await effects.answer(sessionId);
  for (let waited = 0; waited < ATTACH_WAIT_MS; waited += ATTACH_POLL_MS) {
    const tab = effects.activeTab(sessionId);
    if (tab !== null) {
      if (effects.processOf(tab) !== processId)
        return (await listed()) ? "not-attached" : "agent-gone";
      return (await listed()) ? { tab } : "agent-gone";
    }
    await effects.sleep(ATTACH_POLL_MS);
  }
  return "not-attached";
};
