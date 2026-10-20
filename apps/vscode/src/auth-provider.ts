import * as vscode from "vscode";

import type { MendAccount } from "./first-run-view.js";

export const AUTH_PROVIDER_ID = "mend";

/** `dana@example.com @ mend-mini.local`; the server alone while Mend cannot name the account. */
export const accountLabel = (account: Pick<MendAccount, "url" | "email">): string => {
  let host = account.url;
  try {
    host = new URL(account.url).hostname;
  } catch {
    // A connected URL always parses; the raw form is only a fallback.
  }
  return account.email === null ? host : `${account.email} @ ${host}`;
};

const sessionOf = (account: MendAccount): vscode.AuthenticationSession => ({
  id: account.url,
  accessToken: account.token,
  account: { id: `${account.url}#${account.email ?? ""}`, label: accountLabel(account) },
  scopes: [],
});

/**
 * Mend in VS Code's Accounts menu, beside her GitHub account (story h2). One session: the server
 * this editor is connected to. Signing out there signs this editor out as `Mend: Sign out` does,
 * revoking its device.
 */
export class MendAuthenticationProvider
  implements vscode.AuthenticationProvider, vscode.Disposable
{
  readonly #changed =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.#changed.event;
  #shown: vscode.AuthenticationSession | null = null;

  constructor(
    private readonly deps: {
      readonly account: () => MendAccount | null;
      /** Connect; true once signed in. */
      readonly signIn: () => Promise<boolean>;
      /** Signs this editor out of one server, by its URL. */
      readonly signOut: (url: string) => Promise<void>;
    },
  ) {}

  dispose(): void {
    this.#changed.dispose();
  }

  async getSessions(): Promise<Array<vscode.AuthenticationSession>> {
    const account = this.deps.account();
    return account === null ? [] : [sessionOf(account)];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const account = (await this.deps.signIn()) ? this.deps.account() : null;
    if (account === null) throw new Error("Mend sign-in did not finish.");
    return sessionOf(account);
  }

  /** A session's id is its server's URL: removing it signs out of that server, and only it. */
  async removeSession(sessionId: string): Promise<void> {
    await this.deps.signOut(sessionId);
  }

  /** The connection moved: tell VS Code what the Accounts menu now holds. */
  changed(): void {
    const account = this.deps.account();
    const next = account === null ? null : sessionOf(account);
    const prev = this.#shown;
    this.#shown = next;
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    const same = prev !== null && next !== null && prev.id === next.id;
    this.#changed.fire({
      added: next !== null && !same ? [next] : [],
      removed: prev !== null && !same ? [prev] : [],
      changed: same && next !== null ? [next] : [],
    });
  }
}
