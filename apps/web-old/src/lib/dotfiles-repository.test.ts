import { DotfilesManager, type DotfilesRepository } from "@mend/domain";
import { describe, expect, it } from "vitest";

import {
  DOTFILES_MANAGER_OPTIONS,
  repositoryDraft,
  repositoryDraftDirty,
  repositoryFromDraft,
} from "./dotfiles-repository.ts";

const saved: DotfilesRepository = {
  url: "https://github.com/me/dots.git",
  ref: null,
  subdirectory: "dots",
  manager: "auto",
  bootstrap: true,
};

describe("repositoryDraft", () => {
  it("starts from the saved repository, manager included", () => {
    expect(repositoryDraft({ ...saved, manager: "copy" })).toEqual({
      url: "https://github.com/me/dots.git",
      ref: "",
      subdirectory: "dots",
      manager: "copy",
      bootstrap: true,
    });
  });

  it("starts empty with the defaults when none is saved", () => {
    expect(repositoryDraft(null)).toEqual({
      url: "",
      ref: "",
      subdirectory: "",
      manager: "auto",
      bootstrap: true,
    });
  });
});

describe("repositoryFromDraft", () => {
  it("sends the chosen manager", () => {
    expect(repositoryFromDraft({ ...repositoryDraft(saved), manager: "stow" })).toEqual({
      ...saved,
      manager: "stow",
    });
  });

  it("trims text and turns an empty branch or subdirectory into none", () => {
    expect(
      repositoryFromDraft({
        url: "  git@github.com:me/dots.git ",
        ref: "  ",
        subdirectory: "",
        manager: "chezmoi",
        bootstrap: false,
      }),
    ).toEqual({
      url: "git@github.com:me/dots.git",
      ref: null,
      subdirectory: null,
      manager: "chezmoi",
      bootstrap: false,
    });
  });

  it("clears the repository when the URL is empty", () => {
    expect(repositoryFromDraft({ ...repositoryDraft(saved), url: " " })).toBeNull();
  });
});

describe("repositoryDraftDirty", () => {
  it("is clean for the draft of what is saved", () => {
    expect(repositoryDraftDirty(saved, repositoryDraft(saved))).toBe(false);
    expect(repositoryDraftDirty(null, repositoryDraft(null))).toBe(false);
  });

  it("is dirty when only the manager changed", () => {
    expect(repositoryDraftDirty(saved, { ...repositoryDraft(saved), manager: "copy" })).toBe(true);
  });

  it("ignores whitespace the save would trim", () => {
    expect(repositoryDraftDirty(saved, { ...repositoryDraft(saved), subdirectory: " dots " })).toBe(
      false,
    );
  });

  it("is dirty when an emptied URL would clear a saved repository", () => {
    expect(repositoryDraftDirty(saved, { ...repositoryDraft(saved), url: "" })).toBe(true);
  });
});

describe("DOTFILES_MANAGER_OPTIONS", () => {
  it("offers every manager once, auto first", () => {
    expect(DOTFILES_MANAGER_OPTIONS.map((option) => option.value)).toEqual([
      "auto",
      "copy",
      "stow",
      "chezmoi",
    ]);
  });

  it("offers every manager the server accepts", () => {
    expect(DOTFILES_MANAGER_OPTIONS.map((option) => option.value).toSorted()).toEqual(
      DotfilesManager.literals.toSorted(),
    );
  });
});
