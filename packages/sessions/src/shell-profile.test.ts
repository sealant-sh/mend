import type { FamilyWorkspaceImage } from "@mend/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadShellProfile, SHELL_PROFILE_FILES, shellProfileApplies } from "./shell-profile.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const loaded = async () => {
  const files = await Effect.runPromise(loadShellProfile);
  return new Map(files.map((file) => [file.path, text(file.bytes)]));
};

describe("the default shell profile", () => {
  it("loads both files from the assets, keyed by where they land under $HOME", async () => {
    const files = await loaded();
    expect([...files.keys()]).toEqual([".zshrc", ".config/starship.toml"]);
    expect(SHELL_PROFILE_FILES.map((file) => file.home)).toEqual([...files.keys()]);
    const starship = files.get(".config/starship.toml") ?? "";
    expect(starship).toContain("\"$schema\" = 'https://starship.rs/config-schema.json'");
    expect(starship).toContain('format = "$directory$os$git_branch$git_status$nodejs$rust');
    // Byte for byte, alignment included: the formatter leaves `shell-profile/` alone.
    expect(starship).toContain('Ubuntu  = "󰕈"');
    expect(starship).toContain('vimcmd_symbol  = "[❮](blue)"');
  });

  it("sets the history, options and completion the owner's setup uses, and no aliases", async () => {
    const zshrc = (await loaded()).get(".zshrc") ?? "";
    for (const line of [
      "HISTSIZE=100000",
      "SAVEHIST=100000",
      'HISTFILE="$HOME/.local/state/zsh/history"',
      'mkdir -p "$HOME/.local/state/zsh"',
      "autoload -Uz compinit && compinit",
      "zstyle ':completion:*' menu select",
      "zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'",
      "export VIRTUAL_ENV_DISABLE_PROMPT=1",
      "bindkey '^[[A' history-substring-search-up",
      "bindkey '^[[B' history-substring-search-down",
    ]) {
      expect(zshrc).toContain(line);
    }
    for (const option of [
      "HIST_FCNTL_LOCK",
      "HIST_EXPIRE_DUPS_FIRST",
      "HIST_IGNORE_DUPS",
      "HIST_IGNORE_SPACE",
      "SHARE_HISTORY",
      "autocd",
      "NO_APPEND_HISTORY",
      "NO_EXTENDED_HISTORY",
      "NO_HIST_FIND_NO_DUPS",
      "NO_HIST_IGNORE_ALL_DUPS",
      "NO_HIST_SAVE_NO_DUPS",
      "NOBEEP",
      "NUMERIC_GLOB_SORT",
    ]) {
      expect(zshrc).toMatch(new RegExp(`^setopt .*\\b${option}\\b`, "m"));
    }
    expect(zshrc).not.toMatch(/^\s*alias\b/m);
  });

  it("guards every source and eval, so an image without a package still starts the shell", async () => {
    const zshrc = (await loaded()).get(".zshrc") ?? "";
    const lines = zshrc.split("\n");
    const loads = lines.filter((line) => /^\s*(source|eval|\.)\s/.test(line));
    expect(loads.length).toBeGreaterThan(0);
    // Nothing is sourced or evaluated at the top level: each sits inside an `if` or the helper.
    for (const line of loads) expect(line).toMatch(/^\s+/);
    for (const command of ["fzf", "direnv", "starship"]) {
      expect(zshrc).toContain(`if (( $+commands[${command}] )); then`);
    }
    // The helper sources only a readable file.
    expect(zshrc).toContain('if [[ -r "$candidate" ]]; then');
  });

  it("looks for each plugin on Fedora and Ubuntu, Arch and Nix", async () => {
    const zshrc = (await loaded()).get(".zshrc") ?? "";
    for (const plugin of [
      "zsh-autosuggestions",
      "zsh-syntax-highlighting",
      "zsh-history-substring-search",
    ]) {
      expect(zshrc).toContain(`/usr/share/zsh/plugins/${plugin}/${plugin}.zsh`);
      expect(zshrc).toContain(`"$HOME/.nix-profile/share/${plugin}/${plugin}.zsh"`);
      expect(zshrc).toContain(`/root/.nix-profile/share/${plugin}/${plugin}.zsh`);
    }
    expect(zshrc).toContain("/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh");
    expect(zshrc).toContain("/usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh");
    expect(zshrc).toContain(
      "/usr/local/share/zsh-history-substring-search/zsh-history-substring-search.zsh",
    );
  });

  it("applies to a zsh family image while the project leaves it on, and nowhere else", () => {
    const zsh: FamilyWorkspaceImage = {
      mode: "family",
      os: "arch",
      packages: [],
      shell: "zsh",
      services: { docker: false },
    };
    expect(shellProfileApplies({ defaultShellProfile: true }, { ...zsh, shell: "zsh" })).toBe(true);
    expect(shellProfileApplies({ defaultShellProfile: false }, { ...zsh, shell: "zsh" })).toBe(
      false,
    );
    expect(shellProfileApplies({ defaultShellProfile: true }, { ...zsh, shell: "bash" })).toBe(
      false,
    );
    expect(shellProfileApplies({ defaultShellProfile: true }, { ...zsh, shell: "fish" })).toBe(
      false,
    );
    expect(
      shellProfileApplies(
        { defaultShellProfile: true },
        {
          mode: "custom",
          baseImage: "ghcr.io/acme/base:1",
          packages: [],
          setupCommands: [],
          services: { docker: false },
        },
      ),
    ).toBe(false);
  });
});
