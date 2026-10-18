import {
  notInWorkspace,
  type InstallMemory,
  type InstallResult,
  type LocalExtensions,
  type RemoteExtensions,
} from "./editor-extensions.js";

export type EditorSyncState =
  | { readonly kind: "inactive" }
  | { readonly kind: "checking" }
  | { readonly kind: "sharedHome" }
  | { readonly kind: "noLocalList" }
  | { readonly kind: "installing"; readonly current: number; readonly total: number }
  | { readonly kind: "inSync"; readonly installed: number; readonly staysLocal: number }
  | { readonly kind: "notSynced"; readonly reason: string };

export const LOG_COMMAND = "mend.showWorkspaceEditorLog";
export const SYNC_COMMAND = "mend.bringMyEditor";

export interface StatusView {
  readonly text: string;
  readonly tooltip: string;
  readonly command: string;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

const NAMED = 5;

export const notInWorkspaceReason = (ids: ReadonlyArray<string>): string => {
  const more = ids.length > NAMED ? ` and ${ids.length - NAMED} more` : "";
  return `${plural(ids.length, "extension")} ${ids.length === 1 ? "is" : "are"} not in this workspace: ${ids.slice(0, NAMED).join(", ")}${more}.`;
};

export const settledState = (
  local: LocalExtensions,
  remote: RemoteExtensions,
  memory: InstallMemory,
  editor: string,
  results: ReadonlyArray<InstallResult>,
): EditorSyncState => {
  const absent = notInWorkspace(local, remote, memory, editor);
  const count = (kind: InstallResult["kind"]) =>
    results.filter((result) => result.kind === kind).length;
  return absent.length === 0
    ? { kind: "inSync", installed: count("installed"), staysLocal: count("staysLocal") }
    : { kind: "notSynced", reason: notInWorkspaceReason(absent) };
};

export const statusView = (state: EditorSyncState): StatusView | null => {
  switch (state.kind) {
    case "inactive":
      return null;
    case "checking":
      return {
        text: "checking extensions",
        tooltip: "Mend is comparing your local extensions with this workspace.",
        command: LOG_COMMAND,
      };
    case "sharedHome":
      return {
        text: "editor stays local · shared home",
        tooltip:
          "This workspace runs in a shared home, so Mend installs none of your extensions here.",
        command: LOG_COMMAND,
      };
    case "noLocalList":
      return {
        text: "extensions not synced · no local list",
        tooltip: "Open a local VS Code window once, so Mend can read your extensions.",
        command: LOG_COMMAND,
      };
    case "installing":
      return {
        text: `installing extensions ${state.current}/${state.total}`,
        tooltip: "Mend is installing your extensions in this workspace, one at a time.",
        command: LOG_COMMAND,
      };
    case "inSync":
      return {
        text: "extensions in sync",
        tooltip: [
          state.installed === 0
            ? "This workspace has your extensions."
            : `Mend installed ${plural(state.installed, "extension")} in this workspace.`,
          ...(state.staysLocal === 0
            ? []
            : [
                `${plural(state.staysLocal, "extension")} ${state.staysLocal === 1 ? "runs" : "run"} in your local window only.`,
              ]),
        ].join(" "),
        command: LOG_COMMAND,
      };
    case "notSynced":
      return {
        text: "extensions not synced · Sync",
        tooltip: `${state.reason} Click to try again; the log names each extension.`,
        command: SYNC_COMMAND,
      };
  }
};
