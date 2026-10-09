import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { requestMend } from "./mend-http.js";
import { browserSignIn, normalizeServerUrl, plainHttpWarning, type SignedIn } from "./sign-in.js";

export interface MendConnection {
  readonly url: string;
  readonly token: string | null;
}

const TOKEN_KEY = "mend.serverToken";

interface StoredToken {
  readonly url: string;
  readonly token: string;
  /** The device a browser sign-in created; sign-out revokes it. Absent for a pasted token. */
  readonly deviceId: string | null;
}

const storedToken = (value: string | undefined): StoredToken | null => {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const url = Reflect.get(parsed, "url");
    const token = Reflect.get(parsed, "token");
    const deviceId = Reflect.get(parsed, "deviceId");
    return typeof url === "string" && typeof token === "string"
      ? { url, token, deviceId: typeof deviceId === "string" ? deviceId : null }
      : null;
  } catch {
    return null;
  }
};

interface ConnectPick extends vscode.QuickPickItem {
  readonly method: "browser" | "token" | "none";
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

const cliConfig = (): MendConnection | null => {
  const file = path.join(mendHome(), "cli.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const url = Reflect.get(parsed, "url");
    const token = Reflect.get(parsed, "token");
    if (typeof url !== "string" || url.trim() === "") return null;
    return {
      url: url.replace(/\/$/, ""),
      token: typeof token === "string" && token !== "" ? token : null,
    };
  } catch {
    return null;
  }
};

/** One connection shared by the tree, status item, URI handler, and commands. */
export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async get(): Promise<MendConnection> {
    const configured = vscode.workspace.getConfiguration("mend").get<string>("serverUrl")?.trim();
    const discovered = cliConfig();
    const url = (
      (configured === undefined || configured === "" ? discovered?.url : configured) ??
      "http://localhost:3105"
    ).replace(/\/$/, "");
    const secret = storedToken(await this.context.secrets.get(TOKEN_KEY));
    const token =
      secret?.url === url ? secret.token : url === discovered?.url ? discovered.token : null;
    return { url, token };
  }

  /**
   * Point the editor at a server and sign in: through the browser by default (the `mend login`
   * walk), with a pasted device token, or with none for a local server that needs none.
   */
  async configure(): Promise<boolean> {
    const current = await this.get();
    const typed = await vscode.window.showInputBox({
      title: "Connect Mend",
      prompt: "Mend server URL, as this machine reaches it (http://mend-mini.local:3105)",
      value: current.url,
      ignoreFocusOut: true,
      validateInput: (value) =>
        normalizeServerUrl(value) === null ? "Enter an http or https URL, or host:port." : null,
    });
    if (typed === undefined) return false;
    const url = normalizeServerUrl(typed);
    if (url === null) return false;
    const method = await vscode.window.showQuickPick<ConnectPick>(
      [
        {
          label: "$(globe) Sign in with the browser",
          detail: `Opens ${url}/authorize. Approve there when it shows the same code.`,
          method: "browser",
        },
        {
          label: "$(key) Paste a device token",
          detail: "A token minted in Mend under Settings → Devices.",
          method: "token",
        },
        {
          label: "$(circle-slash) No token",
          detail: "For a local server that does not require one.",
          method: "none",
        },
      ],
      {
        title: `Connect Mend · ${url}`,
        placeHolder: plainHttpWarning(url) ?? "How this editor signs in",
        ignoreFocusOut: true,
      },
    );
    if (method === undefined) return false;
    let stored: StoredToken | null;
    if (method.method === "browser") {
      const signedIn = await this.browserSignIn(url);
      if (signedIn === null) return false;
      stored = { url, token: signedIn.token, deviceId: signedIn.deviceId };
      void vscode.window.showInformationMessage(
        `Signed in to Mend at ${url} as ${signedIn.email}. Revoke this editor under Settings → Devices.`,
      );
    } else if (method.method === "token") {
      const token = await vscode.window.showInputBox({
        title: `Connect Mend · ${url}`,
        prompt: "Device token",
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined || token.trim() === "") return false;
      stored = { url, token: token.trim(), deviceId: null };
    } else {
      stored = null;
    }
    // The token first: changing the setting restarts the event stream, which reads it.
    if (stored === null) await this.context.secrets.delete(TOKEN_KEY);
    else await this.context.secrets.store(TOKEN_KEY, JSON.stringify(stored));
    await vscode.workspace
      .getConfiguration("mend")
      .update("serverUrl", url, vscode.ConfigurationTarget.Global);
    return true;
  }

  private async browserSignIn(url: string): Promise<SignedIn | null> {
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Mend sign-in",
          cancellable: true,
        },
        (progress, cancellation) =>
          browserSignIn(url, {
            fetch,
            openExternal: (page) =>
              Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(page))),
            onCode: (code) =>
              progress.report({
                message: `approve in the browser if it shows ${code}`,
              }),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            deviceName: `VS Code on ${os.hostname()}`,
            cancelled: () => cancellation.isCancellationRequested,
          }),
      );
    } catch (cause) {
      void vscode.window.showErrorMessage(
        cause instanceof Error ? cause.message : "Mend sign-in failed.",
      );
      return null;
    }
  }

  /**
   * Forget this editor's token. A browser sign-in's device is revoked on the server first, so the
   * token stops working everywhere, not only here.
   */
  async signOut(): Promise<string> {
    const stored = storedToken(await this.context.secrets.get(TOKEN_KEY));
    if (stored === null) return "This editor holds no Mend token of its own.";
    let revoked = false;
    if (stored.deviceId !== null) {
      try {
        await requestMend(stored, `/me/devices/${encodeURIComponent(stored.deviceId)}`, {
          method: "DELETE",
        });
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    await this.context.secrets.delete(TOKEN_KEY);
    return revoked || stored.deviceId === null
      ? `Signed out of Mend at ${stored.url}.`
      : `Forgot the token for ${stored.url}; Mend could not be reached to revoke it. Revoke it under Settings → Devices.`;
  }
}
