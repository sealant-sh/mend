import * as path from "node:path";

import { originMatches } from "@mend/local-git/origin";
import * as vscode from "vscode";

import { isRecord } from "./client-data.js";
import type { MendClient } from "./client.js";
import { showErrorToast } from "./error-toast.js";
import { gitRunner } from "./git.js";
import type { HandoffClient } from "./handoff-client.js";
import { HandoffDraft, type AcceptedHandoff } from "./handoff-draft.js";
import { awaitsCheck, HandoffSubmission, type SubmissionOutcome } from "./handoff-submit.js";
import { HandoffWorker, sweepHandoffScratch } from "./handoff-worker.js";
import {
  completionWords,
  cutTime,
  excludedFiles,
  HANDOFF_UNSUPPORTED,
  issueWords,
  localIssueWords,
  openQuestion,
  renderQuestion,
  stepQuestion,
  type HandoffTarget,
  type Question,
  type QuestionEvent,
} from "./handoff.js";
import type { Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import { originProjectName } from "./project-match.js";
import type { SessionStore } from "./session-store.js";
import type { WindowRole } from "./window-role.js";

interface Root {
  readonly path: string;
  readonly folder: vscode.WorkspaceFolder;
}
interface Item extends vscode.QuickPickItem {
  readonly id: string;
}
const FILES = { iconPath: new vscode.ThemeIcon("list-flat"), tooltip: "Files left out…" };
const REFRESH = { iconPath: new vscode.ThemeIcon("refresh"), tooltip: "Refresh snapshot" };
const INCLUDE = {
  iconPath: new vscode.ThemeIcon("add"),
  tooltip: "Include .env files (gitignored files stay out)",
};
const EXCLUDE = { iconPath: new vscode.ThemeIcon("remove"), tooltip: "Leave out .env files" };
const selectedGit = (): string => {
  const exported = vscode.extensions.getExtension<unknown>("vscode.git")?.exports;
  if (isRecord(exported) && typeof exported["getAPI"] === "function") {
    try {
      const api: unknown = exported["getAPI"](1);
      const git: unknown = isRecord(api) ? api["git"] : null;
      if (isRecord(git) && typeof git["path"] === "string" && git["path"] !== "")
        return git["path"];
    } catch {
      /* Git may still be activating; its configured executable is the fallback. */
    }
  }
  const configured: unknown = vscode.workspace.getConfiguration("git").get("path");
  return typeof configured === "string" && configured !== ""
    ? configured
    : Array.isArray(configured) && typeof configured[0] === "string"
      ? configured[0]
      : "git";
};
const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

export class HandoffInput implements vscode.Disposable {
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #kept = new Map<string, string>();
  #generation = 0;
  #destinationGeneration = 0;
  #active: { readonly focus: () => void; readonly cancel: () => void } | null = null;
  #disposed = false;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: MendClient,
    private readonly store: SessionStore,
    private readonly launches: Launches,
    private readonly role: WindowRole,
  ) {
    this.#subscriptions.push(
      context.secrets.onDidChange(() => {
        ++this.#destinationGeneration;
        void this.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("mend.serverUrl")) ++this.#destinationGeneration;
        if (event.affectsConfiguration("mend.serverUrl") || event.affectsConfiguration("git.path"))
          void this.refresh();
      }),
      store.onDidHearEvent((event) => {
        if (event.type === "resync") void this.refresh();
      }),
    );
    void sweepHandoffScratch().catch(() => undefined);
    void this.refresh();
  }
  dispose(): void {
    this.#disposed = true;
    ++this.#generation;
    this.#active?.cancel();
    for (const subscription of this.#subscriptions) subscription.dispose();
  }
  async #localRoots(): Promise<ReadonlyArray<Root>> {
    if (
      process.platform === "win32" ||
      vscode.env.remoteName !== undefined ||
      this.role.kind !== "local"
    )
      return [];
    const git = gitRunner({ binary: selectedGit() });
    const roots = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map(async (folder): Promise<Root | null> => {
        if (folder.uri.scheme !== "file") return null;
        const found = await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"]);
        return found.kind === "out" && found.stdout !== "" ? { path: found.stdout, folder } : null;
      }),
    );
    return [
      ...new Map(
        roots.flatMap((root) => (root === null ? [] : [[root.path, root] as const])),
      ).values(),
    ];
  }
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    void vscode.commands.executeCommand("setContext", "mend.handoff.support", "checking");
    try {
      const [roots, bound] = await Promise.all([this.#localRoots(), this.client.bindHandoff()]);
      const support = await bound.support();
      if (this.#disposed || generation !== this.#generation || !(await bound.isCurrent())) return;
      if (process.platform !== "win32")
        void vscode.commands.executeCommand(
          "setContext",
          "mend.handoff.localGit",
          roots.length > 0,
        );
      void vscode.commands.executeCommand("setContext", "mend.handoff.support", support);
    } catch {
      if (generation !== this.#generation || this.#disposed) return;
      void vscode.commands.executeCommand("setContext", "mend.handoff.support", "unavailable");
    }
  }

  async open(argument: unknown): Promise<void> {
    if (this.#active !== null) {
      this.#active.focus();
      return;
    }
    const box = vscode.window.createInputBox();
    const pick = vscode.window.createQuickPick<Item>();
    box.ignoreFocusOut = pick.ignoreFocusOut = true;
    let showing: vscode.InputBox | vscode.QuickPick<Item> = box;
    const destinationGeneration = this.#destinationGeneration;
    let state: Question = openQuestion();
    let draft: HandoffDraft | null = null;
    let worker: HandoffWorker | null = null;
    let bound: HandoffClient | null = null;
    let choice: ((id: string | null) => void) | null = null;
    let transferred = false;
    let closed = false;
    const cancelled = new AbortController();
    const subscriptions: vscode.Disposable[] = [box, pick];
    const focus = () =>
      transferred ? void vscode.commands.executeCommand("notifications.showList") : showing.show();
    const active = { focus, cancel: () => close() };
    this.#active = active;
    void vscode.commands.executeCommand("setContext", "mend.handoff.active", true);
    const releaseActive = () => {
      if (this.#active === active) {
        this.#active = null;
        void vscode.commands.executeCommand("setContext", "mend.handoff.active", false);
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      choice?.(null);
      choice = null;
      if (!transferred) {
        if (bound !== null) this.#kept.set(bound.account, state.prompt);
        cancelled.abort();
        void (draft === null ? worker?.dispose() : draft.discard());
        releaseActive();
      }
      for (const subscription of subscriptions) subscription.dispose();
    };
    const show = () => {
      if (closed || choice !== null) return;
      const view = renderQuestion(state);
      box.title = view.title;
      box.placeholder = view.placeholder;
      box.prompt = view.prompt;
      box.busy = view.busy;
      box.enabled = true;
      if (box.value !== view.value) {
        box.value = view.value;
        box.valueSelection = [view.value.length, view.value.length];
      }
      box.buttons =
        state.kind === "editing" || state.kind === "capturing"
          ? [
              state.envFiles === "include" ? EXCLUDE : INCLUDE,
              ...(state.kind === "editing" ? [FILES] : []),
              REFRESH,
            ]
          : [];
      if (state.kind === "files-left-out") {
        pick.title = "Files left out…";
        pick.placeholder = "Back returns to your prompt";
        pick.value = "";
        pick.buttons = [vscode.QuickInputButtons.Back];
        pick.items = excludedFiles(state.summary, state.fileBytes).map((item, index) => ({
          ...item,
          id: String(index),
          alwaysShow: true,
        }));
        if (pick.items.length === 0)
          pick.items = [{ id: "none", label: "No eligible files left out", alwaysShow: true }];
        showing = pick;
        pick.show();
      } else {
        showing = box;
        box.show();
      }
    };
    const dispatch = (event: QuestionEvent) => {
      if (closed) return;
      const next = stepQuestion(state, event);
      state = next.state;
      box.validationMessage = next.issue ?? undefined;
      if (next.effect.kind === "discard") {
        close();
        return;
      }
      if (next.effect.kind === "capture") {
        const effect = next.effect;
        void draft
          ?.withEnv(effect.envFiles)
          .then((result) => {
            if (closed) return undefined;
            if ("kind" in result)
              dispatch({
                kind: "capture-ready",
                generation: effect.generation,
                summary: result.value,
                fileBytes: draftTermsFileBytes,
              });
            else if (result._tag === "refused")
              dispatch({
                kind: "refused",
                generation: effect.generation,
                message: localIssueWords(result),
              });
            return undefined;
          })
          .catch(() =>
            dispatch({
              kind: "refused",
              generation: effect.generation,
              message: "Mend could not read the checkout. Try again.",
            }),
          );
      }
      if (next.effect.kind === "submit") {
        const accepted = draft?.accept(state.prompt);
        if (accepted === undefined || accepted === null) {
          close();
          return;
        }
        transferred = true;
        close();
        void this.#submit(accepted, releaseActive)
          .catch((cause: unknown) =>
            showErrorToast(
              cause,
              "Mend could not finish the handoff. Check its sessions before trying again.",
            ),
          )
          .finally(releaseActive);
        return;
      }
      show();
    };
    let draftTermsFileBytes = 0;
    const choose = (title: string, items: ReadonlyArray<Item>): Promise<string | null> => {
      pick.title = title;
      pick.placeholder = "Choose one";
      pick.value = "";
      pick.buttons = [];
      pick.items = items;
      pick.busy = false;
      showing = pick;
      pick.show();
      return new Promise((resolve) => {
        choice = resolve;
      });
    };
    const fail = (message: string) =>
      dispatch({ kind: "refused", generation: state.generation, message });
    subscriptions.push(
      box.onDidChangeValue((value) => {
        if (showing === box) dispatch({ kind: "typed", value });
      }),
      box.onDidAccept(() => {
        if (showing !== box) return;
        dispatch({ kind: "typed", value: box.value });
        if (destinationGeneration !== this.#destinationGeneration) {
          fail(
            "The Mend connection changed. Your prompt is kept; close this question and try again.",
          );
          return;
        }
        dispatch({ kind: "accept" });
      }),
      box.onDidTriggerButton((button) => {
        if (button === FILES) dispatch({ kind: "show-files" });
        else if (button === REFRESH) dispatch({ kind: "refresh-snapshot" });
        else dispatch({ kind: "env-files", value: button === INCLUDE ? "include" : "exclude" });
      }),
      pick.onDidAccept(() => {
        if (choice !== null) {
          const resolve = choice;
          choice = null;
          resolve(pick.activeItems[0]?.id ?? null);
        }
      }),
      pick.onDidTriggerButton(() => dispatch({ kind: "back" })),
      box.onDidHide(() => {
        if (showing === box) close();
      }),
      pick.onDidHide(() => {
        if (showing === pick) close();
      }),
      this.store.onDidChange(({ next }) => {
        if (next.offline !== state.offline) dispatch({ kind: "connection", offline: next.offline });
      }),
    );
    show();
    try {
      const [roots, client] = await Promise.all([this.#localRoots(), this.client.bindHandoff()]);
      if (closed) return;
      bound = client;
      dispatch({
        kind: "typed",
        value: state.prompt === "" ? (this.#kept.get(client.account) ?? "") : state.prompt,
      });
      dispatch({ kind: "connection", offline: this.store.model()?.offline ?? false });
      if (roots.length === 0) {
        fail("Open a local Git repository to hand off its branch.");
        return;
      }
      const support = await client.support();
      if (closed) return;
      if (support !== "supported") {
        fail(
          support === "unsupported"
            ? HANDOFF_UNSUPPORTED
            : "Mend did not answer. Your prompt is kept; hand off again once it is connected.",
        );
        return;
      }
      const rawRoot: unknown = isRecord(argument) ? argument["rootUri"] : null;
      const scmRoot = rawRoot instanceof vscode.Uri ? rawRoot : null;
      let root: Root | undefined;
      if (scmRoot !== null) {
        root = roots.find(
          (candidate) => scmRoot.scheme === "file" && candidate.path === scmRoot.fsPath,
        );
        if (root === undefined) {
          fail("Choose a repository in this local workspace to hand off.");
          return;
        }
      } else {
        const editor = vscode.window.activeTextEditor?.document.uri;
        root =
          editor?.scheme === "file"
            ? roots.find((candidate) => contains(candidate.path, editor.fsPath))
            : undefined;
        root ??= roots.length === 1 ? roots[0] : undefined;
      }
      if (root === undefined) {
        const selected = await choose(
          "Hand off to Mend · choose a repository",
          roots.map((candidate) => ({
            id: candidate.path,
            label: candidate.folder.name,
            description: candidate.path,
          })),
        );
        if (closed || selected === null) return;
        root = roots.find((candidate) => candidate.path === selected);
      }
      if (root === undefined || closed) return;
      show();
      worker = new HandoffWorker({
        entry: vscode.Uri.joinPath(this.context.extensionUri, "dist", "handoff-worker.js").fsPath,
        checkout: root.path,
        git: selectedGit(),
      });
      const checkout = await worker.discover(cancelled.signal);
      if (closed) return;
      if (!("kind" in checkout)) {
        if (checkout._tag === "refused") fail(localIssueWords(checkout));
        return;
      }
      const origin = checkout.value.originUrl;
      if (origin === null) {
        fail("This checkout has no origin. Add its origin, then hand off.");
        return;
      }
      const [projects, gitAccess] = await Promise.all([client.listProjects(), client.gitAccess()]);
      if (closed) return;
      const matches = projects.filter((project) =>
        originMatches(origin, project.originUrl, checkout.value.top),
      );
      let project = matches.length === 1 ? matches[0] : undefined;
      if (matches.length > 1) {
        const selected = await choose(
          "Hand off to Mend · choose a project",
          matches.map((candidate) => ({
            id: candidate.id,
            label: candidate.name,
            ...(candidate.originUrl === null ? {} : { description: candidate.originUrl }),
          })),
        );
        if (closed || selected === null) return;
        project = matches.find((candidate) => candidate.id === selected);
      }
      const matched = this.store.windowProject();
      if (
        project === undefined &&
        matched !== null &&
        matched.folder.uri.toString() === root.folder.uri.toString() &&
        !originMatches(origin, matched.project.originUrl, checkout.value.top)
      ) {
        fail(`This checkout's origin isn't ${matched.project.name}'s`);
        return;
      }
      const target: HandoffTarget =
        project === undefined
          ? { kind: "adopt", origin, name: originProjectName(origin) }
          : { kind: "project", project };
      dispatch({ kind: "reading-terms" });
      const terms = await client.handoffTerms(project?.id ?? null);
      if (closed) return;
      if (terms.kind === "refused") {
        fail(issueWords(terms.issue));
        if (terms.issue.kind === "signed-out")
          await showErrorToast(
            new MendApiError(issueWords(terms.issue), 401),
            issueWords(terms.issue),
          );
        return;
      }
      draftTermsFileBytes = terms.terms.fileBytes;
      draft = new HandoffDraft({
        checkout: checkout.value,
        target,
        terms: terms.terms,
        client,
        worker,
        projectsBefore: projects,
        gitAccess,
      });
      dispatch({ kind: "capture", target });
    } catch (cause) {
      if (!closed)
        fail(
          cause instanceof Error ? cause.message : "Mend could not read the checkout. Try again.",
        );
      if (!closed && cause instanceof MendApiError && cause.status === 401)
        await showErrorToast(cause, cause.message);
    }
  }

  async #submit(accepted: AcceptedHandoff, releaseActive: () => void): Promise<void> {
    let progress: ((message: string) => void) | null = null;
    const operation = new HandoffSubmission(accepted, {
      launches: this.launches,
      record: (project, receipt) => this.store.recordHandoff(project, receipt),
      progress: (message) => progress?.(message),
      observe: (id, changed) => {
        const subscription = this.store.onDidHearEvent((event) => {
          if (event.sessionId === id || event.type === "resync") changed();
        });
        return () => subscription.dispose();
      },
    });
    const run = (retry: boolean): Thenable<SubmissionOutcome> =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Hand off to Mend",
          cancellable: false,
        },
        (reporter) => {
          progress = (message) => reporter.report({ message });
          return retry ? operation.checkAgain() : operation.run();
        },
      );
    const prompt = accepted.continuation.kind === "prompt" ? accepted.continuation.prompt : "";
    let outcome: SubmissionOutcome;
    try {
      outcome = await run(false);
      while (awaitsCheck(outcome, accepted)) {
        const answer = await vscode.window.showWarningMessage(outcome.message ?? "", "Check again");
        if (answer !== "Check again") {
          if (outcome.kind === "unconfirmed") this.#kept.set(accepted.client.account, prompt);
          return;
        }
        outcome = await run(true);
      }
    } finally {
      await operation.dispose();
      releaseActive();
    }
    if (outcome.kind === "unconfirmed") return;
    if (outcome.kind === "refused") {
      this.#kept.set(accepted.client.account, prompt);
      await showErrorToast(
        outcome.issue?.kind === "signed-out" ? new MendApiError(outcome.message, 401) : null,
        outcome.message,
      );
      return;
    }
    this.#kept.delete(accepted.client.account);
    if (!(await accepted.client.isCurrent())) {
      const action = await vscode.window.showInformationMessage(
        `Handed off as ${outcome.receipt.worktree.name} on ${accepted.client.label}. Your checkout is unchanged. Snapshot as of ${cutTime(accepted.summary.cutAt)}. Reconnect there to open or review it.`,
        "Connect to server",
      );
      if (action !== undefined) void vscode.commands.executeCommand("mend.connect");
      return;
    }
    const message =
      outcome.message === null
        ? completionWords(outcome.receipt, accepted.summary.cutAt)
        : `${outcome.message} Your checkout is unchanged. Snapshot as of ${cutTime(accepted.summary.cutAt)}.`;
    const action = await vscode.window.showInformationMessage(message, "Open", "Review");
    if (action === undefined || !(await accepted.client.isCurrent())) return;
    const node = { kind: "session", project: outcome.project, session: outcome.receipt.session };
    await vscode.commands.executeCommand(
      action === "Open" ? "mend.open" : "mend.reviewChange",
      node,
    );
  }
}
