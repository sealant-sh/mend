import { setTimeout as wait } from "node:timers/promises";

import * as vscode from "vscode";

import { attachTerminal, maySteer, memberName, ownsSession } from "./agent-terminal.js";
import { MendApiError, type MendClient } from "./client.js";
import { readProjects } from "./session-lines.js";
import type { Project, Session } from "./types.js";
import {
  agentTab,
  handoffRefusedLine,
  sessionOfWorkspace,
  type WindowRole,
} from "./window-role.js";

const CONTINUE = "Continue here";
const HANDOFF_WAIT_MS = 30_000;
const HANDOFF_POLL_MS = 1_000;

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/** A conversation's tab: it has no terminal to attach, only its line and Continue here. */
class ConversationTab implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(private readonly lines: ReadonlyArray<string>) {}

  open(): void {
    for (const line of this.lines) this.say(line);
  }

  close(): void {}

  say(line: string): void {
    this.writeEmitter.fire(`${dim(line)}\r\n`);
  }
}

class ContinueLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    readonly terminal: vscode.Terminal,
  ) {
    super(startIndex, CONTINUE.length, "Continue this conversation in a terminal here");
  }
}

interface Conversation {
  readonly terminal: vscode.Terminal;
  readonly tab: ConversationTab;
  readonly session: Session;
  readonly harness: string;
  readonly viewer: string | null;
}

/**
 * A session's workspace window: its agent's terminal attached in the panel and focused, as soon
 * as the window opens. A conversation started elsewhere gets a tab with its line, where
 * Continue here hands it to a terminal through Mend's mode handoff.
 */
export class WorkspaceWindow implements vscode.Disposable {
  #terminal: vscode.Terminal | null = null;
  #conversation: Conversation | null = null;
  #attaching: Promise<void> | null = null;
  #located: { readonly project: Project; readonly session: Session } | null = null;
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly client: MendClient,
    private readonly role: WindowRole,
    private readonly onError: (cause: unknown) => void,
  ) {
    this.#disposables =
      role.kind === "workspace"
        ? [
            vscode.window.registerTerminalLinkProvider({
              provideTerminalLinks: (context) => this.#links(context),
              handleTerminalLink: (link) => {
                if (link instanceof ContinueLink) void this.#continueHere(link.terminal);
              },
            }),
            vscode.window.onDidCloseTerminal((closed) => {
              if (closed === this.#terminal) this.#terminal = null;
              if (closed === this.#conversation?.terminal) this.#conversation = null;
            }),
          ]
        : [];
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** The session this window is the workspace of, once the window has found it. */
  session(): { readonly project: Project; readonly session: Session } | null {
    return this.#located;
  }

  /** At activation: a workspace window attaches its session's agent terminal. */
  start(): void {
    if (this.role.kind === "workspace") void this.focusAgentTerminal();
  }

  /** Show the attached tab, or attach it when this window has none yet. */
  async focusAgentTerminal(): Promise<void> {
    const open = this.#terminal ?? this.#conversation?.terminal ?? null;
    if (open !== null) {
      open.show();
      return;
    }
    this.#attaching ??= this.#attach().finally(() => {
      this.#attaching = null;
    });
    await this.#attaching;
  }

  async #attach(): Promise<void> {
    if (this.role.kind !== "workspace") return;
    try {
      const { details, viewer: knownViewer } = await readProjects(this.client);
      const located = sessionOfWorkspace(details, this.role.workspaceId);
      // Not a session this person can see: the window stays a plain Remote-SSH window.
      if (located === null) return;
      this.#located = located;
      const detail = await this.client.sessionDetail(located.session.id);
      const viewer = knownViewer ?? (await this.client.viewerId());
      if (viewer !== null && !maySteer(detail.session, viewer)) return;
      const tab = agentTab(detail.session, detail.processes);
      if (tab.kind === "pty") {
        this.#terminal = await attachTerminal(this.client, {
          session: detail.session,
          address: { process: tab.processId },
          name: tab.name,
          viewer,
        });
      } else if (tab.kind === "conversation") {
        const owns = ownsSession(detail.session, viewer);
        const lines = owns
          ? [tab.line]
          : [`read-only · ${await memberName(this.client, detail.session.ownerUserId)}'s session`];
        const conversationTab = new ConversationTab(lines);
        const terminal = vscode.window.createTerminal({ name: tab.name, pty: conversationTab });
        terminal.show();
        this.#conversation = {
          terminal,
          tab: conversationTab,
          session: detail.session,
          harness:
            detail.processes.findLast((process) => process.kind === "agent-protocol")?.harness ??
            detail.session.harness,
          viewer,
        };
      }
    } catch (cause) {
      this.onError(cause);
    }
  }

  #links(context: vscode.TerminalLinkContext): Array<ContinueLink> {
    const conversation = this.#conversation;
    if (conversation === null || context.terminal !== conversation.terminal) return [];
    if (!ownsSession(conversation.session, conversation.viewer)) return [];
    const at = context.line.indexOf(CONTINUE);
    return at === -1 ? [] : [new ContinueLink(at, context.terminal)];
  }

  /** Mend's mode handoff moves the same conversation into a terminal, then this tab becomes it. */
  async #continueHere(terminal: vscode.Terminal): Promise<void> {
    const conversation = this.#conversation;
    if (conversation === null || conversation.terminal !== terminal) return;
    const { session, tab, harness, viewer } = conversation;
    try {
      await this.client.handoff(session.id, "pty");
    } catch (cause) {
      if (cause instanceof MendApiError && cause.status === 422) {
        tab.say(handoffRefusedLine(harness, { tag: cause.tag, words: cause.message }));
        return;
      }
      this.onError(cause);
      return;
    }
    tab.say("continuing in a terminal");
    const deadline = Date.now() + HANDOFF_WAIT_MS;
    while (Date.now() < deadline) {
      const detail = await this.client.sessionDetail(session.id);
      const next = agentTab(detail.session, detail.processes);
      const agent = detail.processes.find(
        (process) => next.kind === "pty" && process.id === next.processId,
      );
      if (next.kind === "pty" && agent?.kind === "agent-pty") {
        terminal.dispose();
        this.#conversation = null;
        this.#terminal = await attachTerminal(this.client, {
          session: detail.session,
          address: { process: next.processId },
          name: terminal.name,
          viewer,
        });
        return;
      }
      await wait(HANDOFF_POLL_MS);
    }
    this.onError(new Error(`${harness} did not reach a terminal in 30 s`));
  }
}
