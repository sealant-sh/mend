import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationProviderAuthenticationSessionsChangeEvent } from "vscode";

import { MendAuthenticationProvider } from "./auth-provider.js";
import { MendClient } from "./client.js";
import { ConnectionStore } from "./config.js";
import { keptCredential, secretWriteOf } from "./credentials.js";
import type { MendAccount } from "./first-run-view.js";

const settings = vi.hoisted(() => new Map<string, unknown>());

const ui = vi.hoisted(() => ({
  showInputBox: vi.fn(async (_options: unknown): Promise<string | undefined> => undefined),
  showInformationMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  showWarningMessage: vi.fn(async (..._: ReadonlyArray<unknown>) => undefined),
  showErrorMessage: vi.fn(
    async (..._: ReadonlyArray<unknown>): Promise<string | undefined> => undefined,
  ),
  openExternal: vi.fn(async (_uri: unknown) => true),
}));

vi.mock("vscode", async () => ({
  EventEmitter: (await import("./test-vscode.js")).EventEmitter,
  window: {
    showInputBox: ui.showInputBox,
    showInformationMessage: ui.showInformationMessage,
    showWarningMessage: ui.showWarningMessage,
    showErrorMessage: ui.showErrorMessage,
    withProgress: async (
      _options: unknown,
      task: (
        progress: { report: (value: unknown) => void },
        token: { isCancellationRequested: boolean },
      ) => Promise<unknown>,
    ) => task({ report: () => undefined }, { isCancellationRequested: false }),
    createStatusBarItem: () => ({ show: () => undefined, dispose: () => undefined }),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => settings.get(`${section}.${key}`),
      update: async (key: string, value: unknown) => {
        settings.set(`${section}.${key}`, value);
      },
    }),
  },
  commands: { registerCommand: () => ({ dispose: () => undefined }) },
  env: { openExternal: ui.openExternal },
  Uri: { parse: (value: string) => value },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
}));

const MINI = "http://mend-mini.local:3105";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Mend's device flow: one request opened, then approved (or denied) on the first poll. */
const server = (poll: Response) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/auth")) {
      return json(200, {
        deviceCode: "device-secret",
        code: "abcd2345",
        verifyPath: "/authorize?code=abcd2345",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        expiresIn: 600,
        intervalSeconds: 1,
      });
    }
    if (url.endsWith("/api/cli/auth/token")) return poll.clone();
    throw new Error(`unexpected request ${url}`);
  });

const approved = json(200, {
  status: "approved",
  token: "mdt_editor",
  user: { id: "u1", name: "Dana", email: "dana@example.com" },
  device: { id: "device-1", name: "VS Code on test" },
});

let home = "";
/** The extension's secret storage, which every window of this VS Code shares. */
const secrets = new Map<string, string>();
/** `secrets.onDidChange` in each window. */
const secretChanged = new Set<() => void>();
const store = () =>
  new ConnectionStore({
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
        for (const listener of secretChanged) listener();
      },
    },
  });

const LEGACY_KEY = "mend.serverToken";
const EDGE = "https://mend.example.com";

/** The editor signed in through the browser: one device per server, pointed at the first. */
const signedIn = (
  ...devices: ReadonlyArray<{ readonly url: string; readonly token: string; readonly id: string }>
): void => {
  for (const device of devices) {
    const { key, value } = secretWriteOf(
      {
        kind: "signedIn",
        url: device.url,
        token: device.token,
        deviceId: device.id,
        email: "dana@example.com",
      },
      randomUUID(),
    );
    secrets.set(key, value);
  }
  settings.set("mend.serverUrl", devices[0]?.url);
};

/** What every window now reads for `url`, refusals applied; the CLI holds nothing. */
const kept = (url: string) => keptCredential(async (key) => secrets.get(key), url, null);

/**
 * One VS Code window as extension.ts wires it: its connection store and client, and its Accounts
 * menu, read again on every change of the shared secret (first run's refresh).
 */
const editorWindow = () => {
  const connections = store();
  let account: MendAccount | null = null;
  const accounts = new MendAuthenticationProvider({
    account: () => account,
    signIn: () => connections.connect(),
    signOut: async (url) => {
      await connections.signOut(url);
    },
  });
  const changes: Array<AuthenticationProviderAuthenticationSessionsChangeEvent> = [];
  accounts.onDidChangeSessions((change) => changes.push(change));
  const refresh = async (): Promise<void> => {
    const state = await connections.state();
    account =
      state.kind === "connected"
        ? {
            url: state.url,
            token: state.token,
            email: await connections.signedInEmail(state.url),
          }
        : null;
    accounts.changed();
  };
  secretChanged.add(() => void refresh());
  return { connections, client: new MendClient(connections), accounts, changes, refresh };
};

/** Every request the editor sent, and Mend's answer to `DELETE /api/me/devices/:id`. */
const devicesServer = (revoke: () => Response | Promise<Response>, poll: Response = approved) => {
  const flow = server(poll);
  return vi.fn<typeof fetch>(async (input, init) =>
    String(input).includes("/api/me/devices/") && init?.method === "DELETE"
      ? revoke()
      : flow(input, init),
  );
};

const deletes = (fetcher: ReturnType<typeof devicesServer>) =>
  fetcher.mock.calls
    .filter(([, init]) => init?.method === "DELETE")
    .map(([input, init]) => [String(input), new Headers(init?.headers).get("authorization")]);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  settings.clear();
  secrets.clear();
  secretChanged.clear();
  for (const spy of Object.values(ui)) spy.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Connect, as the extension runs it (h2)", () => {
  it("asks one URL, opens the approve page, and toasts exactly once", async () => {
    vi.stubGlobal("fetch", server(approved));
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const connections = store();
    expect(await connections.connect()).toBe(true);
    expect(ui.showInputBox).toHaveBeenCalledTimes(1);
    expect(ui.openExternal.mock.calls.map(([uri]) => uri)).toEqual([
      `${MINI}/authorize?code=abcd2345`,
    ]);
    expect(ui.showInformationMessage.mock.calls).toEqual([
      ["Signed in to mend-mini.local as dana@example.com"],
    ]);
    expect(await connections.state()).toEqual({
      kind: "connected",
      url: MINI,
      token: "mdt_editor",
      source: { kind: "extension", deviceId: "device-1" },
    });
    expect(await connections.signedInEmail(MINI)).toBe("dana@example.com");
  }, 10_000);

  it("ends a denial in one error toast with Try again, and no success toast", async () => {
    vi.stubGlobal("fetch", server(json(403, {})));
    ui.showInputBox.mockResolvedValueOnce(MINI);
    expect(await store().connect()).toBe(false);
    expect(ui.showErrorMessage.mock.calls).toEqual([
      ["Sign-in denied in the browser.", "Try again"],
    ]);
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
  }, 10_000);
});

describe("Use it, as the extension runs it (h1 variant)", () => {
  it("connects on the CLI's sign-in with no URL, no browser and no toast", async () => {
    const cliDir = path.join(home, ".config", "mend");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "cli.json"),
      JSON.stringify({ url: MINI, token: "mdt_cli" }),
    );
    const connections = store();
    const before = await connections.state();
    expect(before).toEqual({
      kind: "notConnected",
      prefill: MINI,
      cli: { url: MINI, token: "mdt_cli" },
    });
    await connections.effects().useCliSignIn(MINI);
    expect(await connections.state()).toEqual({
      kind: "connected",
      url: MINI,
      token: "mdt_cli",
      source: { kind: "cli" },
    });
    expect(ui.showInputBox).not.toHaveBeenCalled();
    expect(ui.openExternal).not.toHaveBeenCalled();
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe("the Accounts menu (h2c)", () => {
  const mini = { url: MINI, token: "mdt_mini", id: "device-mini" };
  const edge = { url: EDGE, token: "mdt_edge", id: "device-edge" };

  it("drops an account Mend refused, in this window and in another one, through the secret", async () => {
    signedIn(mini);
    const here = editorWindow();
    const there = editorWindow();
    await Promise.all([here.refresh(), there.refresh()]);
    expect((await there.accounts.getSessions()).map((session) => session.account.label)).toEqual([
      "dana@example.com @ mend-mini.local",
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => json(401, { _tag: "Unauthorized" })),
    );
    await expect(here.client.listProjects()).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(async () => expect(await there.accounts.getSessions()).toEqual([]));
    expect(await here.accounts.getSessions()).toEqual([]);
    for (const window of [here, there]) {
      expect(window.changes.at(-1)).toMatchObject({ added: [], removed: [{ id: MINI }] });
    }
    expect(await kept(MINI)).toEqual({ kind: "none", url: MINI });
    expect(await there.connections.state()).toMatchObject({ kind: "notConnected" });
  });

  it("Sign Out of an account signs out of that server, and only it", async () => {
    signedIn(mini, edge);
    const fetcher = devicesServer(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const here = editorWindow();
    await here.refresh();
    await here.accounts.removeSession(EDGE);
    expect(deletes(fetcher)).toEqual([[`${EDGE}/api/me/devices/device-edge`, "Bearer mdt_edge"]]);
    expect(await here.connections.state()).toMatchObject({ kind: "connected", url: MINI });
    expect((await kept(EDGE))?.kind).toBe("none");

    await here.accounts.removeSession(MINI);
    expect(deletes(fetcher)).toHaveLength(2);
    await vi.waitFor(async () => expect(await here.accounts.getSessions()).toEqual([]));
  });
});

describe("requests refused together on one token", () => {
  it("write the refusal once, so every window hears of it once", async () => {
    signedIn({ url: MINI, token: "mdt_old", id: "device-old" });
    const writes: Array<string> = [];
    const connections = new ConnectionStore({
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => {
          writes.push(key);
          secrets.set(key, value);
        },
      },
    });
    const refused = { url: MINI, token: "mdt_old" };
    await Promise.all([
      connections.refused(refused),
      connections.refused(refused),
      connections.refused(refused),
    ]);
    expect(writes).toHaveLength(1);
    expect(await kept(MINI)).toEqual({ kind: "none", url: MINI });
  });
});

describe("a refusal and a sign-in at once (SLNT-170)", () => {
  it("keeps the sign-in written while the refusal of the token before it was being read", async () => {
    signedIn({ url: MINI, token: "mdt_old", id: "device-old" });
    const held = Promise.withResolvers<void>();
    let holding = false;
    let hold = true;
    const connections = new ConnectionStore({
      secrets: {
        get: async (key: string) => {
          const value = secrets.get(key);
          if (hold) {
            hold = false;
            holding = true;
            await held.promise;
          }
          return value;
        },
        store: async (key: string, value: string) => {
          secrets.set(key, value);
        },
      },
    });
    const fetcher = devicesServer(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const refusal = connections.refused({ url: MINI, token: "mdt_old" });
    await vi.waitFor(() => expect(holding).toBe(true));
    const signIn = connections.connect();
    await vi.waitFor(
      () =>
        expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/token"))).toBe(true),
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.resolve();
    await Promise.all([refusal, signIn]);
    expect(await kept(MINI)).toMatchObject({ kind: "token", token: "mdt_editor" });
  }, 10_000);
});

/**
 * A window whose first read of the shared secret waits until `release`: a 401 it handles reads the
 * credentials, then another window writes, then this one goes on.
 */
const pausedWindow = () => {
  const held = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  let hold = true;
  const connections = new ConnectionStore({
    secrets: {
      get: async (key: string) => {
        const value = secrets.get(key);
        if (hold) {
          hold = false;
          read.resolve();
          await held.promise;
        }
        return value;
      },
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
  });
  return { connections, read: read.promise, release: () => held.resolve() };
};

describe("two windows writing the credentials at once", () => {
  it("keeps another window's sign-out of one server while this one drops a refused token for another", async () => {
    signedIn(
      { url: MINI, token: "mdt_mini", id: "device-mini" },
      { url: EDGE, token: "mdt_edge", id: "device-edge" },
    );
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    const here = pausedWindow();
    const refusal = here.connections.refused({ url: MINI, token: "mdt_mini" });
    await here.read;
    await store().signOut(EDGE);
    here.release();
    await refusal;
    expect(await kept(EDGE)).toMatchObject({ kind: "none" });
    expect(await kept(MINI)).toMatchObject({ kind: "none" });
  });

  it("keeps another window's sign-in while this one drops the token it replaced", async () => {
    signedIn({ url: MINI, token: "mdt_old", id: "device-old" });
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const here = pausedWindow();
    const refusal = here.connections.refused({ url: MINI, token: "mdt_old" });
    await here.read;
    expect(await store().connect()).toBe(true);
    here.release();
    await refusal;
    expect(await kept(MINI)).toMatchObject({ kind: "token", token: "mdt_editor" });
  });
});

/**
 * VS Code's secret storage as its windows see it: each window reads its own copy, and a write
 * reaches the other windows only when `deliver` runs (the main process's broadcast, ~100 ms after
 * the write resolved), in the order the writes were made. Like VS Code's `Storage.set`, a window
 * sends no write of the value its copy already holds.
 */
const laggySecrets = () => {
  const copies: Array<Map<string, string>> = [];
  const sent: Array<{ readonly key: string; readonly value: string }> = [];
  const window = () => {
    const copy = new Map(secrets);
    copies.push(copy);
    return new ConnectionStore({
      secrets: {
        get: async (key: string) => copy.get(key),
        store: async (key: string, value: string) => {
          if (copy.get(key) === value) return;
          copy.set(key, value);
          sent.push({ key, value });
        },
      },
    });
  };
  const deliver = (): void => {
    for (const { key, value } of sent.splice(0)) {
      secrets.set(key, value);
      for (const copy of copies) copy.set(key, value);
    }
  };
  return { window, deliver };
};

describe("two windows writing the credentials before either sees the other's write", () => {
  it("keeps a sign-out of one server while another window drops a refused token for another", async () => {
    signedIn(
      { url: MINI, token: "mdt_mini", id: "device-mini" },
      { url: EDGE, token: "mdt_edge", id: "device-edge" },
    );
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    const storage = laggySecrets();
    const [here, there] = [storage.window(), storage.window()];
    await there.signOut(EDGE);
    await here.refused({ url: MINI, token: "mdt_mini" });
    storage.deliver();
    expect(await kept(EDGE)).toMatchObject({ kind: "none" });
    expect(await kept(MINI)).toMatchObject({ kind: "none" });
  });

  it("keeps a sign-in while another window drops the token it replaced", async () => {
    signedIn({ url: MINI, token: "mdt_old", id: "device-old" });
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const storage = laggySecrets();
    const [here, there] = [storage.window(), storage.window()];
    expect(await there.connect()).toBe(true);
    await here.refused({ url: MINI, token: "mdt_old" });
    storage.deliver();
    expect(await kept(MINI)).toMatchObject({ kind: "token", token: "mdt_editor" });
  }, 10_000);

  it("keeps a sign-in made in another window while Mend answers this one's sign-out", async () => {
    signedIn({ url: MINI, token: "mdt_old", id: "device-old" });
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      devicesServer(() => {
        asked.resolve();
        return answer.promise;
      }),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const storage = laggySecrets();
    const [here, there] = [storage.window(), storage.window()];
    const signOut = there.signOut(MINI);
    await asked.promise;
    expect(await here.connect()).toBe(true);
    answer.resolve(new Response(null, { status: 204 }));
    expect(await signOut).toBe(`Signed out of Mend at ${MINI}, and revoked this editor's device.`);
    storage.deliver();
    for (const window of [here, there]) {
      expect(await window.state()).toMatchObject({ kind: "connected", token: "mdt_editor" });
    }
  }, 10_000);

  it("keeps Use it made after another window's sign-in, though this window already read Use it", async () => {
    const cliDir = path.join(home, ".config", "mend");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "cli.json"),
      JSON.stringify({ url: MINI, token: "mdt_cli" }),
    );
    await store().effects().useCliSignIn(MINI);
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const storage = laggySecrets();
    const [here, there] = [storage.window(), storage.window()];
    expect(await here.connect()).toBe(true);
    await there.effects().useCliSignIn(MINI);
    storage.deliver();
    for (const window of [here, there]) {
      expect(await window.state()).toMatchObject({ token: "mdt_cli", source: { kind: "cli" } });
    }
  }, 10_000);

  it("signs out in every window when this one has not yet seen another window's sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const storage = laggySecrets();
    const [here, there] = [storage.window(), storage.window()];
    expect(await here.connect()).toBe(true);
    expect(await there.signOut(MINI)).toBe(`This editor holds no Mend sign-in for ${MINI}.`);
    storage.deliver();
    for (const window of [here, there]) {
      expect(await window.state()).toMatchObject({ kind: "notConnected" });
    }
  }, 10_000);
});

describe("a sign-in kept before 0.37, in the one blob", () => {
  const blob = JSON.stringify({
    entries: [
      { url: MINI, token: "mdt_mini", deviceId: "device-mini", email: "dana@example.com" },
      { url: EDGE, token: "mdt_edge", deviceId: "device-edge" },
    ],
  });

  beforeEach(() => {
    secrets.set(LEGACY_KEY, blob);
    settings.set("mend.serverUrl", MINI);
  });

  it("still connects, and is never written again", async () => {
    vi.stubGlobal(
      "fetch",
      devicesServer(() => new Response(null, { status: 204 })),
    );
    const connections = store();
    expect(await connections.state()).toMatchObject({ kind: "connected", token: "mdt_mini" });
    await connections.signOut(EDGE);
    await connections.refused({ url: MINI, token: "mdt_mini" });
    expect(await kept(EDGE)).toMatchObject({ kind: "none" });
    expect(await connections.state()).toMatchObject({ kind: "notConnected" });
    expect(secrets.get(LEGACY_KEY)).toBe(blob);
  });

  it("gives way to Use it, so the CLI's sign-in applies", async () => {
    const cliDir = path.join(home, ".config", "mend");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "cli.json"),
      JSON.stringify({ url: MINI, token: "mdt_cli" }),
    );
    const connections = store();
    await connections.effects().useCliSignIn(MINI);
    expect(await connections.state()).toMatchObject({ token: "mdt_cli", source: { kind: "cli" } });
  });
});

describe("signing out says what Mend answered", () => {
  const mini = { url: MINI, token: "mdt_mini", id: "device-mini" };
  const cases: ReadonlyArray<readonly [string, () => Response, string]> = [
    ["revoked", () => new Response(null, { status: 204 }), "and revoked this editor's device."],
    ["a 401", () => json(401, {}), "This device was already signed out."],
    ["a 404", () => json(404, {}), "This device was already signed out."],
    [
      "a 403",
      () => json(403, {}),
      "Mend answered 403 when asked to revoke this editor's device. Revoke it under Settings → Devices.",
    ],
    [
      "no answer",
      () => {
        throw new TypeError("fetch failed");
      },
      "Mend could not be reached to revoke this editor's device. Revoke it under Settings → Devices.",
    ],
  ];

  for (const [answered, revoke, said] of cases) {
    it(`on ${answered}, and holds no token afterwards`, async () => {
      signedIn(mini);
      vi.stubGlobal("fetch", devicesServer(revoke));
      const message = await store().signOut();
      expect(message.startsWith(`Signed out of Mend at ${MINI}`), message).toBe(true);
      expect(message.endsWith(said), message).toBe(true);
      expect(await store().state()).toMatchObject({ kind: "notConnected" });
    });
  }
});

describe("Connect while connected (h2)", () => {
  const before = { url: MINI, token: "mdt_before", id: "device-before" };

  it("revokes the device it replaced, with that device's own token, once", async () => {
    signedIn(before);
    const fetcher = devicesServer(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const connections = store();
    expect(await connections.connect()).toBe(true);
    expect(deletes(fetcher)).toEqual([]);
    await connections.revokeReplaced();
    await connections.revokeReplaced();
    expect(deletes(fetcher)).toEqual([
      [`${MINI}/api/me/devices/device-before`, "Bearer mdt_before"],
    ]);
    expect(ui.showWarningMessage).not.toHaveBeenCalled();
    expect(await connections.state()).toMatchObject({ token: "mdt_editor" });
  }, 10_000);

  it("says once when Mend could not be reached to revoke it", async () => {
    signedIn(before);
    vi.stubGlobal(
      "fetch",
      devicesServer(() => {
        throw new TypeError("fetch failed");
      }),
    );
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const connections = store();
    await connections.connect();
    await connections.revokeReplaced();
    expect(ui.showWarningMessage.mock.calls).toEqual([
      [
        `Signed in again to Mend at ${MINI}; Mend could not be reached to revoke this editor's earlier device. Revoke it under Settings → Devices.`,
      ],
    ]);
  }, 10_000);

  it("a first sign-in replaces nothing, and a second Connect joins the one running", async () => {
    const fetcher = devicesServer(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    ui.showInputBox.mockResolvedValueOnce(MINI);
    const connections = store();
    const [first, second] = await Promise.all([connections.connect(), connections.connect()]);
    expect([first, second]).toEqual([true, true]);
    expect(ui.showInputBox).toHaveBeenCalledTimes(1);
    await connections.revokeReplaced();
    expect(deletes(fetcher)).toEqual([]);
  }, 10_000);
});
