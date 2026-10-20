import { maySteer, ownsSession, rowCapability } from "./session-capability.js";
import type { Session, SessionDetail } from "./types.js";
import {
  agentTab,
  handoffRefusedLine,
  missingSessionLine,
  notInWorkspaceLine,
  type AgentTab,
} from "./window-role.js";

/** One terminal tab in the panel, as the window's attach lifecycle sees it. */
export interface AgentTabHandle {
  show(): void;
  dispose(): void;
  /** False once its process ended. */
  live(): boolean;
}

/** A conversation's tab: it has no terminal to attach, only lines, and Continue here on them. */
export interface ConversationTabHandle extends AgentTabHandle {
  say(line: string): void;
}

/** Everything the window's tabs do to the world, injected so the lifecycle itself stays pure. */
export interface AgentTabEffects {
  readonly detail: (sessionId: string) => Promise<SessionDetail>;
  /** Who is signed in; null when Mend cannot say. */
  readonly viewer: () => Promise<string | null>;
  readonly ownerName: (userId: string | null) => Promise<string>;
  /** Attaches a PTY process in a new tab, shown and focused. */
  readonly attachPty: (facts: {
    readonly session: Session;
    readonly processId: string;
    readonly name: string;
    readonly viewer: string | null;
  }) => Promise<AgentTabHandle>;
  /** A conversation's tab with its lines, shown and focused. */
  readonly showConversation: (facts: {
    readonly name: string;
    readonly lines: ReadonlyArray<string>;
  }) => ConversationTabHandle;
  /** Mend's mode handoff: POST /sessions/:id/handoff {to:"pty"}. */
  readonly handoff: (sessionId: string) => Promise<void>;
  /** Whether a read failed because Mend no longer has the session (a 404). */
  readonly gone: (cause: unknown) => boolean;
  /** The server's refusal (a 422) by its tag and words; null for any other failure. */
  readonly refusal: (
    cause: unknown,
  ) => { readonly tag: string | null; readonly words: string } | null;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onError: (cause: unknown) => void;
  /** Says why the window attaches no agent for the session. */
  readonly refused: (line: string) => void;
}

type Attached =
  | { readonly kind: "pty"; readonly processId: string; readonly tab: AgentTabHandle }
  | {
      readonly kind: "conversation";
      readonly processId: string;
      readonly tab: ConversationTabHandle;
      readonly session: Session;
      readonly harness: string;
      readonly viewer: string | null;
    };

const CONTINUE_RETRY = "Continue here to try again";

const reasonOf = (cause: unknown): string =>
  cause instanceof Error && cause.message !== ""
    ? cause.message
    : "Mend could not continue the conversation here";

/**
 * A workspace window's agent tabs, one per session. Every focus reads the session first: a tab
 * whose process ended, or whose session's agent is now another process (the phone moved it into
 * a conversation, a handoff moved it into a terminal), is replaced, never shown as if live.
 */
export class AgentTabs {
  readonly #attached = new Map<string, Attached>();
  readonly #focusing = new Map<string, Promise<void>>();
  readonly #continuing = new Map<string, Promise<void>>();
  readonly #handoffWaitMs: number;
  readonly #pollMs: number;

  constructor(
    private readonly effects: AgentTabEffects,
    options: { readonly handoffWaitMs?: number; readonly pollMs?: number } = {},
  ) {
    this.#handoffWaitMs = options.handoffWaitMs ?? 30_000;
    this.#pollMs = options.pollMs ?? 1_000;
  }

  /**
   * Shows the session's live agent: its tab when that still is the agent, else a new one. A
   * workspace window names its workspace, and attaches nothing for a session that left it; Answer
   * names none, since it attaches the agent in whatever window she is in.
   */
  focus(sessionId: string, workspaceId: string | null): Promise<void> {
    const running = this.#focusing.get(sessionId);
    if (running !== undefined) return running;
    const run = this.#reconcile(sessionId, workspaceId).finally(() =>
      this.#focusing.delete(sessionId),
    );
    this.#focusing.set(sessionId, run);
    return run;
  }

  /** She closed the tab: the window keeps nothing of it, and the next focus attaches anew. */
  forget(tab: AgentTabHandle): void {
    for (const [sessionId, attached] of this.#attached) {
      if (attached.tab === tab) this.#attached.delete(sessionId);
    }
  }

  /** The session whose agent this tab shows; null for any other tab. */
  sessionOf(tab: AgentTabHandle): string | null {
    for (const [sessionId, attached] of this.#attached) if (attached.tab === tab) return sessionId;
    return null;
  }

  /** The session whose conversation this tab shows, when Continue here is hers to click now. */
  continueOffered(tab: AgentTabHandle): string | null {
    for (const [sessionId, attached] of this.#attached) {
      if (attached.tab !== tab) continue;
      return attached.kind === "conversation" &&
        ownsSession(attached.session, attached.viewer) &&
        !this.#continuing.has(sessionId)
        ? sessionId
        : null;
    }
    return null;
  }

  /** Moves the conversation into a terminal; a second click while one runs joins it. */
  continueHere(sessionId: string): Promise<void> {
    const running = this.#continuing.get(sessionId);
    if (running !== undefined) return running;
    const attached = this.#attached.get(sessionId);
    if (attached?.kind !== "conversation") return Promise.resolve();
    const run = this.#continue(sessionId, attached).finally(() =>
      this.#continuing.delete(sessionId),
    );
    this.#continuing.set(sessionId, run);
    return run;
  }

  async #reconcile(sessionId: string, workspaceId: string | null): Promise<void> {
    const { effects } = this;
    try {
      if (this.#showContinuing(sessionId)) return;
      const [detail, viewer] = await Promise.all([effects.detail(sessionId), effects.viewer()]);
      if (this.#showContinuing(sessionId)) return;
      if (workspaceId !== null && detail.session.sealantWorkspaceId !== workspaceId) {
        effects.refused(notInWorkspaceLine(detail.session));
        return;
      }
      const want = agentTab(detail.session, detail.processes);
      // Answer shows a conversation's tab to its owner, wherever launched. Otherwise only the
      // workspace's launcher types into its agent; anyone else, and anyone Mend cannot name, gets
      // nothing here (Watch terminal is the read-only way in).
      const answering =
        workspaceId === null &&
        want.kind === "conversation" &&
        viewer !== null &&
        ownsSession(detail.session, viewer);
      const capability = rowCapability({ session: detail.session, viewer, members: [] });
      if (!answering && capability.kind !== "open") {
        effects.refused(`${capability.why} · no agent attached`);
        return;
      }
      if (viewer !== null && !maySteer(detail.session, viewer)) return;
      const have = this.#attached.get(sessionId);
      if (
        have !== undefined &&
        have.tab.live() &&
        want.kind === have.kind &&
        want.processId === have.processId
      ) {
        have.tab.show();
        return;
      }
      if (have !== undefined) {
        this.#attached.delete(sessionId);
        have.tab.dispose();
      }
      await this.#attach(sessionId, detail, viewer, want);
    } catch (cause) {
      if (effects.gone(cause)) effects.refused(missingSessionLine(sessionId));
      else effects.onError(cause);
    }
  }

  /** A continuation replaces the conversation's tab itself; until then that tab is the agent. */
  #showContinuing(sessionId: string): boolean {
    if (!this.#continuing.has(sessionId)) return false;
    this.#attached.get(sessionId)?.tab.show();
    return true;
  }

  async #attach(
    sessionId: string,
    detail: SessionDetail,
    viewer: string | null,
    want: AgentTab,
  ): Promise<void> {
    const { effects } = this;
    if (want.kind === "pty") {
      const tab = await effects.attachPty({
        session: detail.session,
        processId: want.processId,
        name: want.name,
        viewer,
      });
      this.#attached.set(sessionId, { kind: "pty", processId: want.processId, tab });
    } else if (want.kind === "conversation") {
      const lines = ownsSession(detail.session, viewer)
        ? [want.line]
        : [`read-only · ${await effects.ownerName(detail.session.ownerUserId)}'s session`];
      this.#attached.set(sessionId, {
        kind: "conversation",
        processId: want.processId,
        tab: effects.showConversation({ name: want.name, lines }),
        session: detail.session,
        harness:
          detail.processes.find((process) => process.id === want.processId)?.harness ??
          detail.session.harness,
        viewer,
      });
    }
  }

  /**
   * Mend's mode handoff moves the same conversation into a terminal, then that terminal replaces
   * this tab. Any failure leaves the conversation's tab in place with Continue here to try again:
   * a handoff the server already made is a no-op the second time.
   */
  async #continue(
    sessionId: string,
    conversation: Extract<Attached, { readonly kind: "conversation" }>,
  ): Promise<void> {
    const { effects } = this;
    const { tab, harness, viewer } = conversation;
    try {
      try {
        await effects.handoff(sessionId);
      } catch (cause) {
        const refusal = effects.refusal(cause);
        if (refusal === null) throw cause;
        tab.say(handoffRefusedLine(harness, refusal));
        return;
      }
      tab.say("continuing in a terminal");
      const deadline = effects.now() + this.#handoffWaitMs;
      for (;;) {
        const detail = await effects.detail(sessionId);
        const next = agentTab(detail.session, detail.processes);
        if (
          next.kind === "pty" &&
          detail.processes.some(
            (process) => process.id === next.processId && process.kind === "agent-pty",
          )
        ) {
          const terminal = await effects.attachPty({
            session: detail.session,
            processId: next.processId,
            name: next.name,
            viewer,
          });
          this.#attached.set(sessionId, { kind: "pty", processId: next.processId, tab: terminal });
          tab.dispose();
          return;
        }
        if (effects.now() >= deadline) {
          throw new Error(
            `${harness} did not reach a terminal in ${Math.round(this.#handoffWaitMs / 1000)} s`,
          );
        }
        await effects.sleep(this.#pollMs);
      }
    } catch (cause) {
      tab.say(`${reasonOf(cause)} · ${CONTINUE_RETRY}`);
    }
  }
}
