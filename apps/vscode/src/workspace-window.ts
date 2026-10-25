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
import { requestOfWindow, sessionOfWorkspace, type WindowRole } from "./window-role.js";

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
 * with its line, where Continue here hands it to a terminal through Mend's mode switch.
 */
export class WorkspaceWindow implements vscode.Disposable {
  #located: { readonly project: Project; readonly session: Session } | null = null;
  #notice: vscode.Disposable | null = null;
  /** Activation and a focus event can both reach for the Open's intent: only one takes it. */
  #focuses: Promise<void> = Promise.resolve();
  readonly #located$ = new vscode.EventEmitter<void>();
  /** The window found (or changed) the session it is the workspace of. */
  readonly onDidLocate = this.#located$.event;
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
      switchMode: async (sessionId) => {
        await client.switchMode(sessionId, "pty");
      },
      gone: (cause) => cause instanceof MendApiError && cause.status === 404,
      refusal: (cause) =>
        cause instanceof MendApiError && cause.status === 422
          ? { tag: cause.tag, words: cause.message }
          : null,
      now: () => Date.now(),
      sleep: (ms) => wait(ms),
      onError,
      refused: (line) => this.#say(line),
      cleared: () => this.#say(null),
    };
    this.#tabs = new AgentTabs(effects);
    // Any window attaches an agent's tab when she answers it (rule 8), so every window tracks them.
    this.#disposables = [
      this.#located$,
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
      ...(role.kind === "workspace"
        ? [
            // VS Code focuses a window already open on the folder instead of opening another.
            vscode.window.onDidChangeWindowState((state) => {
              if (state.focused) void this.#takeIntent();
            }),
          ]
        : []),
    ];
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#notice?.dispose();
  }

  /**
   * Answer (rule 8) for a terminal agent: the session's agent in this window's panel, attached or
   * shown again, in any window, and no window opens. A conversation's request is answered in a
   * quick pick instead (`RequestPrompts`).
   */
  async answer(sessionId: string): Promise<void> {
    try {
      await this.#tabs.focus(sessionId, null);
    } catch (cause) {
      this.onError(cause);
    }
  }

  /** The session whose agent tab is this window's active terminal: the one Answer just showed. */
  terminalSession(): string | null {
    const active = vscode.window.activeTerminal;
    const tab = active === undefined ? undefined : this.#byTerminal.get(active);
    return tab === undefined ? null : this.#tabs.sessionOf(tab);
  }

  /** The session this window is the workspace of, once the window has found it. */
  session(): { readonly project: Project; readonly session: Session } | null {
    return this.#located;
  }

  /** At activation: a workspace window attaches its session's agent terminal. */
  start(): void {
    if (this.role.kind === "workspace") void this.focusAgentTerminal(null);
  }

  /** After a sign-in or a new connection: a workspace window that found no session looks again. */
  locateAgain(): Promise<void> {
    if (this.role.kind !== "workspace") return Promise.resolve();
    const { workspaceId } = this.role;
    return this.#inTurn(async () => {
      if (this.#located === null)
        await this.#show(workspaceId, await this.intents.take(workspaceId));
    });
  }

  /**
   * Show the session's agent, attaching it when this window has no live tab for it. With no
   * session named, the one an Open meant, else the one this window already shows.
   */
  focusAgentTerminal(sessionId: string | null): Promise<void> {
    if (this.role.kind !== "workspace") return Promise.resolve();
    const { workspaceId } = this.role;
    return this.#inTurn(async () => {
      await this.#show(workspaceId, sessionId ?? (await this.intents.take(workspaceId)));
    });
  }

  /** An Open from another window meant a session here: show it. */
  #takeIntent(): Promise<void> {
    if (this.role.kind !== "workspace") return Promise.resolve();
    const { workspaceId } = this.role;
    return this.#inTurn(async () => {
      const requested = await this.intents.take(workspaceId);
      if (requested !== null) await this.#show(workspaceId, requested);
    });
  }

  #inTurn(step: () => Promise<void>): Promise<void> {
    const turn = this.#focuses.then(step).catch((cause: unknown) => this.onError(cause));
    this.#focuses = turn;
    return turn;
  }

  async #show(workspaceId: string, explicit: string | null): Promise<void> {
    const { requested, check } = requestOfWindow({
      explicit,
      shown: this.#located?.session.id ?? null,
    });
    if (check) {
      const { details } = await readProjects(this.client);
      const found = sessionOfWorkspace(details, workspaceId, requested);
      if (found.kind === "missing") {
        this.#say(found.line);
        return;
      }
      // Not a session this person can see: the window stays a plain Remote-SSH window.
      if (found.kind === "none") return;
      this.#located = { project: found.project, session: found.session };
      this.#located$.fire();
    }
    this.#say(null);
    const shown = this.#located;
    if (shown !== null) await this.#tabs.focus(shown.session.id, workspaceId);
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
