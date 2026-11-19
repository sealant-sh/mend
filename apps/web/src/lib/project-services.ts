/**
 * Settings → a project → Services (route PR 54, Doop "Settings · Project · checkout-api ·
 * Services"): the project's Services as `.mend/mend.toml` declares them, read-only, and the fixed
 * preview address with the worktree it shows. Pure, so each sentence and the dialog's choices are
 * tested without a server.
 *
 * Recipes saved in the database and their "Shadowed" rows are gone (ruling D8, docs/adr/0025):
 * Services come only from the file.
 */

import type { ProjectPreviewView } from "@mend/api-contracts";

import { LIVE_STATES } from "./project-sessions.ts";
import { STATUS_WORDS } from "./session-sheet.ts";

/** A fixed preview address without its scheme, as the frames write it. */
export const previewHost = (url: string): string =>
  url.replace(/^[a-z]+:\/\//, "").replace(/\/$/, "");

/** One worktree the fixed preview can show, or the default branch's own worktree. */
export type PreviewChoice =
  | { readonly kind: "default"; readonly branch: string }
  | {
      readonly kind: "worktree";
      readonly id: string;
      /** The newest session's name in it, else the worktree's name. */
      readonly label: string;
      readonly branch: string;
      /** Who started that session, and where it stands: "Ada Lovelace · Running". */
      readonly facts: string | null;
    };

interface ChoiceInput {
  readonly defaultBranch: string;
  readonly worktrees: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly branch: string;
    readonly updatedAt: Date;
  }>;
  readonly sessions: ReadonlyArray<{
    readonly worktreeId: string;
    /** The session's name, when it has one. */
    readonly label: string | null;
    readonly status: keyof typeof STATUS_WORDS;
    readonly ownerUserId: string | null;
    readonly updatedAt: Date;
  }>;
  readonly members: ReadonlyArray<{ readonly userId: string; readonly name: string }>;
}

/**
 * What Change worktree… offers: the project's worktrees, those with a live session first and then
 * the most recently changed, each named by its newest session, then the default branch.
 */
export const previewChoices = (input: ChoiceInput): ReadonlyArray<PreviewChoice> => {
  const rows = input.worktrees.map((worktree) => {
    const newest = input.sessions
      .filter((session) => session.worktreeId === worktree.id)
      .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const owner =
      newest === undefined
        ? undefined
        : input.members.find((member) => member.userId === newest.ownerUserId)?.name;
    const title = newest?.label?.trim() ?? "";
    return {
      live: newest !== undefined && LIVE_STATES.has(newest.status),
      updatedAt: worktree.updatedAt,
      choice: {
        kind: "worktree",
        id: worktree.id,
        label: title === "" ? worktree.name : title,
        branch: worktree.branch,
        facts:
          newest === undefined
            ? null
            : [owner, STATUS_WORDS[newest.status]].filter((part) => part !== undefined).join(" · "),
      } satisfies PreviewChoice,
    };
  });
  return [
    ...rows
      .toSorted(
        (a, b) => Number(b.live) - Number(a.live) || b.updatedAt.getTime() - a.updatedAt.getTime(),
      )
      .map((row) => row.choice),
    { kind: "default", branch: input.defaultBranch },
  ];
};

/** The choice the fixed preview shows now: a worktree's id, "default", or null before one is picked. */
export const currentChoice = (read: ProjectPreviewView): string | null => {
  if (read.fixed === null) return null;
  if (read.fixed.targetMode === "default") return "default";
  return read.target?.id ?? null;
};

/** How the fixed address names what it shows, in a sentence: `the worktree of "Fix flaky retry"`. */
const shownWords = (read: ProjectPreviewView, choices: ReadonlyArray<PreviewChoice>): string => {
  const current = currentChoice(read);
  if (current === "default") {
    const branch =
      choices.find((choice) => choice.kind === "default")?.branch ?? "the default branch";
    return `the default branch, ${branch}, in a worktree Mend keeps for the preview`;
  }
  const choice = choices.find((entry) => entry.kind === "worktree" && entry.id === current);
  if (choice?.kind === "worktree") return `the worktree of "${choice.label}"`;
  return `the worktree ${read.target?.name ?? read.target?.branch ?? "it was set to"}`;
};

/** The Fixed preview address row's description, for whatever state the project's preview is in. */
export const previewLine = (
  read: ProjectPreviewView,
  choices: ReadonlyArray<PreviewChoice>,
): string => {
  const each = "Each session also has its own preview address.";
  if (!read.configured) {
    return `The project has no fixed preview address. To give it one, name an HTTP Service in the default branch's .mend/mend.toml with [preview] service = "<name>" and fixed = true. ${each}`;
  }
  const service = read.fixed?.preview.serviceName;
  if (read.url === null || read.fixed === null || currentChoice(read) === null) {
    return `Mend gives the project its fixed address when someone picks a worktree for it to show. ${each}`;
  }
  return `${previewHost(read.url)} always shows ${service ?? "the preview Service"} from ${shownWords(read, choices)}. ${each}`;
};

/** The toast once the address shows another worktree. */
export const changedWords = (choice: PreviewChoice): string =>
  choice.kind === "default"
    ? `The preview address now shows the default branch, ${choice.branch}.`
    : `The preview address now shows "${choice.label}".`;
