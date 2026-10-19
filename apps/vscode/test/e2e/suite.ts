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
  readonly workspaceEditor: () => Promise<unknown>;
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
const runId = env("MEND_E2E_RUN_ID");
const editorMode = process.env["MEND_E2E_EDITOR"] === "off" ? "off" : "on";
const seededWorkspaceExtension = process.env["MEND_E2E_SEED_WORKSPACE"] ?? "";
const seededUiExtension = process.env["MEND_E2E_SEED_UI"] ?? "";
const seededUuid = process.env["MEND_E2E_SEED_UUID"] ?? "";
const priorSession = process.env["MEND_E2E_PRIOR_SESSION"] ?? "";

const evidence: Record<string, unknown> = { serverUrl, home: os.homedir() };
const record = (step: string, value: unknown): void => {
  evidence[step] = value;
  fs.writeFileSync(resultFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[mend-e2e] PASS ${step}: ${JSON.stringify(value)}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** From createTerminal to the first command's answer in the Remote-SSH window. */
const FIRST_TERMINAL_BUDGET_MS = 10_000;

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
/** Every quick input the extension made, the real ones: New session is driven through its own. */
const quickInputs: Array<vscode.QuickPick<vscode.QuickPickItem>> = [];

const original = {
  showQuickPick: vscode.window.showQuickPick,
  createQuickPick: vscode.window.createQuickPick.bind(vscode.window),
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
  window["createQuickPick"] = () => {
    const input = original.createQuickPick();
    quickInputs.push(input);
    return input;
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
 * The window step 9 opens is a Remote-SSH window over the managed alias, and extension tests run
 * in every window of the instance: there the suite reads the workspace through Remote-SSH and
 * says what it found, for the first window to wait on.
 */
const remoteWindow = async (): Promise<void> => {
  const enteredAt = Date.now();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder === undefined) throw new Error("the Remote-SSH window has no folder");
  const file = (name: string) => vscode.Uri.joinPath(folder, name);
  const read = async (name: string) =>
    new TextDecoder().decode(await vscode.workspace.fs.readFile(file(name))).trim();
  const typed = await read("st-vscode-typed.txt");
  // The owner's story, in their own VS Code: edit a file in the workspace…
  await vscode.workspace.fs.writeFile(
    file("st-vscode-edited.txt"),
    new TextEncoder().encode("edited in VS Code over Remote-SSH\n"),
  );
  // …use the workspace's terminal (an integrated terminal in a remote window runs there)…
  const terminalOpened = Date.now();
  const terminal = vscode.window.createTerminal({ name: "st-vscode" });
  terminal.sendText(
    "id -un > /workspace/repo/.st-vscode-whoami; echo remote-terminal-$((6*7)) > /workspace/repo/st-vscode-remote-term.txt",
    true,
  );
  const fromTerminal = await until(
    "the Remote-SSH terminal to write its file",
    async () => (await read("st-vscode-remote-term.txt")) || null,
    60_000,
  );
  // Instant or unacceptable: the first command's answer, from createTerminal.
  const terminalMs = Date.now() - terminalOpened;
  const whoami = await read(".st-vscode-whoami");
  // …and forward a port: a server on the workspace's loopback, opened from this machine.
  terminal.sendText(
    `nohup node -e "require('http').createServer((q,s)=>s.end('st-vscode-port')).listen(8765,'127.0.0.1')" > /dev/null 2>&1 &`,
    true,
  );
  const forwarded = await until(
    "Remote-SSH to forward the workspace's port 8765",
    async () => {
      const external = await vscode.env.asExternalUri(vscode.Uri.parse("http://localhost:8765/"));
      const response = await fetch(external.toString(true), { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      return body === "st-vscode-port" ? { url: external.toString(true), body } : null;
    },
    120_000,
  );
  const mend = await vscode.extensions.getExtension<MendApi>("sealant-sh.mend")?.activate();
  if (mend === undefined) throw new Error("the Mend extension is not loaded in the remote window");
  const editor = await mend.workspaceEditor();
  const warm = await vscode.commands.executeCommand("mend.bringMyEditor");
  fs.writeFileSync(
    `${resultFile}.remote.json`,
    `${JSON.stringify(
      {
        remoteName: vscode.env.remoteName,
        folder: folder.toString(),
        readOverRemoteSsh: typed,
        terminal: { wrote: fromTerminal, user: whoami, ms: terminalMs },
        forwarded,
        enteredAt,
        editor,
        warm,
        entries: (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name).toSorted(),
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
  if (settled.some((detail) => detail.sessions.some((session) => session.id !== priorSession)))
    throw new Error("sessions before any");
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

  // 4. New session: one quick input, and Enter starts one session and opens no window. Nothing
  // here has Claude connected, so its launch is refused and the session reads failed.
  const idsNow = async (): Promise<ReadonlyArray<string>> => {
    const sessions = field(await api(`/projects/${project.project.id}`), "sessions");
    return (Array.isArray(sessions) ? sessions : []).map((one) => String(field(one, "id")));
  };
  const known = new Set(await idsNow());
  const inputsBefore = quickInputs.length;
  const opening = vscode.commands.executeCommand("mend.newSession");
  const input = await until("New session's quick input", async () => quickInputs[inputsBefore]);
  await opening;
  if (input.title !== "New session" && input.title !== `New session · ${projectName}`) {
    throw new Error(`New session's quick input is titled ${String(input.title)}`);
  }
  if (input.title === "New session") {
    input.value = projectName;
    await sleep(500);
    await original.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
    await until(
      "New session's prompt step",
      async () => input.title === `New session · ${projectName}`,
    );
  }
  const dimLine = input.items[0]?.description ?? "";
  input.value = "st-vscode-new-session";
  await sleep(500);
  await original.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  const startedIds = await until("the session New session started", async () => {
    const fresh = (await idsNow()).filter((id) => !known.has(id));
    return fresh.length > 0 ? fresh : null;
  });
  // A second Enter, or a slow launch, must not make a second session or open a window.
  await original.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await sleep(5_000);
  const newIds = (await idsNow()).filter((id) => !known.has(id));
  if (newIds.length !== 1 || startedIds.length !== 1) {
    throw new Error(`New session made ${newIds.length} sessions`);
  }
  if (openedFolders.length !== 0) throw new Error("New session opened a window");
  const newSessionId = newIds[0] ?? "";
  const newSession = await until(
    "the started session's launch to settle",
    async () => {
      const read = field(await api(`/sessions/${newSessionId}`), "session");
      return field(read, "status") === "starting" ? null : read;
    },
    120_000,
  );
  await sleep(2_000);
  const names = [field(newSession, "label"), field(newSession, "worktree")].map(String);
  // The refused launch's toast is the one error this step expects.
  const shownSoFar = evidence["errorsShown"];
  evidence["errorsShown"] = (Array.isArray(shownSoFar) ? shownSoFar : []).filter(
    (message) => !names.some((name) => String(message).startsWith(`${name} failed`)),
  );
  record("newSession", {
    sessionId: newSessionId,
    dimLine,
    status: field(newSession, "status"),
    windowsOpened: openedFolders.length,
  });
  await api(`/sessions/${newSessionId}/stop`, { method: "POST", body: "{}" }).catch(
    () => undefined,
  );

  // 5. A shell session set up over the API opens inside its workspace over SSH.
  const shell = await api(`/projects/${project.project.id}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      harness: "shell",
      mode: "pty",
      label: "st-vscode-shell",
      base: null,
      name: null,
    }),
  });
  const workbenchId = String(field(shell, "id"));
  await api(`/sessions/${workbenchId}/launch`, {
    method: "POST",
    body: JSON.stringify({ mode: "pty" }),
  });
  await until(
    "the shell session in the view",
    async () =>
      (await mend.projects()).some((detail) =>
        detail.sessions.some((session) => session.id === workbenchId),
      ),
    60_000,
  );
  modals.set("Set up workspace SSH to open sessions", "Set up");
  await vscode.commands.executeCommand("mend.openInNewWindow", workbenchId);
  const folder = await until("the workspace window to open", async () => openedFolders[0], 600_000);
  const authority = folder.authority;
  const match = /^ssh-remote\+([^@]+)@(.+)$/.exec(authority);
  if (match === null || folder.path !== "/workspace/repo") {
    throw new Error(`unexpected workspace URI ${folder.toString()}`);
  }
  const [, sshUser = "", alias = ""] = match;
  const workspaceId = field(await api(`/sessions/${workbenchId}`), "session", "sealantWorkspaceId");
  if (workspaceId !== sshUser.replace(/^ws-/, "")) {
    throw new Error(`the window opened ${sshUser}, not the shell session's workspace`);
  }
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

  // 6. The Remote-SSH config the extension wrote, used by plain OpenSSH, as Remote-SSH uses it.
  const probe = sshIn(
    alias,
    sshUser,
    "uname -s; id -un; cd /workspace/repo && git rev-parse --abbrev-ref HEAD",
  );
  if (probe.status !== 0) throw new Error(`ssh into the workspace failed: ${probe.stderr}`);
  record("ssh", { stdout: probe.stdout.trim().split("\n") });

  // 7. The session's terminal over /api/tty with an upgrade ticket: type, and read the answer.
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

  // 8. Review: the change opens in the browser, and the edit made in the terminal is in it.
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

  // 9. Remote-SSH for real: a new window over the managed alias installs VS Code's server there.
  if (process.env["MEND_E2E_REMOTE_SSH"] === "1") {
    await vscode.workspace
      .getConfiguration("remote.SSH")
      .update("remotePlatform", { [alias]: "linux" }, vscode.ConfigurationTarget.Global);
    const openStarted = Date.now();
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
    if (field(remote, "terminal", "wrote") !== "remote-terminal-42") {
      throw new Error("the Remote-SSH window's terminal did not run in the workspace");
    }
    if (field(remote, "forwarded", "body") !== "st-vscode-port") {
      throw new Error("Remote-SSH did not forward the workspace's port");
    }
    // A plain SSH host answers in about half a second; so does a Mend workspace.
    const terminalMs = Number(field(remote, "terminal", "ms"));
    if (!(terminalMs < FIRST_TERMINAL_BUDGET_MS)) {
      throw new Error(
        `the Remote-SSH window's first terminal answered after ${terminalMs} ms (budget ${FIRST_TERMINAL_BUDGET_MS} ms)`,
      );
    }

    const remoteList = sshIn(
      alias,
      sshUser,
      "id -u; cat ~/.vscode-server/extensions/extensions.json 2>/dev/null || echo '[]'",
    );
    const [uidLine = "", ...json] = remoteList.stdout.trim().split("\n");
    const parsedList: unknown = JSON.parse(json.join("\n") || "[]");
    const remoteIds = (Array.isArray(parsedList) ? parsedList : []).map((entry) =>
      String(field(entry, "identifier", "id")).toLowerCase(),
    );
    const seededEntry = (Array.isArray(parsedList) ? parsedList : []).find(
      (entry) =>
        String(field(entry, "identifier", "id")).toLowerCase() === seededWorkspaceExtension,
    );
    const uid = Number(uidLine);
    const editorReport = field(remote, "editor");
    const warmReport = field(remote, "warm");
    const plannedOf = (report: unknown) => {
      const planned = field(report, "planned");
      return Array.isArray(planned) ? planned.map(String) : [];
    };
    record("remoteEditor", {
      mode: editorMode,
      uid,
      settled: field(editorReport, "state"),
      syncMs: field(editorReport, "syncMs"),
      planned: plannedOf(editorReport),
      results: field(editorReport, "results"),
      machineSettings: field(editorReport, "machineSettings"),
      remoteExtensions: remoteIds,
      seededRemoteEntry: {
        uuid: field(seededEntry, "identifier", "uuid") ?? null,
        source: field(seededEntry, "metadata", "source") ?? null,
        metadataId: field(seededEntry, "metadata", "id") ?? null,
      },
      warm: {
        settled: field(warmReport, "state"),
        syncMs: field(warmReport, "syncMs"),
        planned: plannedOf(warmReport),
      },
      firstOpenMs: Number(field(remote, "enteredAt")) - openStarted,
      terminalMs: field(remote, "terminal", "ms"),
    });
    if (!(uid >= 40_001 && uid <= 49_999)) {
      throw new Error(`the Remote-SSH window runs as uid ${uid}, not as a person`);
    }
    const forbidden = remoteIds.filter(
      (id) =>
        id === seededUiExtension || id.startsWith("ms-vscode-remote.") || id === "sealant-sh.mend",
    );
    if (forbidden.length > 0) {
      throw new Error(`the workspace has extensions that belong local: ${forbidden.join(", ")}`);
    }
    if (editorMode === "off") {
      if (field(editorReport, "state", "kind") !== "inactive" || remoteIds.length > 0) {
        throw new Error("bring my editor acted while it was off");
      }
    } else {
      if (field(editorReport, "state", "kind") !== "inSync") {
        throw new Error(`bring my editor settled ${JSON.stringify(field(editorReport, "state"))}`);
      }
      if (!remoteIds.includes(seededWorkspaceExtension)) {
        throw new Error(`the workspace does not list ${seededWorkspaceExtension}`);
      }
      const remoteUuid =
        field(seededEntry, "identifier", "uuid") ?? field(seededEntry, "metadata", "id");
      if (remoteUuid !== seededUuid) {
        throw new Error(
          `${seededWorkspaceExtension} has gallery uuid ${String(remoteUuid)} in the workspace, ${seededUuid} locally`,
        );
      }
      if (plannedOf(warmReport).length > 0 || field(warmReport, "state", "kind") !== "inSync") {
        throw new Error(`a second pass was not a no-op: ${JSON.stringify(warmReport)}`);
      }
    }

    // The session sees what the editor wrote: Mend's own terminal into the session reads the file,
    // and the change review lists it.
    quickPicks.push(pick((item) => String(item["label"]).includes("Shell")));
    await vscode.commands.executeCommand("mend.openTerminal", workbenchId);
    const again = await until("the second Mend terminal", async () => ptys[1], 30_000);
    let seen = "";
    again.onDidWrite((data) => {
      seen += data;
    });
    again.open({ columns: 120, rows: 30 });
    await sleep(1500);
    again.handleInput?.("cat /workspace/repo/st-vscode-edited.txt; echo seen-$((6*7))\r");
    await until(
      "the session to read the editor's file",
      async () => seen.includes("seen-42"),
      60_000,
    );
    again.close();
    const edited = await until(
      "the editor's edit in the change",
      async () => {
        const diff = await api(`/changes/${changeId}/diff`);
        const listed = field(diff, "files");
        const paths = (Array.isArray(listed) ? listed : []).map((file) =>
          String(field(file, "path")),
        );
        return paths.includes("st-vscode-edited.txt") ? paths : null;
      },
      180_000,
    );
    if (!seen.includes("edited in VS Code over Remote-SSH")) {
      throw new Error("the session's terminal did not read the editor's file");
    }
    record("sessionSeesEdit", { terminal: "edited in VS Code over Remote-SSH", files: edited });
  }

  // 10. Stop what this run started. The workbench session goes last: the Remote-SSH window runs in
  // its workspace, and VS Code in CLI test mode exits when that window's extension host exits, so
  // the harness confirms this stop.
  modals.set("Stop ", "Stop session");
  const stop = async (sessionId: string) => {
    await vscode.commands.executeCommand("mend.stopSession", sessionId);
    await until(`session ${sessionId} to stop`, async () => {
      const status = field(await api(`/sessions/${sessionId}`), "session", "status");
      return status === "stopped" || status === "completed";
    });
  };
  await stop(liveId);
  record("stopped", { sessions: [liveId] });
  const errors = evidence["errorsShown"];
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error("the editor displayed unexpected errors; inspect its recorded steps");
  }
  record("completed", { runId, remoteSsh: process.env["MEND_E2E_REMOTE_SSH"] !== "0" });
  await stop(workbenchId);
}
