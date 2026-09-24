import {
  dotfilesRepositoriesEqual,
  type DotfilesManager,
  type DotfilesRepository,
} from "@mend/domain";

/**
 * Settings → Dotfiles, the repository form: what the inputs hold while editing. Text fields stay
 * raw strings (a half-typed branch is not a value yet); `repositoryFromDraft` is the one place they
 * become the saved shape, so the save and the dirty check can never disagree.
 */
export interface DotfilesRepositoryDraft {
  readonly url: string;
  readonly ref: string;
  readonly subdirectory: string;
  readonly manager: DotfilesManager;
  readonly bootstrap: boolean;
}

/**
 * The managers the workspace can apply a tree with, one plain line each. Auto's line is the rule
 * sealantd applies: stow only for a tree of package directories, since stow links directories and
 * would leave out the dot entries beside them.
 */
export const DOTFILES_MANAGER_OPTIONS: ReadonlyArray<{
  readonly value: DotfilesManager;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    detail: "Chezmoi for a chezmoi source, stow for package directories only, otherwise copy.",
  },
  { value: "copy", label: "Copy", detail: "Copies the tree into the home directory as it is." },
  {
    value: "stow",
    label: "Stow",
    detail: "Links each top-level directory into the home directory as a stow package.",
  },
  { value: "chezmoi", label: "Chezmoi", detail: "Runs chezmoi apply with the tree as its source." },
];

/** The form's starting point: the saved repository, or empty fields with the defaults. */
export const repositoryDraft = (saved: DotfilesRepository | null): DotfilesRepositoryDraft => ({
  url: saved?.url ?? "",
  ref: saved?.ref ?? "",
  subdirectory: saved?.subdirectory ?? "",
  manager: saved?.manager ?? "auto",
  bootstrap: saved?.bootstrap ?? true,
});

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** What a save sends: no URL clears the repository; empty branch or subdirectory is none. */
export const repositoryFromDraft = (draft: DotfilesRepositoryDraft): DotfilesRepository | null =>
  draft.url.trim() === ""
    ? null
    : {
        url: draft.url.trim(),
        ref: orNull(draft.ref),
        subdirectory: orNull(draft.subdirectory),
        manager: draft.manager,
        bootstrap: draft.bootstrap,
      };

/** Whether saving would change anything: compared as the save would send it, every field. */
export const repositoryDraftDirty = (
  saved: DotfilesRepository | null,
  draft: DotfilesRepositoryDraft,
): boolean => !dotfilesRepositoriesEqual(saved, repositoryFromDraft(draft));
