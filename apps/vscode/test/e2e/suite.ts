/**
 * The editor half of the remote acceptance (scripts/vscode-remote-acceptance.mjs): it runs inside a
 * real VS Code, against a real Mend server reached at a non-loopback address, and drives the
 * extension's own commands. Only the dialogs a person would answer are answered here (quick picks,
 * input boxes, modals, the browser), and opening the new window is captured instead of replacing
 * the test window; every request, the event stream, the terminal socket and SSH are real.
 *
 * Inputs (environment): MEND_E2E_URL, MEND_E2E_OWNER_TOKEN (the first account's bearer, used only
 * to approve the browser sign-in and to read the change), MEND_E2E_PROJECT, MEND_E2E_RESULT (where
 * the evidence goes as JSON). Each step's evidence is written as it passes, so a failure leaves
 * what did pass on disk.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

interface ProjectDetailLike {
  readonly project: { readonly id: string; readonly name: string };
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}

interface MendApi {
  readonly projects: () => Promise<ReadonlyArray<ProjectDetailLike>>;
}

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

const serverUrl = env("MEND_E2E_URL");
const ownerToken = env("MEND_E2E_OWNER_TOKEN");
const projectName = env("MEND_E2E_PROJECT");
const resultFile = env("MEND_E2E_RESULT");

const evidence: Record<string, unknown> = { serverUrl, home: os.homedir() };
const record = (step: string, value: unknown): void => {
  evidence[step] = value;
  fs.writeFileSync(resultFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[mend-e2e] PASS ${step}: ${JSON.stringify(value)}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async <T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  limitMs = 60_000,
): Promise<T> => {
  const deadline = Date.now() + limitMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (cause) {
      last = cause;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`,
  );
};

const api = async (route: string, init: RequestInit = {}): Promise<unknown> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ownerToken}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${serverUrl}/api${route}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${route} → ${response.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

const field = (value: unknown, ...keys: ReadonlyArray<string>): unknown => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
};

// ── answering the dialogs ──────────────────────────────────────────────────

type Answer = (items: ReadonlyArray<unknown>, options: unknown) => unknown;
const quickPicks: Array<Answer> = [];
const inputBoxes: Array<string> = [];
/** Modal answers by what the modal says: a modal nobody expected fails the run. */
const modals = new Map<string, string>();
const opened: Array<string> = [];
const openedFolders: Array<vscode.Uri> = [];
const ptys: Array<vscode.Pseudoterminal> = [];

const original = {
  showQuickPick: vscode.window.showQuickPick,
  executeCommand: vscode.commands.executeCommand,
};

const pick =
  (match: (item: Record<string, unknown>) => boolean): Answer =>
  (items) => {
    const found = items.find(
      (item) => typeof item === "object" && item !== null && match({ ...item }),
    );
    if (found === undefined)
      throw new Error(`no quick pick item matched: ${JSON.stringify(items)}`);
    return found;
  };

const isPseudoterminal = (value: unknown): value is vscode.Pseudoterminal =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "open") === "function" &&
  typeof field(value, "close") === "function" &&
  typeof field(value, "onDidWrite") === "function";

const install = (): void => {
  const window: Record<string, unknown> = vscode.window;
  window["showQuickPick"] = async (items: unknown, options: unknown) => {
    const answer = quickPicks.shift();
    if (answer === undefined) throw new Error(`unexpected quick pick ${JSON.stringify(options)}`);
    const resolved = await Promise.resolve(items);
    return answer(Array.isArray(resolved) ? resolved : [], options);
  };
  window["showInputBox"] = async (options: unknown) => {
    const answer = inputBoxes.shift();
    if (answer === undefined) throw new Error(`unexpected input box ${JSON.stringify(options)}`);
    return answer;
  };
  const answerModal =
    (kind: string) =>
    async (message: string, ...rest: ReadonlyArray<unknown>) => {
      const buttons = rest.filter((item): item is string => typeof item === "string");
      const isModal = rest.some((item) => field(item, "modal") === true);
      console.log(`[mend-e2e] ${kind}: ${message} ${JSON.stringify(buttons)}`);
      if (!isModal && buttons.length === 0) return undefined;
      const wanted = [...modals.entries()].find(
        ([says, button]) => message.includes(says) && buttons.includes(button),
      )?.[1];
      if (wanted === undefined) {
        throw new Error(`unexpected ${kind} "${message}" with ${JSON.stringify(buttons)}`);
      }
      return wanted;
    };
  window["showInformationMessage"] = answerModal("info");
  window["showWarningMessage"] = answerModal("warning");
  window["showErrorMessage"] = async (message: string) => {
    console.log(`[mend-e2e] error shown: ${message}`);
    evidence["errorsShown"] = [
      ...(Array.isArray(evidence["errorsShown"]) ? evidence["errorsShown"] : []),
      message,
    ];
    return undefined;
  };
  const vsEnv: Record<string, unknown> = vscode.env;
  vsEnv["openExternal"] = async (uri: vscode.Uri) => {
    opened.push(uri.toString(true));
    return true;
  };
  window["createTerminal"] = (options: unknown) => {
    const pty = field(options, "pty");
    if (isPseudoterminal(pty)) {
      ptys.push(pty);
      return { show: () => undefined, dispose: () => undefined };
    }
    throw new Error("the extension opened a terminal that is not Mend's");
  };
  const commands: Record<string, unknown> = vscode.commands;
  commands["executeCommand"] = async (command: string, ...args: ReadonlyArray<unknown>) => {
    if (command === "vscode.openFolder" && args[0] instanceof vscode.Uri) {
      openedFolders.push(args[0]);
      return undefined;
    }
    return original.executeCommand(command, ...args);
  };
};

// ── the steps ──────────────────────────────────────────────────────────────

const sshIn = (alias: string, user: string, script: string, timeoutMs = 60_000) =>
  spawnSync(
    "ssh",
    [
      "-F",
      path.join(os.homedir(), ".ssh", "config"),
      "-o",
      `UserKnownHostsFile=${path.join(os.homedir(), ".ssh", "known_hosts")}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-l",
      user,
      alias,
      script,
    ],
    { encoding: "utf8", timeout: timeoutMs },
  );

/**
 * The window step 8 opens is a Remote-SSH window over the managed alias, and extension tests run
 * in every window of the instance: there the suite reads the workspace through Remote-SSH and
 * says what it found, for the first window to wait on.
 */
const remoteWindow = async (): Promise<void> => {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder === undefined) throw new Error("the Remote-SSH window has no folder");
  const typed = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(folder, "st-vscode-typed.txt"),
  );
  const entries = await vscode.workspace.fs.readDirectory(folder);
  fs.writeFileSync(
    `${resultFile}.remote.json`,
    `${JSON.stringify(
      {
        remoteName: vscode.env.remoteName,
        folder: folder.toString(),
        readOverRemoteSsh: new TextDecoder().decode(typed).trim(),
        entries: entries.map(([name]) => name).toSorted(),
      },
      null,
      2,
    )}\n`,
  );
  // The window stays open for the first one to see; the run ends when that one returns.
  await sleep(120_000);
};

export async function run(): Promise<void> {
  if (vscode.env.remoteName !== undefined) return remoteWindow();
  const extension = vscode.extensions.getExtension<MendApi>("sealant-sh.mend");
  if (extension === undefined) throw new Error("the Mend extension is not loaded");
  const mend = await extension.activate();
  install();

  // 1. Signed out, the view reads nothing.
  const before = await mend.projects();
  record("signedOut", { projects: before.length });
  if (before.length !== 0) throw new Error("a signed-out editor read projects");

  // 2. Sign in through the browser walk; the "browser" approves with the owner's own session.
  inputBoxes.push(serverUrl);
  quickPicks.push(pick((item) => item["method"] === "browser"));
  const approvals: Array<string> = [];
  const vsEnv: Record<string, unknown> = vscode.env;
  vsEnv["openExternal"] = async (uri: vscode.Uri) => {
    const page = uri.toString(true);
    opened.push(page);
    const code = new URL(page).searchParams.get("code");
    if (code !== null) {
      await api(`/me/cli-auth/${encodeURIComponent(code)}/approve`, { method: "POST", body: "{}" });
      approvals.push(page);
    }
    return true;
  };
  await vscode.commands.executeCommand("mend.connect");
  const project = await until("the project in the view after sign-in", async () =>
    (await mend.projects()).find((detail) => detail.project.name === projectName),
  );
  record("signIn", { approvePage: approvals[0], projectId: project.project.id });
  if (!(approvals[0] ?? "").startsWith(`${serverUrl}/authorize`)) {
    throw new Error("the approve page is not on the server's own URL");
  }
  vsEnv["openExternal"] = async (uri: vscode.Uri) => {
    opened.push(uri.toString(true));
    return true;
  };

  // 3. Live: a session created elsewhere reaches the view over the event stream, no refresh asked.
  // Settle first, so the refresh the new stream does on connecting cannot be what shows it.
  await sleep(5000);
  const settled = await mend.projects();
  if (settled.some((detail) => detail.sessions.length > 0)) throw new Error("sessions before any");
  const created = await api(`/projects/${project.project.id}/sessions`, {
    method: "POST",
    body: JSON.stringify({ harness: "claude", label: "st-vscode-live", base: null, name: null }),
  });
  const liveId = String(field(created, "id"));
  const liveStarted = Date.now();
  await until(
    "the session created elsewhere in the view",
    async () =>
      (await mend.projects()).some((detail) =>
        detail.sessions.some((session) => session.id === liveId),
      ),
    30_000,
  );
  record("liveEvents", { sessionId: liveId, ms: Date.now() - liveStarted });

  // 4. Start a session from the editor (Workbench): VS Code opens inside its workspace over SSH.
  quickPicks.push(pick((item) => item["label"] === projectName));
  quickPicks.push(pick((item) => item["sessionKind"] === "workbench"));
  modals.set("Set up workspace SSH?", "Set up");
  modals.set("has no live workspace", "Resume and open");
  await vscode.commands.executeCommand("mend.newSession");
  const folder = await until("the workspace window to open", async () => openedFolders[0], 600_000);
  const authority = folder.authority;
  const match = /^ssh-remote\+([^@]+)@(.+)$/.exec(authority);
  if (match === null || folder.path !== "/workspace/repo") {
    throw new Error(`unexpected workspace URI ${folder.toString()}`);
  }
  const [, sshUser = "", alias = ""] = match;
  const detail = await api(`/projects/${project.project.id}`);
  const sessions = field(detail, "sessions");
  const workbench = (Array.isArray(sessions) ? sessions : []).find(
    (session) => field(session, "sealantWorkspaceId") === sshUser.replace(/^ws-/, ""),
  );
  const workbenchId = String(field(workbench, "id"));
  const sshConfig = fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8");
  if (
    !sshConfig.endsWith(
      "Host *\n  UserKnownHostsFile " + path.join(os.homedir(), ".ssh", "known_hosts") + "\n",
    )
  ) {
    throw new Error("setup did not keep the hand-written block after its own");
  }
  record("startSession", {
    sessionId: workbenchId,
    uri: folder.toString(),
    sshConfigBlock: sshConfig
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(0, 10),
  });

  // 5. The Remote-SSH config the extension wrote, used by plain OpenSSH, as Remote-SSH uses it.
  const probe = sshIn(
    alias,
    sshUser,
    "uname -s; id -un; cd /workspace/repo && git rev-parse --abbrev-ref HEAD",
  );
  if (probe.status !== 0) throw new Error(`ssh into the workspace failed: ${probe.stderr}`);
  record("ssh", { stdout: probe.stdout.trim().split("\n") });

  // 6. The session's terminal over /api/tty with an upgrade ticket: type, and read the answer.
  quickPicks.push(pick((item) => String(item["label"]).includes("Shell")));
  await vscode.commands.executeCommand("mend.openTerminal", workbenchId);
  const pty = await until("the Mend terminal", async () => ptys[0], 30_000);
  let screen = "";
  pty.onDidWrite((data) => {
    screen += data;
  });
  pty.open({ columns: 120, rows: 30 });
  await sleep(1500);
  pty.handleInput?.(
    "echo who-$(id -un); printf '%s\\n' st-vscode-typed > /workspace/repo/st-vscode-typed.txt; echo typed-$((6*7))\r",
  );
  await until("the terminal to answer", async () => screen.includes("typed-42"), 60_000);
  pty.close();
  const terminalUser =
    /who-([a-z0-9_-]+)/.exec(screen.replaceAll("who-$(id -un)", ""))?.[1] ?? null;
  record("terminal", { answered: "typed-42", user: terminalUser, bytes: screen.length });

  // 7. Review: the change opens in the browser, and the edit made in the terminal is in it.
  await vscode.commands.executeCommand("mend.reviewChange", workbenchId);
  const reviewPage = await until("the review page to open", async () =>
    opened.find((page) => page.includes("/changes/")),
  );
  const changeId = reviewPage.split("/changes/")[1] ?? "";
  const page = await fetch(reviewPage);
  const files = await until(
    "the terminal's edit in the change",
    async () => {
      const diff = await api(`/changes/${changeId}/diff`);
      const listed = field(diff, "files");
      const paths = (Array.isArray(listed) ? listed : []).map((file) =>
        String(field(file, "path")),
      );
      return paths.includes("st-vscode-typed.txt") ? paths : null;
    },
    180_000,
  );
  record("review", { page: reviewPage, pageStatus: page.status, files });
  if (!reviewPage.startsWith(`${serverUrl}/changes/`) || page.status !== 200) {
    throw new Error("the review page is not served at the server's URL");
  }

  // 8. Remote-SSH for real: a new window over the managed alias installs VS Code's server there.
  if (process.env["MEND_E2E_REMOTE_SSH"] === "1") {
    await vscode.workspace
      .getConfiguration("remote.SSH")
      .update("remotePlatform", { [alias]: "linux" }, vscode.ConfigurationTarget.Global);
    await original.executeCommand("vscode.openFolder", folder, { forceNewWindow: true });
    const remote = await until(
      "the Remote-SSH window to read the workspace",
      async () =>
        fs.existsSync(`${resultFile}.remote.json`)
          ? JSON.parse(fs.readFileSync(`${resultFile}.remote.json`, "utf8"))
          : null,
      300_000,
    );
    const server = sshIn(
      alias,
      sshUser,
      "ls -d ~/.vscode-server/cli/servers/* ~/.vscode-server/bin/* 2>/dev/null",
    );
    record("remoteSsh", { window: remote, server: server.stdout.trim().split("\n") });
    if (field(remote, "readOverRemoteSsh") !== "st-vscode-typed") {
      throw new Error("the Remote-SSH window did not read the terminal's file");
    }
  }

  // 9. Stop what this run started.
  modals.set("Stop ", "Stop session");
  for (const sessionId of [workbenchId, liveId]) {
    await vscode.commands.executeCommand("mend.stopSession", sessionId);
  }
  record("stopped", { sessions: [workbenchId, liveId] });
}
