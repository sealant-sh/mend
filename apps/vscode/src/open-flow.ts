import type { Session } from "./types.js";

/** Open follows VS Code's `window.openFoldersInNewWindow`; Open in New Window always opens one. */
export type OpenMode = "follow-setting" | "new-window";

export type OpenFolderOptions =
  | { readonly forceNewWindow: true }
  | { readonly forceNewWindow?: never };

/** vscode.openFolder's options: Open passes none, so VS Code follows the person's setting. */
export const openFolderOptions = (mode: OpenMode): OpenFolderOptions =>
  mode === "new-window" ? { forceNewWindow: true } : {};

export type OpenStep =
  | { readonly kind: "installingRemoteSsh" }
  | { readonly kind: "settingUpWorkspaceSsh" }
  | { readonly kind: "resuming" };

/** The one action an open's error toast offers. */
export type OpenAction = "Retry" | "Set up";

export type OpenState =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly step: OpenStep; readonly since: number }
  /** The one deferred question: workspace SSH was never set up on this machine. */
  | { readonly kind: "awaitingConsent" }
  /** Resumed, or already starting: waiting for the session to report its workspace. */
  | { readonly kind: "awaitingWorkspace"; readonly since: number }
  | { readonly kind: "opening"; readonly workspaceId: string }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: string; readonly action: OpenAction | null };

export type OpenEvent =
  | { readonly kind: "step"; readonly step: OpenStep; readonly at: number }
  | { readonly kind: "consent" }
  | { readonly kind: "waiting"; readonly at: number }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "opened" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string; readonly action: OpenAction | null };

export const reduceOpen = (state: OpenState, event: OpenEvent): OpenState => {
  // A finished run takes no more events; a retry is a new run from idle.
  if (state.kind === "done" || state.kind === "failed") return state;
  switch (event.kind) {
    case "step":
      return state.kind === "preparing" && state.step.kind === event.step.kind
        ? state
        : { kind: "preparing", step: event.step, since: event.at };
    case "consent":
      return { kind: "awaitingConsent" };
    case "waiting":
      // Waiting after a resume is the same "starting …'s workspace": its clock keeps counting.
      return {
        kind: "awaitingWorkspace",
        since:
          state.kind === "awaitingWorkspace" ||
          (state.kind === "preparing" && state.step.kind === "resuming")
            ? state.since
            : event.at,
      };
    case "workspace":
      return { kind: "opening", workspaceId: event.workspaceId };
    case "opened":
      return { kind: "done" };
    case "cancelled":
      return { kind: "idle" };
    case "failed":
      return { kind: "failed", reason: event.reason, action: event.action };
  }
};

/** What the session needs before a window can open on it. */
export type WorkspaceNeed = "have" | "wait" | "resume";

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** A live session with a workspace has it; one still coming up or going down is waited for, never resumed again. */
export const workspaceNeed = (
  session: Pick<Session, "status" | "sealantWorkspaceId">,
): WorkspaceNeed => {
  if (LIVE_STATUSES.has(session.status)) {
    return session.sealantWorkspaceId === null ? "wait" : "have";
  }
  return session.status === "stopping" ? "wait" : "resume";
};

export const stepLabel = (step: OpenStep, sessionName: string): string => {
  switch (step.kind) {
    case "installingRemoteSsh":
      return "installing Remote-SSH";
    case "settingUpWorkspaceSsh":
      return "setting up workspace SSH";
    case "resuming":
      return `starting ${sessionName}'s workspace`;
  }
};

const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

/** The status bar's words for an open in flight; null when there is nothing to show. */
export const statusText = (state: OpenState, sessionName: string, now: number): string | null => {
  switch (state.kind) {
    case "preparing":
      return `${stepLabel(state.step, sessionName)} · ${seconds(now - state.since)} s`;
    case "awaitingWorkspace":
      return `${stepLabel({ kind: "resuming" }, sessionName)} · ${seconds(now - state.since)} s`;
    case "opening":
      return `opening ${sessionName}`;
    case "idle":
    case "awaitingConsent":
    case "done":
    case "failed":
      return null;
  }
};
