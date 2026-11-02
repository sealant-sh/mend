import type { WorkspaceSshTarget } from "@mend/workspace-ssh";
import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import type { ConnectionStore } from "./config.js";
import { showErrorToast } from "./error-toast.js";
import {
  accountEmail,
  firstRun,
  missingSteps,
  projectMatch,
  runSetUp,
  setUpTitle,
  TRY_AGAIN,
  useCli as useCliOffer,
  viewMode,
  type CliOffer,
  type Connection,
  type FirstRun,
  type Offer,
  type SshFacts,
  type ViewMode,
} from "./first-run.js";
import { requestMend } from "./mend-http.js";
import {
  installRemoteSsh,
  recordSshConsent,
  remotePlatformSeeded,
  remoteSshInstalled,
  seedRemotePlatform,
  sshConsentFor,
  workspaceSshFacts,
} from "./open-command.js";
import { originProjectName } from "./project-match.js";
import type { SessionStore } from "./session-store.js";
import type { SetupSessions } from "./setup-session.js";
import type { MendNode, MendTreeProvider } from "./tree.js";
import type { WindowRole } from "./window-role.js";
import { runWorkspaceSshSetup, workspaceSshReadiness } from "./workspace-ssh.js";

/**
 * The window's repository when its origin matches no adopted project, as New session decides it:
 * a folder name never makes a repository adopted.
 */
const adoptable = (
  store: SessionStore,
): { readonly name: string; readonly origin: string } | null => {
  const unmatched = store.unmatchedRepository();
  return unmatched === null || unmatched.originUrl === null || unmatched.candidates.length > 0
    ? null
    : { name: originProjectName(unmatched.originUrl), origin: unmatched.originUrl };
};

/** The connected account, as the Accounts menu lists it. */
export interface MendAccount {
  readonly url: string;
  readonly token: string;
  readonly email: string | null;
}

const words = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : "Mend could not do that.";

/** The signed-in account's email, as Mend says it; null when it cannot be read. */
const readEmail = async (connection: {
  readonly url: string;
  readonly token: string;
}): Promise<string | null> => {
  try {
    const [organization, members] = await Promise.all([
      requestMend(connection, "/organization"),
      requestMend(connection, "/organization/members"),
    ]);
    return accountEmail(organization, members);
  } catch {
    return null;
  }
};

/** An offer's one row: what acts on the facts the view's message says. */
export interface OfferRow {
  readonly kind: "offer";
  readonly action: Offer["action"];
}

export const isOfferRow = (node: MendNode | OfferRow): node is OfferRow => node.kind === "offer";

const OFFER_ICONS: Readonly<Record<string, string>> = {
  "mend.useCli": "account",
  "mend.adoptHere": "repo-clone",
};

/**
 * The Mend view's tree: the sessions tree, or an offer's one row (`offerOf`). While VS Code draws
 * a welcome the sessions tree is held empty by its caller.
 */
export class FirstRunTree
  implements vscode.TreeDataProvider<MendNode | OfferRow>, vscode.Disposable
{
  readonly #changed = new vscode.EventEmitter<Array<MendNode | OfferRow> | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #row: OfferRow | null = null;
  readonly #forwarding: vscode.Disposable;

  constructor(private readonly sessions: MendTreeProvider) {
    this.#forwarding = sessions.onDidChangeTreeData((nodes) => {
      if (this.#row === null) this.#changed.fire(nodes);
    });
  }

  dispose(): void {
    this.#forwarding.dispose();
    this.#changed.dispose();
  }

  /** An offer's row in place of the sessions tree; null hands the view back to it. */
  show(offer: Offer | null): void {
    const row: OfferRow | null = offer === null ? null : { kind: "offer", action: offer.action };
    if (JSON.stringify(row) === JSON.stringify(this.#row)) return;
    this.#row = row;
    this.#changed.fire(undefined);
  }

  getTreeItem(element: MendNode | OfferRow): vscode.TreeItem {
    if (!isOfferRow(element)) return this.sessions.getTreeItem(element);
    const { label, command, tooltip } = element.action;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `offer:${command}`;
    item.command = { command, title: label };
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(OFFER_ICONS[command] ?? "arrow-right");
    return item;
  }

  getChildren(element?: MendNode | OfferRow): Array<MendNode | OfferRow> {
    if (this.#row !== null) return element === undefined ? [this.#row] : [];
    return element === undefined || !isOfferRow(element) ? this.sessions.getChildren(element) : [];
  }

  resolveTreeItem(
    item: vscode.TreeItem,
    element: MendNode | OfferRow,
  ): vscode.TreeItem | Promise<vscode.TreeItem> {
    return isOfferRow(element) ? item : this.sessions.resolveTreeItem(item, element);
  }
}

/**
 * Story h in the Mend view: reads what first run decides on (the sign-in, the CLI's, workspace SSH,
 * the window's repository) and decides the view's mode: a welcome VS Code draws (the context key
 * `mend.welcome` picks its words), an offer (`offerOf`), or the sessions tree. It runs the steps'
 * buttons.
 */
export class FirstRunView implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  /** The view's mode or the connection moved. */
  readonly onDidChange = this.#changed.event;
  #connection: Connection | null = null;
  #offer: CliOffer | null = null;
  #email: string | null = null;
  #ssh: SshFacts | null = null;
  #state: FirstRun | null = null;
  #mode: ViewMode = { kind: "blank" };
  #drawn = "";
  /** Bumped per refresh: a read begun before a newer one is dropped when it lands. */
  #generation = 0;

  constructor(
    private readonly deps: {
      readonly context: vscode.ExtensionContext;
      readonly connections: ConnectionStore;
      readonly client: MendClient;
      readonly store: SessionStore;
      readonly role: WindowRole;
      readonly setupSessions: SetupSessions;
    },
  ) {}

  dispose(): void {
    this.#changed.dispose();
  }

  mode(): ViewMode {
    return this.#mode;
  }

  /** The server and token the store reads with; null when not connected. */
  connected(): { readonly url: string; readonly token: string } | null {
    return this.#connection?.kind === "connected" ? this.#connection : null;
  }

  account(): MendAccount | null {
    const connected = this.connected();
    return connected === null ? null : { ...connected, email: this.#email };
  }

  /** Reads again what first run decides on: after a sign-in or out, a setting, or a Set up. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const connection = await this.deps.connections.state();
    let offer: CliOffer | null = null;
    let email: string | null = null;
    let ssh: SshFacts | null = null;
    if (connection.kind === "notConnected") {
      const cli = connection.cli;
      const cliEmail = cli === null ? null : await readEmail(cli);
      offer = cli === null || cliEmail === null ? null : { url: cli.url, email: cliEmail };
    } else {
      [email, ssh] = await Promise.all([
        this.deps.connections
          .signedInEmail(connection.url)
          .then((kept) => kept ?? readEmail(connection)),
        this.deps.role.kind === "workspace" ? null : this.#readSsh(),
      ]);
    }
    if (generation !== this.#generation) return;
    this.#connection = connection;
    this.#offer = offer;
    this.#email = email;
    this.#ssh = ssh;
    this.render();
  }

  /** What the store read moved: only the project step depends on it. */
  render(): void {
    const connection = this.#connection;
    if (connection === null) return;
    const { store } = this.deps;
    const state = firstRun({
      connection,
      offer: this.#offer,
      ssh: this.#ssh,
      consent:
        connection.kind === "connected"
          ? sshConsentFor(this.deps.context, connection.url)
          : "never",
      project: projectMatch({
        read: store.hasRead(),
        projects: store.details().length,
        unmatched: adoptable(store),
      }),
      workspaceWindow: this.deps.role.kind === "workspace",
    });
    const mode = viewMode(state);
    const welcome = mode.kind === "welcome" ? mode.welcome : null;
    const drawn = JSON.stringify([mode, connection.kind === "connected" ? connection : null]);
    this.#state = state;
    this.#mode = mode;
    void vscode.commands.executeCommand("setContext", "mend.welcome", welcome?.kind ?? "none");
    if (drawn === this.#drawn) return;
    this.#drawn = drawn;
    this.#changed.fire();
  }

  async #readSsh(): Promise<SshFacts> {
    try {
      return (await this.#sshTarget()).facts;
    } catch {
      return { kind: "unavailable" };
    }
  }

  async #sshTarget(): Promise<{
    readonly target: WorkspaceSshTarget;
    readonly facts: Extract<SshFacts, { readonly kind: "read" }>;
  }> {
    const { view, target } = await workspaceSshFacts(this.deps.client);
    return {
      target,
      facts: {
        kind: "read",
        remoteSsh: remoteSshInstalled(),
        workspaceSsh: workspaceSshReadiness(view, target).ready,
        platform: remotePlatformSeeded(target.alias),
      },
    };
  }

  /** Use it (h1): the CLI's sign-in; no URL, no browser, no toast. */
  async useCli(): Promise<void> {
    const state = this.#state;
    if (state?.kind !== "notConnected" || state.offer === null) return;
    await useCliOffer(state.offer, this.deps.connections.effects());
    await this.refresh();
  }

  /**
   * Set up (h3), the only consent in the product: installs Remote-SSH if it is missing, registers
   * this machine's key, writes one Host block, seeds Remote-SSH's platform, and records the consent
   * so no Open asks again. One progress notification names what it does; a failure says why once.
   */
  async setUp(): Promise<void> {
    const { client, context } = this.deps;
    const server = this.connected()?.url;
    if (server === undefined) return;
    try {
      const { target, facts } = await this.#sshTarget();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: setUpTitle(missingSteps(facts)),
        },
        () =>
          runSetUp(facts, {
            installRemoteSsh,
            workspaceSsh: () =>
              runWorkspaceSshSetup(target, (publicKey, name) =>
                client.ensureWorkspaceSshKey(publicKey, name),
              ),
            seedPlatform: () => seedRemotePlatform(target.alias),
            recordConsent: (consent) => recordSshConsent(context, server, consent),
          }),
      );
    } catch (cause) {
      await this.refresh();
      if (await showErrorToast(cause, words(cause), TRY_AGAIN)) await this.setUp();
      return;
    }
    await this.refresh();
  }

  /** Skipping Set up: everything but Open works, and Open asks its one question later. */
  async skipSetUp(): Promise<void> {
    const server = this.connected()?.url;
    if (server === undefined) return;
    await recordSshConsent(this.deps.context, server, "skipped");
    this.render();
  }

  /** Adopt (h4): this window's repository, by its origin, in one click. */
  async adoptHere(): Promise<void> {
    const repository = adoptable(this.deps.store);
    if (repository === null) return;
    const { name, origin } = repository;
    try {
      const project = await vscode.window.withProgress(
        { location: { viewId: "mend.sessions" } },
        () => this.deps.client.adoptProject(name, origin),
      );
      this.deps.store.refresh();
      await this.deps.setupSessions
        .offer(project)
        .catch((cause: unknown) =>
          showErrorToast(cause, `Mend could not start the setup session · ${words(cause)}`),
        );
    } catch (cause) {
      if (await showErrorToast(cause, `Mend could not adopt ${name} · ${words(cause)}`, TRY_AGAIN))
        await this.adoptHere();
    }
  }
}
