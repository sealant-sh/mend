import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  canonicalServerUrl,
  credentialFor,
  parseCredentialStore,
  serializeCredentialStore,
  signOutOf,
  tokenFor,
  withCredential,
  withoutCredential,
  type CliCredential,
  type CredentialStore,
} from "./credentials.js";
import {
  connectionOf,
  runConnect,
  TRY_AGAIN,
  type Connection,
  type ConnectEffects,
  type SignInOutcome,
} from "./first-run.js";
import { requestMend } from "./mend-http.js";
import { browserSignIn, finishBrowserSignIn, normalizeServerUrl, urlNotice } from "./sign-in.js";

export interface MendConnection {
  readonly url: string;
  readonly token: string | null;
}

const TOKEN_KEY = "mend.serverToken";

const mendHome = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const preferred = path.join(
    xdg === undefined || xdg === "" ? path.join(os.homedir(), ".config") : xdg,
    "mend",
  );
  const legacy = path.join(os.homedir(), ".mend");
  return fs.existsSync(legacy) && !fs.existsSync(preferred) ? legacy : preferred;
};

const cliConfig = (): CliCredential | null => {
  const file = path.join(mendHome(), "cli.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const url = Reflect.get(parsed, "url");
    const token = Reflect.get(parsed, "token");
    if (typeof url !== "string" || url.trim() === "") return null;
    return {
      url: canonicalServerUrl(url),
      token: typeof token === "string" && token !== "" ? token : null,
    };
  } catch {
    return null;
  }
};

const configuredUrl = (): string | null => {
  const configured = vscode.workspace.getConfiguration("mend").get<string>("serverUrl")?.trim();
  return configured === undefined || configured === "" ? null : canonicalServerUrl(configured);
};

/** One connection shared by the tree, status item, URI handler, and commands. */
export class ConnectionStore {
  constructor(
    private readonly context: { readonly secrets: Pick<vscode.SecretStorage, "get" | "store"> },
  ) {}

  async get(): Promise<MendConnection> {
    const discovered = cliConfig();
    // Every spelling of a server is one server: the setting, the CLI's URL and the stored entries
    // all compare in the canonical form Connect writes.
    const url = configuredUrl() ?? discovered?.url ?? "http://localhost:3105";
    return { url, token: tokenFor(url, credentialFor(await this.#stored(), url), discovered) };
  }

  /** Whether the editor is connected, and from where; what Connect and Use it start from if not. */
  async state(): Promise<Connection> {
    const configured = configuredUrl();
    return connectionOf({
      configured,
      own: configured === null ? null : credentialFor(await this.#stored(), configured),
      cli: cliConfig(),
    });
  }

  /** The account this editor's own sign-in to `url` approved, when it kept one. */
  async signedInEmail(url: string): Promise<string | null> {
    const own = credentialFor(await this.#stored(), url);
    return own?.kind === "token" ? (own.email ?? null) : null;
  }

  async #stored(): Promise<CredentialStore> {
    return parseCredentialStore(await this.context.secrets.get(TOKEN_KEY));
  }

  /** The token first: changing the setting restarts the event stream, which reads it. */
  async #point(url: string, store: CredentialStore): Promise<void> {
    await this.context.secrets.store(TOKEN_KEY, serializeCredentialStore(store));
    await vscode.workspace
      .getConfiguration("mend")
      .update("serverUrl", url, vscode.ConfigurationTarget.Global);
  }

  /** The effects Connect and Use it run on (story h). */
  effects(): ConnectEffects {
    return {
      askUrl: async (prefill) => {
        const typed = await vscode.window.showInputBox({
          title: "Connect to your Mend server",
          prompt: "Mend server URL, as this machine reaches it",
          placeHolder: "http://mend-mini.local:3105",
          value: prefill ?? "",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const notice = urlNotice(value);
            return notice === null
              ? null
              : {
                  message: notice.message,
                  severity:
                    notice.severity === "error"
                      ? vscode.InputBoxValidationSeverity.Error
                      : vscode.InputBoxValidationSeverity.Warning,
                };
          },
        });
        return typed === undefined ? undefined : (normalizeServerUrl(typed) ?? undefined);
      },
      signIn: (url) => this.#browserSignIn(url),
      toast: (message) => void vscode.window.showInformationMessage(message),
      fail: async (reason) =>
        (await vscode.window.showErrorMessage(reason, TRY_AGAIN)) === TRY_AGAIN
          ? TRY_AGAIN
          : undefined,
      useCliSignIn: async (url) => this.#point(url, withoutCredential(await this.#stored(), url)),
    };
  }

  /** Connect: the server URL, Mend's approve page in the browser, one toast. */
  async connect(): Promise<boolean> {
    const state = await this.state();
    return runConnect(state.kind === "notConnected" ? state.prefill : state.url, this.effects());
  }

  /**
   * The browser walk under one cancellable progress notification. The status bar keeps the code
   * for the whole walk, and a click on it opens the approve page again: VS Code's "open the
   * external website?" dialog can hide behind other windows, and the notification hides itself
   * after a while (RC 0.36.0-next.768, a MacBook).
   */
  async #browserSignIn(url: string): Promise<SignInOutcome> {
    const reminder = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 31);
    reminder.name = "Mend sign-in";
    let reopen: vscode.Disposable | undefined;
    let cancellation: vscode.CancellationToken | null = null;
    const completion = {
      fetch,
      deviceName: `VS Code on ${os.hostname()}`,
      cancelled: () => cancellation?.isCancellationRequested === true,
      onWarning: (message: string) => {
        void vscode.window.showWarningMessage(message);
      },
    };
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        (progress, token) => {
          cancellation = token;
          progress.report({ message: `Asking ${new URL(url).host} for a sign-in code` });
          return browserSignIn(url, {
            ...completion,
            openExternal: (page) =>
              Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(page))),
            onCode: (code, page) => {
              progress.report({ message: `Approve in the browser if it shows ${code}` });
              reopen?.dispose();
              reopen = vscode.commands.registerCommand(
                "mend.signInReminder",
                () => void vscode.env.openExternal(vscode.Uri.parse(page)),
              );
              reminder.text = `$(key) Mend sign-in · ${code}`;
              reminder.tooltip = `Approve at ${page} if it shows ${code}. Click to open the page again.`;
              reminder.command = "mend.signInReminder";
              reminder.show();
            },
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          });
        },
      );
      const signedIn = await finishBrowserSignIn(result, completion);
      if (signedIn === null) return { kind: "cancelled" };
      await this.#point(
        url,
        withCredential(await this.#stored(), {
          kind: "token",
          url,
          token: signedIn.token,
          deviceId: signedIn.deviceId,
          email: signedIn.email,
        }),
      );
      return { kind: "signedIn", email: signedIn.email };
    } catch (cause) {
      return {
        kind: "failed",
        reason: cause instanceof Error ? cause.message : "Mend sign-in failed.",
      };
    } finally {
      reminder.dispose();
      reopen?.dispose();
    }
  }

  /**
   * Sign this editor out of the server it is connected to now, and only that one: its own entry for
   * that URL is revoked (a browser sign-in's device) and replaced by "no token", so the editor does
   * not fall back to the CLI's sign-in there. Entries for other servers stay as they were.
   */
  async signOut(): Promise<string> {
    const current = await this.get();
    const { own, next } = signOutOf(current.url, await this.#stored());
    if (own === null && current.token === null) {
      return `This editor holds no Mend sign-in for ${current.url}.`;
    }
    let revoked = false;
    if (own !== null && own.deviceId !== null) {
      try {
        await requestMend(own, `/me/devices/${encodeURIComponent(own.deviceId)}`, {
          method: "DELETE",
        });
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    await this.context.secrets.store(TOKEN_KEY, serializeCredentialStore(next));
    if (own === null) {
      return `Signed out of Mend at ${current.url} in this editor. The Mend CLI on this machine keeps its own sign-in; mend logout ends it.`;
    }
    if (own.deviceId === null) {
      return `Signed out of Mend at ${current.url}. The pasted token stays valid until it is revoked under Settings → Devices.`;
    }
    return revoked
      ? `Signed out of Mend at ${current.url}, and revoked this editor's device.`
      : `Signed out of Mend at ${current.url}; Mend could not be reached to revoke this editor's device. Revoke it under Settings → Devices.`;
  }
}
