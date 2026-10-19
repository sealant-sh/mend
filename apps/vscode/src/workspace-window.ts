import { setTimeout as wait } from "node:timers/promises";

import * as vscode from "vscode";

import {
  AgentTabs,
  type AgentTabEffects,
  type AgentTabHandle,
  type ConversationTabHandle,
} from "./agent-tabs.js";
import { attachTerminal, memberName } from "./agent-terminal.js";
import { MendApiError, type MendClient } from "./client.js";
import type { OpenIntents } from "./open-intent.js";
import { readProjects } from "./session-lines.js";
import type { Project, Session } from "./types.js";
import { sessionOfWorkspace, type WindowRole } from "./window-role.js";

const CONTINUE = "Continue here";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/** A terminal tab in this window, live until its process ends. */
class TerminalTab implements AgentTabHandle {
  constructor(readonly terminal: vscode.Terminal) {}

  show(): void {
    this.terminal.show();
  }

  dispose(): void {
    this.terminal.dispose();
  }

  live(): boolean {
    return this.terminal.exitStatus === undefined;
  }
}

/** A conversation's pseudoterminal: the lines it was given, and any it is told later. */
class ConversationLines implements vscode.Pseudoterminal {
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

class ConversationTab extends TerminalTab implements ConversationTabHandle {
  constructor(
    terminal: vscode.Terminal,
    private readonly lines: ConversationLines,
  ) {
    super(terminal);
  }

  say(line: string): void {
    this.lines.say(line);
  }
}

class ContinueLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    readonly sessionId: string,
  ) {
    super(startIndex, CONTINUE.length, "Continue this conversation in a terminal here");
  }
}

/**
 * A session's workspace window: its agent's terminal attached in the panel and focused, as soon
 * as the window opens. The session is the one the Open meant (`open-intent.ts`), and when the
 * workspace no longer holds it the window attaches nothing and says why in the status bar; a window
 * opened any other way shows the workspace's live session. A conversation started elsewhere gets a tab
 * with its line, where Continue here hands it to a terminal through Mend's mode handoff.
 */
export class WorkspaceWindow implements vscode.Disposable {
  #located: { readonly project: Project; readonly session: Session } | null = null;
  #notice: vscode.Disposable | null = null;
  readonly #tabs: AgentTabs;
  readonly #byTerminal = new WeakMap<vscode.Terminal, TerminalTab>();
  readonly #disposables: ReadonlyArray<vscode.Disposable>;

  constructor(
    private readonly client: MendClient,
    private readonly role: WindowRole,
    private readonly intents: Pick<OpenIntents, "take">,
    private readonly onError: (cause: unknown) => void,
  ) {
    const effects: AgentTabEffects = {
      detail: (sessionId) => client.sessionDetail(sessionId),
      viewer: () => client.viewerId(),
      ownerName: (userId) => memberName(client, userId),
      attachPty: async ({ session, processId, name, viewer }) =>
        this.#track(
          new TerminalTab(
            await attachTerminal(client, {
              session,
              address: { process: processId },
              name,
              viewer,
            }),
          ),
        ),
      showConversation: ({ name, lines }) => {
        const pty = new ConversationLines(lines);
        const terminal = vscode.window.createTerminal({ name, pty });
        terminal.show();
        return this.#track(new ConversationTab(terminal, pty));
      },
      handoff: async (sessionId) => {
        await client.handoff(sessionId, "pty");
      },
      refusal: (cause) =>
        cause instanceof MendApiError && cause.status === 422
          ? { tag: cause.tag, words: cause.message }
          : null,
      now: () => Date.now(),
      sleep: (ms) => wait(ms),
      onError,
    };
    this.#tabs = new AgentTabs(effects);
    this.#disposables =
      role.kind === "workspace"
        ? [
            vscode.window.registerTerminalLinkProvider({
              provideTerminalLinks: (context) => this.#links(context),
              handleTerminalLink: (link) => {
                if (link instanceof ContinueLink) void this.#tabs.continueHere(link.sessionId);
              },
            }),
            vscode.window.onDidCloseTerminal((closed) => {
              const tab = this.#byTerminal.get(closed);
              if (tab !== undefined) this.#tabs.forget(tab);
            }),
            // VS Code focuses a window already open on the folder instead of opening another.
            vscode.window.onDidChangeWindowState((state) => {
              if (state.focused) void this.#takeIntent();
            }),
          ]
        : [];
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#notice?.dispose();
  }

  /** The session this window is the workspace of, once the window has found it. */
  session(): { readonly project: Project; readonly session: Session } | null {
    return this.#located;
  }

  /** At activation: a workspace window attaches its session's agent terminal. */
  start(): void {
    if (this.role.kind === "workspace") void this.focusAgentTerminal(null);
  }

  /**
   * Show the session's agent, attaching it when this window has no live tab for it. With no
   * session named, the one an Open meant, else the one this window already shows.
   */
  async focusAgentTerminal(sessionId: string | null): Promise<void> {
    if (this.role.kind !== "workspace") return;
    try {
      const requested =
        sessionId ??
        (await this.intents.take(this.role.workspaceId)) ??
        this.#located?.session.id ??
        null;
      if (requested === null || requested !== this.#located?.session.id) {
        const { details } = await readProjects(this.client);
        const found = sessionOfWorkspace(details, this.role.workspaceId, requested);
        if (found.kind === "missing") {
          this.#say(found.line);
          return;
        }
        // Not a session this person can see: the window stays a plain Remote-SSH window.
        if (found.kind === "none") return;
        this.#located = { project: found.project, session: found.session };
      }
      this.#say(null);
      const shown = this.#located;
      if (shown !== null) await this.#tabs.focus(shown.session.id);
    } catch (cause) {
      this.onError(cause);
    }
  }

  /** An Open from another window meant a session here: show it. */
  async #takeIntent(): Promise<void> {
    if (this.role.kind !== "workspace") return;
    try {
      const requested = await this.intents.take(this.role.workspaceId);
      if (requested !== null) await this.focusAgentTerminal(requested);
    } catch (cause) {
      this.onError(cause);
    }
  }

  /** Why the window shows no agent, until it shows one. */
  #say(line: string | null): void {
    this.#notice?.dispose();
    this.#notice =
      line === null ? null : vscode.window.setStatusBarMessage(`$(circle-slash) ${line}`);
  }

  #track<Tab extends TerminalTab>(tab: Tab): Tab {
    this.#byTerminal.set(tab.terminal, tab);
    return tab;
  }

  #links(context: vscode.TerminalLinkContext): Array<ContinueLink> {
    const tab = this.#byTerminal.get(context.terminal);
    const sessionId = tab === undefined ? null : this.#tabs.continueOffered(tab);
    if (sessionId === null) return [];
    const at = context.line.indexOf(CONTINUE);
    return at === -1 ? [] : [new ContinueLink(at, sessionId)];
  }
}
