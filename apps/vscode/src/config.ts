import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  canonicalServerUrl,
  isRefused,
  keptCredential,
  replacedDeviceWarning,
  revokeOutcomeOf,
  secretWriteOf,
  signOutMessage,
  tokenFor,
  type CliCredential,
  type CredentialChange,
  type RevokeOutcome,
  type StoredCredential,
} from "./credentials.js";
import {
  connectionOf,
  runConnect,
  TRY_AGAIN,
  type Connection,
  type ConnectEffects,
  type SignInOutcome,
} from "./first-run.js";
import { MendApiError, REQUEST_TIMEOUT_MS, requestMend } from "./mend-http.js";
import { browserSignIn, finishBrowserSignIn, normalizeServerUrl, urlNotice } from "./sign-in.js";

export interface MendConnection {
  readonly url: string;
  readonly token: string | null;
}

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

/** A browser sign-in's device, which signing out or signing in again revokes. */
interface Device {
  readonly url: string;
  readonly token: string;
  readonly deviceId: string;
}

/** `DELETE /me/devices/:id` with the device's own token, bounded like a read: a sign-out waits on it. */
const revokeDevice = async (device: Device): Promise<RevokeOutcome> => {
  try {
    await requestMend(device, `/me/devices/${encodeURIComponent(device.deviceId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { kind: "revoked" };
  } catch (cause) {
    return revokeOutcomeOf(cause instanceof MendApiError ? cause.status : null);
  }
};

const configuredUrl = (): string | null => {
  const configured = vscode.workspace.getConfiguration("mend").get<string>("serverUrl")?.trim();
  return configured === undefined || configured === "" ? null : canonicalServerUrl(configured);
};

/** One connection shared by the tree, status item, URI handler, and commands. */
export class ConnectionStore {
  /** The Connect running now: a second one joins it instead of opening another sign-in request. */
  #connecting: Promise<boolean> | null = null;
  /** The device a sign-in just replaced, revoked once the editor reads with the new token. */
  #replaced: Device | null = null;

  constructor(
    private readonly context: { readonly secrets: Pick<vscode.SecretStorage, "get" | "store"> },
  ) {}

  async get(): Promise<MendConnection> {
    const discovered = cliConfig();
    // Every spelling of a server is one server: the setting, the CLI's URL and the stored entries
    // all compare in the canonical form Connect writes.
    const url = configuredUrl() ?? discovered?.url ?? "http://localhost:3105";
    return { url, token: tokenFor(url, await this.#own(url, discovered), discovered) };
  }

  /** Whether the editor is connected, and from where; what Connect and Use it start from if not. */
  async state(): Promise<Connection> {
    const configured = configuredUrl();
    const cli = cliConfig();
    return connectionOf({
      configured,
      own: configured === null ? null : await this.#own(configured, cli),
      cli,
    });
  }

  /** The account this editor's own sign-in to `url` approved, when it kept one. */
  async signedInEmail(url: string): Promise<string | null> {
    const own = await this.#own(url, cliConfig());
    return own?.kind === "token" ? (own.email ?? null) : null;
  }

  #read = async (key: string): Promise<string | undefined> => this.context.secrets.get(key);

  #own(url: string, cli: CliCredential | null): Promise<StoredCredential | null> {
    return keptCredential(this.#read, url, cli);
  }

  /** Every write of the editor's credentials: one secret, from the change alone. */
  async #write(change: CredentialChange): Promise<void> {
    const { key, value } = secretWriteOf(change, randomUUID());
    await this.context.secrets.store(key, value);
  }

  /** The token first: changing the setting restarts the event stream, which reads it. */
  async #point(url: string, change: CredentialChange): Promise<void> {
    await this.#write(change);
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
      useCliSignIn: (url) => this.#point(url, { kind: "useCli", url }),
    };
  }

  /** Connect: the server URL, Mend's approve page in the browser, one toast. */
  connect(): Promise<boolean> {
    this.#connecting ??= this.state()
      .then((state) =>
        runConnect(state.kind === "notConnected" ? state.prefill : state.url, this.effects()),
      )
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  /**
   * Revokes the device the last sign-in replaced, best effort, and says once when Mend did not.
   * Called once the editor reads with the new token: a read still out on the old one would
   * otherwise come back refused and toast a sign-out.
   */
  async revokeReplaced(): Promise<void> {
    const replaced = this.#replaced;
    this.#replaced = null;
    if (replaced === null) return;
    const warning = replacedDeviceWarning(replaced.url, await revokeDevice(replaced));
    if (warning !== null) void vscode.window.showWarningMessage(warning);
  }

  /**
   * Mend refused `connection`'s token (401): the editor holds no token for that server from now
   * on, so the Accounts menu, the extensions it was shared with, and every window (through the
   * secret's change) drop it. A token the editor no longer sends is left alone.
   */
  async refused(connection: { readonly url: string; readonly token: string }): Promise<void> {
    // Requests out on one token come back refused together; one write is enough for every window.
    if (await isRefused(this.#read, connection.url, connection.token)) return;
    await this.#write({ kind: "refused", ...connection });
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
      const replaced = await this.#own(url, cliConfig());
      await this.#point(url, {
        kind: "signedIn",
        url,
        token: signedIn.token,
        deviceId: signedIn.deviceId,
        email: signedIn.email,
      });
      if (
        replaced?.kind === "token" &&
        replaced.deviceId !== null &&
        replaced.deviceId !== signedIn.deviceId
      )
        this.#replaced = { url, token: replaced.token, deviceId: replaced.deviceId };
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
   * Sign this editor out of `url` (by default the server it is connected to now), and only that
   * one: its own entry there is replaced by "no token", so the editor does not fall back to the
   * CLI's sign-in there, and then revoked (a browser sign-in's device). Other servers' entries stay
   * as they were.
   */
  async signOut(url?: string): Promise<string> {
    const server = url === undefined ? (await this.get()).url : canonicalServerUrl(url);
    const cli = cliConfig();
    const kept = await this.#own(server, cli);
    // Written before the revoke, so a sign-in another window makes while Mend answers lands after
    // it and stays; and whatever this window read, since another window's sign-in may not have
    // reached it yet.
    await this.#write({ kind: "signedOut", url: server });
    const own = kept?.kind === "token" ? kept : null;
    if (own === null && tokenFor(server, kept, cli) === null) {
      return `This editor holds no Mend sign-in for ${server}.`;
    }
    if (own === null) return signOutMessage(server, { kind: "cliFallback" });
    if (own.deviceId === null) return signOutMessage(server, { kind: "pastedToken" });
    const outcome = await revokeDevice({ url: server, token: own.token, deviceId: own.deviceId });
    return signOutMessage(server, { kind: "device", outcome });
  }
}
