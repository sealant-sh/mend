import { setTimeout as wait } from "node:timers/promises";

import { parseWorkspaceSshTarget, type WorkspaceSshTarget } from "@mend/workspace-ssh";
import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { openConsent, parseSshConsent } from "./first-run.js";
import { statusText, type OpenAction, type OpenState } from "./open-flow.js";
import type { OpenIntents } from "./open-intent.js";
import { OpenRunner, type OpenEffects } from "./open-runner.js";
import type { NotYoursOffer, RowCapability } from "./session-capability.js";
import type { SessionNode } from "./tree.js";
import type { Session, WorkspaceSshView } from "./types.js";
import { windowRole } from "./window-role.js";
import { runWorkspaceSshSetup, workspaceSshReadiness } from "./workspace-ssh.js";
import type { WorkspaceWindow } from "./workspace-window.js";

const REMOTE_SSH = "ms-vscode-remote.remote-ssh";
const REMOTE_SSH_INSTALL_MS = 60_000;
/** The consent record (`SshConsent`): given by Set up or by Open's one question, or skipped. */
export const CONSENT_KEY = "mend.workspaceSsh.consent";

export const remoteSshInstalled = (): boolean =>
  vscode.extensions.getExtension(REMOTE_SSH) !== undefined;

/** Installs Remote-SSH from the gallery; resolves once it is present and active. */
export const installRemoteSsh = async (): Promise<void> => {
  await vscode.commands.executeCommand("workbench.extensions.installExtension", REMOTE_SSH);
  const deadline = Date.now() + REMOTE_SSH_INSTALL_MS;
  let extension = vscode.extensions.getExtension(REMOTE_SSH);
  while (extension === undefined) {
    if (Date.now() >= deadline) throw new Error("Remote-SSH did not finish installing in 60 s.");
    await wait(500);
    extension = vscode.extensions.getExtension(REMOTE_SSH);
  }
  await extension.activate();
};

/**
 * The Remote-SSH authority of one workspace through the gateway: the authority the workspace
 * folder carries inside that window.
 */
const remoteAuthority = (
  destination: { readonly host: string; readonly usernamePrefix: string },
  workspaceId: string,
): string => `ssh-remote+${destination.usernamePrefix}-${workspaceId}@${destination.host}`;

interface WorkspaceSshFacts {
  readonly view: WorkspaceSshView;
  readonly target: WorkspaceSshTarget;
  readonly usernamePrefix: string;
}

/** This client's workspace SSH target for the configured Mend server. */
export const workspaceSshFacts = async (client: MendClient): Promise<WorkspaceSshFacts> => {
  const view = await client.workspaceSsh();
  if (view.gateway === null) {
    throw new Error("This Mend deployment exposes no workspace SSH gateway.");
  }
  const connection = await client.connection();
  const parsed = parseWorkspaceSshTarget({
    serverUrl: connection.url,
    publishedPort: view.gateway.port,
    hostnameOverride:
      vscode.workspace.getConfiguration("mend").get<string>("workspaceSshHost")?.trim() ?? "",
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { view, target: parsed.value, usernamePrefix: view.gateway.usernamePrefix };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const remotePlatforms = (): Record<string, unknown> => {
  const current = vscode.workspace.getConfiguration("remote.SSH").get<unknown>("remotePlatform");
  return isRecord(current) ? current : {};
};

export const remotePlatformSeeded = (alias: string): boolean =>
  remotePlatforms()[alias] !== undefined;

/** Remote-SSH asks for a host's platform on first connect unless it is already set. */
export const seedRemotePlatform = async (alias: string): Promise<void> => {
  const config = vscode.workspace.getConfiguration("remote.SSH");
  const platforms = remotePlatforms();
  if (platforms[alias] !== undefined) return;
  await config.update(
    "remotePlatform",
    { ...platforms, [alias]: "linux" },
    vscode.ConfigurationTarget.Global,
  );
};

/**
 * Register this machine's key, write the server's Host block, record consent and seed the
 * platform: everything an open needs from workspace SSH.
 */
export const setUpWorkspaceSsh = async (
  context: vscode.ExtensionContext,
  client: MendClient,
): Promise<void> => {
  const { target } = await workspaceSshFacts(client);
  await runWorkspaceSshSetup(target, (publicKey, name) =>
    client.ensureWorkspaceSshKey(publicKey, name),
  );
  await context.globalState.update(CONSENT_KEY, "given");
  await seedRemotePlatform(target.alias);
};

/** One status bar item for opens in flight, ticking once a second; hidden when none runs. */
class OpenProgress implements vscode.Disposable {
  readonly #item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 31);
  readonly #runs = new Map<string, { readonly name: string; readonly state: OpenState }>();
  #ticker: NodeJS.Timeout | null = null;

  constructor() {
    this.#item.name = "Mend: opening a session";
  }

  dispose(): void {
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#item.dispose();
  }

  render(sessionId: string, name: string, state: OpenState): void {
    if (state.kind === "idle" || state.kind === "done" || state.kind === "failed") {
      this.#runs.delete(sessionId);
    } else {
      this.#runs.set(sessionId, { name, state });
    }
    if (this.#runs.size === 0 && this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    } else if (this.#runs.size > 0 && this.#ticker === null) {
      this.#ticker = setInterval(() => this.#paint(), 1000);
    }
    this.#paint();
  }

  focus(): void {
    this.#paint();
  }

  #paint(): void {
    const now = Date.now();
    const text = [...this.#runs.values()]
      .map((run) => statusText(run.state, run.name, now))
      .findLast((line) => line !== null);
    if (text === undefined || text === null) {
      this.#item.hide();
      return;
    }
    this.#item.text = `$(sync~spin) ${text}`;
    this.#item.show();
  }
}

/** The command each refused open offers instead, run on the session's row node. */
export const OFFER_COMMANDS: Readonly<Record<NotYoursOffer, string>> = {
  "Watch terminal": "mend.watchTerminal",
  Review: "mend.reviewChange",
};

/** The open runner over VS Code and Mend. */
export const openRunner = (deps: {
  readonly context: vscode.ExtensionContext;
  readonly client: MendClient;
  readonly workspaceWindow: WorkspaceWindow;
  readonly intents: OpenIntents;
  readonly capability: (session: Session) => Promise<RowCapability>;
}): { readonly runner: OpenRunner; readonly disposable: vscode.Disposable } => {
  const { context, client, workspaceWindow } = deps;
  const progress = new OpenProgress();
  const effects: OpenEffects = {
    capability: deps.capability,
    refuse: (target, why, offer) =>
      void (async () => {
        if ((await vscode.window.showInformationMessage(why, offer)) !== offer) return;
        await vscode.commands.executeCommand(OFFER_COMMANDS[offer], {
          kind: "session",
          project: target.project,
          session: target.session,
        } satisfies SessionNode);
      })(),
    now: () => Date.now(),
    sleep: (ms) => wait(ms),
    thisWindow: () =>
      windowRole(
        vscode.env.remoteName,
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.authority),
      ),
    focusAgentTerminal: (sessionId) => workspaceWindow.focusAgentTerminal(sessionId),
    focusProgress: () => progress.focus(),
    remoteSshInstalled,
    installRemoteSsh,
    workspaceSsh: async () => {
      const { view, target } = await workspaceSshFacts(client);
      return workspaceSshReadiness(view, target).ready ? "ready" : "needsSetup";
    },
    sshConsent: () => openConsent(parseSshConsent(context.globalState.get(CONSENT_KEY))),
    askSshConsent: async () =>
      (await vscode.window.showInformationMessage(
        "Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)",
        { modal: true },
        "Set up",
      )) === "Set up",
    setUpWorkspaceSsh: () => setUpWorkspaceSsh(context, client),
    seedRemotePlatform: async () =>
      seedRemotePlatform((await workspaceSshFacts(client)).target.alias),
    resume: async (sessionId) => {
      await client.resumeSession(sessionId, "shell");
    },
    sessionNow: async (sessionId) => (await client.sessionDetail(sessionId)).session,
    openFolder: async ({ workspaceId, sessionId }, options) => {
      const { target, usernamePrefix } = await workspaceSshFacts(client);
      await deps.intents.write({ workspaceId, sessionId });
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.from({
          scheme: "vscode-remote",
          authority: remoteAuthority({ host: target.alias, usernamePrefix }, workspaceId),
          path: "/workspace/repo",
        }),
        options,
      );
    },
    render: (sessionId, name, state) => progress.render(sessionId, name, state),
    report: async (_sessionId, reason, action) => {
      const answer = await (action === null
        ? vscode.window.showErrorMessage(reason)
        : vscode.window.showErrorMessage(reason, action));
      const actions: ReadonlyArray<OpenAction> = ["Retry", "Set up"];
      return actions.find((candidate) => candidate === answer);
    },
  };
  return { runner: new OpenRunner(effects), disposable: progress };
};
