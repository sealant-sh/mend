import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FamilyWorkspaceImage } from "@mend/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadShellProfile, SHELL_PROFILE_FILES, shellProfileApplies } from "./shell-profile.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const loaded = async () => {
  const files = await Effect.runPromise(loadShellProfile);
  return new Map(files.map((file) => [file.path, text(file.bytes)]));
};

const fixtureImage = "mend-shell-profile-test:alpine-3.22";
type ProfileMode = "missing" | "modern" | "legacy-fzf" | "root";

// Absolute candidate paths belong to this disposable image, never to the host. The Docker
// client also gets an empty HOME: no saved contexts, registry credentials or remote daemon env.
const executeProfile = async (mode: ProfileMode) => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || uid === 0 || gid === undefined)
    throw new Error("shell-profile execution requires a nonroot Unix user and Docker");
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shell-profile-"));
  const identity = randomUUID();
  const name = `mend-shell-profile-${identity}`;
  let acquired = false;
  let creationAttempted = false;
  const docker = (args: ReadonlyArray<string>) =>
    spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: path.join(owned, "docker-home") },
    });
  const checked = (args: ReadonlyArray<string>) => {
    const result = docker(args);
    if (result.error !== undefined || result.status !== 0)
      throw new Error(
        `shell-profile fixture Docker command failed: ${result.error?.message ?? result.stderr.trim()}`,
      );
    return result;
  };
  let released = false;
  const release = () => {
    released = true;
    try {
      // A failed create can have committed despite a lost CLI answer. Recover only the exact
      // unique name and marker prepared by this fixture; never sweep other containers.
      if (creationAttempted) {
        const observed = docker([
          "container",
          "inspect",
          name,
          "--format",
          '{{.Id}} {{.Name}} {{index .Config.Labels "mend.shell-profile-test"}}',
        ]);
        if (observed.status === 0) {
          const match = /^([0-9a-f]{64}) (\/[^ ]+) ([^ ]+)$/.exec(observed.stdout.trim());
          const id = match?.[1];
          if (id === undefined || match?.[2] !== `/${name}` || match?.[3] !== identity)
            throw new Error("shell-profile container ownership does not match: left alone");
          checked(["rm", "-f", "-v", id]);
          expect(checked(["container", "ls", "-aq", "--filter", `id=${id}`]).stdout.trim()).toBe(
            "",
          );
        } else if (
          acquired ||
          observed.error !== undefined ||
          !/No such (?:object|container)/.test(observed.stderr)
        ) {
          throw new Error(
            `owned shell-profile container cleanup could not be confirmed: ${observed.error?.message ?? observed.stderr.trim()}`,
          );
        }
      }
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  };
  try {
    fs.mkdirSync(path.join(owned, "docker-home"));
    const prepared = checked([
      "image",
      "inspect",
      fixtureImage,
      "--format",
      '{{.Id}} {{index .Config.Labels "sh.sealant.mend.test"}}',
    ]).stdout.trim();
    const image = /^(sha256:[0-9a-f]{64}) shell-profile$/.exec(prepared)?.[1];
    if (image === undefined)
      throw new Error("build the declared shell-profile fixture image before tests");
    const directories = ["home", "bin", "root", "plugins", "auto", "syntax", "history", "fzf-docs"];
    for (const directory of directories) fs.mkdirSync(path.join(owned, directory));
    const files = await Effect.runPromise(loadShellProfile);
    for (const file of files) {
      const destination = path.join(owned, "home", file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
    }
    fs.writeFileSync(path.join(owned, "effects"), "");
    const write = (relative: string, contents: string, executable = false) => {
      const destination = path.join(owned, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, { mode: executable ? 0o755 : 0o644 });
    };
    const plugin = (location: string, effect: string, history = false) =>
      write(
        location,
        `typeset -ga MEND_PLUGIN_EFFECTS\nMEND_PLUGIN_EFFECTS+=(${effect})\n${history ? "history-substring-search-up() { :; }\nhistory-substring-search-down() { :; }\nzle -N history-substring-search-up\nzle -N history-substring-search-down\n" : ""}`,
      );
    if (mode === "modern" || mode === "root") {
      plugin("root/.nix-profile/share/zsh-autosuggestions/zsh-autosuggestions.zsh", "auto-root");
      plugin(
        "root/.nix-profile/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "syntax-root",
      );
      plugin(
        "root/.nix-profile/share/zsh-history-substring-search/zsh-history-substring-search.zsh",
        "history-root",
        true,
      );
    }
    if (mode === "modern") {
      plugin("auto/zsh-autosuggestions.zsh", "auto-first");
      plugin("plugins/zsh-autosuggestions/zsh-autosuggestions.zsh", "auto-arch");
      plugin("home/.nix-profile/share/zsh-autosuggestions/zsh-autosuggestions.zsh", "auto-home");
      plugin("plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh", "syntax-arch");
      plugin(
        "home/.nix-profile/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        "syntax-home",
      );
      plugin(
        "home/.nix-profile/share/zsh-history-substring-search/zsh-history-substring-search.zsh",
        "history-home",
        true,
      );
    }
    const program = (command: string, expected: string, output: string, succeeds = true) =>
      write(
        `bin/${command}`,
        `#!/bin/sh\nprintf '%s\\n' '${command}:'"$*" >> /fixture/effects\n[ "$*" = '${expected}' ] || exit 91\n${succeeds ? `printf '%s\\n' '${output}'` : "printf '%s\\n' 'synthetic unsupported option' >&2\nexit 2"}\n`,
        true,
      );
    if (mode === "modern") {
      program("fzf", "--zsh", "typeset -g MEND_FZF=modern");
      program("direnv", "hook zsh", "typeset -g MEND_DIRENV=loaded");
      program("starship", "init zsh", "typeset -g MEND_STARSHIP=loaded");
    }
    if (mode === "legacy-fzf") {
      program("fzf", "--zsh", "", false);
      write("fzf-docs/key-bindings.zsh", "typeset -g MEND_FZF=keybindings\n");
      write("fzf-docs/completion.zsh", 'MEND_FZF="${MEND_FZF},completion"\n');
    }
    const script = `print -r -- MEND_PROFILE_READY
print -r -- "history=$HISTSIZE:$SAVEHIST:$HISTFILE"
print -r -- "virtualenv=$VIRTUAL_ENV_DISABLE_PROMPT"
zstyle -a ':completion:*' menu menu
print -r -- "menu=$menu"
zstyle -s ':completion:*' matcher-list matcher
print -r -- "matcher=$matcher"
print -r -- "helper=\${+functions[_mend_source_first]}"
print -r -- "fzf-local=\${+_mend_fzf_zsh}"
print -r -- "optional=\${+commands[fzf]},\${+commands[direnv]},\${+commands[starship]}"
print -r -- "fzf=\${MEND_FZF:-0}"
print -r -- "direnv=\${MEND_DIRENV:-0}"
print -r -- "starship=\${MEND_STARSHIP:-0}"
print -r -- "plugins=\${(j:,:)MEND_PLUGIN_EFFECTS}"
bindkey '^[[A'`;
    const mounts = [
      [owned, "/fixture", false],
      [path.join(owned, "root"), "/root", true],
      [path.join(owned, "plugins"), "/usr/share/zsh/plugins", true],
      [path.join(owned, "auto"), "/usr/share/zsh-autosuggestions", true],
      [path.join(owned, "syntax"), "/usr/share/zsh-syntax-highlighting", true],
      [path.join(owned, "history"), "/usr/local/share/zsh-history-substring-search", true],
      [path.join(owned, "fzf-docs"), "/usr/share/doc/fzf/examples", true],
    ] as const;
    creationAttempted = true;
    const created = checked([
      "create",
      "--name",
      name,
      "--label",
      `mend.shell-profile-test=${identity}`,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      `${uid}:${gid}`,
      "--tty",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=16m",
      "--env",
      "HOME=/fixture/home",
      "--env",
      "ZDOTDIR=/fixture/home",
      "--env",
      "TERM=xterm-256color",
      "--env",
      "PATH=/fixture/bin:/usr/bin:/bin",
      "--workdir",
      "/fixture/home",
      ...mounts.flatMap(([source, target, readonly]) => [
        "--mount",
        `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
      ]),
      image,
      "/bin/zsh",
      "-d",
      "-i",
      "-c",
      script,
    ]).stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(created))
      throw new Error("Docker did not return the owned shell-profile container ID");
    acquired = true;
    const executed = checked(["start", "--attach", created]);
    const exit = checked(["inspect", created, "--format", "{{.State.ExitCode}}"]).stdout.trim();
    if (!/^\d+$/.test(exit)) throw new Error("Docker did not return a shell exit status");
    return {
      stdout: executed.stdout.replaceAll("\r\n", "\n"),
      stderr: executed.stderr,
      exitCode: Number(exit),
      effects: fs.readFileSync(path.join(owned, "effects"), "utf8"),
      historyDirectoryExists: fs.statSync(path.join(owned, "home/.local/state/zsh")).isDirectory(),
      deliveredBytesUnchanged: files.every((file) =>
        fs.readFileSync(path.join(owned, "home", file.path)).equals(Buffer.from(file.bytes)),
      ),
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "shell-profile startup and cleanup failed",
        { cause: error },
      );
      throw failure;
    }
    throw error;
  } finally {
    if (!released) release();
  }
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

  it.each(["missing", "modern", "legacy-fzf", "root"] as const)(
    "executes the delivered profile with %s optional integrations in an isolated zsh",
    async (mode) => {
      const result = await executeProfile(mode);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const plugins =
        mode === "modern"
          ? "auto-first,syntax-arch,history-home"
          : mode === "root"
            ? "auto-root,syntax-root,history-root"
            : "";
      const fzf =
        mode === "modern" ? "modern" : mode === "legacy-fzf" ? "keybindings,completion" : "0";
      const optional = mode === "modern" ? "1,1,1" : mode === "legacy-fzf" ? "1,0,0" : "0,0,0";
      const widget =
        mode === "modern" || mode === "root" ? "history-substring-search-up" : "up-line-or-history";
      expect(result.stdout).toBe(
        [
          "MEND_PROFILE_READY",
          "history=100000:100000:/fixture/home/.local/state/zsh/history",
          "virtualenv=1",
          "menu=select",
          "matcher=m:{a-z}={A-Za-z}",
          "helper=0",
          "fzf-local=0",
          `optional=${optional}`,
          `fzf=${fzf}`,
          `direnv=${mode === "modern" ? "loaded" : "0"}`,
          `starship=${mode === "modern" ? "loaded" : "0"}`,
          `plugins=${plugins}`,
          `"^[[A" ${widget}`,
          "",
        ].join("\n"),
      );
      expect(result.effects).toBe(
        mode === "modern"
          ? "fzf:--zsh\ndirenv:hook zsh\nstarship:init zsh\n"
          : mode === "legacy-fzf"
            ? "fzf:--zsh\n"
            : "",
      );
      expect(result.historyDirectoryExists).toBe(true);
      expect(result.deliveredBytesUnchanged).toBe(true);
    },
    30_000,
  );

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
