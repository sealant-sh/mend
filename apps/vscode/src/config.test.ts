import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionStore } from "./config.js";

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

vi.mock("vscode", () => ({
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
const secrets = new Map<string, string>();
const store = () =>
  new ConnectionStore({
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
  });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-config-test-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  settings.clear();
  secrets.clear();
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
