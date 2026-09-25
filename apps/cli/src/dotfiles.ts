import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Local dotfiles scanning for `mend dotfiles sync`. This runs on the machine that HAS the
 * files — the whole point: the Mend server may be a VPS whose home directory is a service
 * account's, so contents are captured here and streamed to the server's per-user dotfiles store.
 *
 * The candidate list mirrors the product's curated set (plain configuration only — never keys,
 * credential stores, or histories). The CLI stays dependency-light by design, so the list is
 * duplicated here rather than imported from a workspace package.
 */
export const DOTFILE_CANDIDATES: ReadonlyArray<{
  readonly group: string;
  readonly paths: ReadonlyArray<string>;
}> = [
  {
    group: "shell",
    paths: [
      ".zshrc",
      ".zshenv",
      ".zprofile",
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".aliases",
      ".config/fish/config.fish",
      ".config/starship.toml",
    ],
  },
  {
    group: "git",
    paths: [".gitconfig", ".gitignore_global", ".config/git/config", ".config/git/ignore"],
  },
  {
    group: "editors",
    paths: [".vimrc", ".ideavimrc", ".editorconfig", ".config/helix/config.toml"],
  },
  {
    group: "terminal",
    paths: [".tmux.conf", ".config/tmux/tmux.conf", ".inputrc", ".dir_colors"],
  },
  {
    group: "tools",
    paths: [
      ".ripgreprc",
      ".config/bat/config",
      ".config/lazygit/config.yml",
      ".config/mise/config.toml",
      ".config/atuin/config.toml",
      ".config/zellij/config.kdl",
    ],
  },
];

export interface ScannedDotfile {
  readonly path: string;
  readonly group: string;
  readonly bytes: number;
}

export interface SyncFile {
  readonly path: string;
  readonly contentsBase64: string;
  readonly mode: string;
}

/** The per-file cap the server enforces; checked here so a mistake fails before the upload. */
export const MAX_FILE_BYTES = 1024 * 1024;

const statFile = (home: string, relative: string): fs.Stats | null => {
  try {
    const stat = fs.statSync(path.join(home, relative));
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
};

/** Probe the curated candidates under `home`; only existing regular files appear. */
export const scanDotfileCandidates = (home: string): ReadonlyArray<ScannedDotfile> =>
  DOTFILE_CANDIDATES.flatMap(({ group, paths }) =>
    paths.flatMap((relative) => {
      const stat = statFile(home, relative);
      return stat === null ? [] : [{ path: relative, group, bytes: stat.size }];
    }),
  );

/**
 * A requested path as the `~`-relative path the server stores, or null when it is not under
 * `home`. Paths are read relative to home; an absolute path under home is taken too (a shell
 * expands `~/.zshrc` before the CLI sees it). Anything that climbs out of home is refused before
 * it is read, so no file from outside home is ever uploaded.
 */
export const homeRelativePath = (home: string, requested: string): string | null => {
  const relative = path.relative(home, path.resolve(home, requested));
  const outside =
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  return outside ? null : relative.split(path.sep).join("/");
};

/**
 * Read the selected paths for upload. Explicitly requested paths must exist (a typo should fail,
 * not silently sync nothing) and be under home; oversized files fail with the server's own rule.
 * Modes ride along so an executable script stays executable.
 */
export const readSyncFiles = (
  home: string,
  paths_: ReadonlyArray<string>,
): { readonly files: ReadonlyArray<SyncFile> } | { readonly error: string } => {
  const files: SyncFile[] = [];
  for (const requested of paths_) {
    const relative = homeRelativePath(home, requested);
    if (relative === null) {
      return {
        error: `${requested} is not under ${home} — only files in your home directory sync`,
      };
    }
    const stat = statFile(home, relative);
    if (stat === null) {
      return { error: `${relative} is not a file under ${home}` };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { error: `${relative} is over 1MB — dotfiles are text; trim the selection` };
    }
    files.push({
      path: relative,
      contentsBase64: fs.readFileSync(path.join(home, relative)).toString("base64"),
      // eslint-disable-next-line no-bitwise -- permission bits are the point
      mode: (stat.mode & 0o777).toString(8),
    });
  }
  return { files };
};

/** How the workspace applies a repository's tree; the server's `DotfilesManager`, duplicated. */
export const DOTFILES_MANAGERS = ["auto", "copy", "stow", "chezmoi"] as const;
export type DotfilesManager = (typeof DOTFILES_MANAGERS)[number];

/** The saved repository, as `PUT /dotfiles/repository` takes it and `GET /dotfiles` returns it. */
export interface DotfilesRepositoryBody {
  readonly url: string;
  readonly ref: string | null;
  readonly subdirectory: string | null;
  readonly manager: DotfilesManager;
  readonly bootstrap: boolean;
}

export type DotfilesRepoArgs =
  | { readonly kind: "set"; readonly repository: DotfilesRepositoryBody }
  | { readonly kind: "clear" }
  | { readonly kind: "error"; readonly error: string };

const VALUE_FLAGS = ["--ref", "--subdirectory", "--manager"] as const;

/**
 * `mend dotfiles repo <url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]`,
 * or `mend dotfiles repo --clear`. The command sets the whole repository: an option left out takes
 * its default (the remote's default branch, the repository root, auto, install.sh on), so what is
 * saved is exactly what was typed. The server validates the subdirectory and tries the clone.
 */
export const parseDotfilesRepoArgs = (args: ReadonlyArray<string>): DotfilesRepoArgs => {
  if (args.includes("--clear")) {
    return args.length === 1
      ? { kind: "clear" }
      : { kind: "error", error: "--clear takes no URL or other options" };
  }
  let url: string | null = null;
  const values = new Map<string, string>();
  let bootstrap = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--no-bootstrap") {
      bootstrap = false;
      continue;
    }
    const flag = VALUE_FLAGS.find((candidate) => candidate === arg);
    if (flag !== undefined) {
      const value = args[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        return { kind: "error", error: `${flag} needs a value` };
      }
      values.set(flag, value.trim());
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", error: `unknown flag ${arg}` };
    if (url !== null) return { kind: "error", error: "one repository URL only" };
    url = arg.trim();
  }
  if (url === null || url === "") {
    return { kind: "error", error: "name the repository URL, or --clear to remove it" };
  }
  const requested = values.get("--manager") ?? "auto";
  const manager = DOTFILES_MANAGERS.find((candidate) => candidate === requested);
  if (manager === undefined) {
    return { kind: "error", error: `--manager must be one of ${DOTFILES_MANAGERS.join(", ")}` };
  }
  return {
    kind: "set",
    repository: {
      url,
      ref: values.get("--ref") ?? null,
      subdirectory: values.get("--subdirectory") ?? null,
      manager,
      bootstrap,
    },
  };
};

/** The facts beside a repository's URL: `default branch · dots/ · manager auto · install.sh on`. */
export const dotfilesRepositoryFacts = (repository: DotfilesRepositoryBody): string =>
  [
    repository.ref ?? "default branch",
    ...(repository.subdirectory === null ? [] : [`${repository.subdirectory}/`]),
    `manager ${repository.manager}`,
    repository.bootstrap ? "install.sh on" : "install.sh off",
  ].join(" · ");
