import { isPresent, type InstallResult, type Presence } from "./editor-extensions.js";
import type { Wanted } from "./editor-picks.js";

export type EditorSyncState =
  | { readonly kind: "inactive" }
  | { readonly kind: "checking" }
  | { readonly kind: "sharedHome" }
  /** Signed out, or no session this person can see: Mend cannot tell the window's project. */
  | { readonly kind: "noProject" }
  | { readonly kind: "installing"; readonly current: number; readonly total: number }
  | { readonly kind: "inSync"; readonly carried: number; readonly installed: number }
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
  wanted: ReadonlyArray<Wanted>,
  presence: Presence,
  results: ReadonlyArray<InstallResult>,
): EditorSyncState => {
  const absent = wanted.filter((ref) => !isPresent(presence, ref.id)).map((ref) => ref.id);
  return absent.length === 0
    ? {
        kind: "inSync",
        carried: wanted.length,
        installed: results.filter((result) => result.kind === "installed").length,
      }
    : { kind: "notSynced", reason: notInWorkspaceReason(absent) };
};

const inSyncTooltip = (carried: number, installed: number): string => {
  if (carried === 0) {
    return "The extensions you install here are carried to later sessions of this project.";
  }
  return installed === 0
    ? `This workspace has the ${plural(carried, "extension")} this project carries.`
    : `Mend installed ${plural(installed, "extension")} this project carries.`;
};

export const statusView = (state: EditorSyncState): StatusView | null => {
  switch (state.kind) {
    case "inactive":
      return null;
    case "checking":
      return {
        text: "checking extensions",
        tooltip: "Mend is comparing this project's extensions with this workspace.",
        command: LOG_COMMAND,
      };
    case "sharedHome":
      return {
        text: "editor stays local · shared home",
        tooltip: "This workspace runs in a shared home, so Mend installs no extensions here.",
        command: LOG_COMMAND,
      };
    case "noProject":
      return {
        text: "extensions not carried · not signed in",
        tooltip:
          "Mend cannot tell this window's project. Sign in to Mend; the extensions you install here are carried once it can.",
        command: LOG_COMMAND,
      };
    case "installing":
      return {
        text: `installing extensions ${state.current}/${state.total}`,
        tooltip: "Mend is installing this project's extensions in this workspace, one at a time.",
        command: LOG_COMMAND,
      };
    case "inSync":
      return {
        text: "extensions in sync",
        tooltip: inSyncTooltip(state.carried, state.installed),
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
