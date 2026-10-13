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

const resolvedHome = (home: string): string | null => {
  try {
    const resolved = fs.realpathSync(home);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
};

const withinHome = (home: string, target: string): boolean => {
  const relative = path.relative(home, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

type ContainedFile =
  | { readonly kind: "file"; readonly resolved: string; readonly stat: fs.Stats }
  | { readonly kind: "outside" }
  | { readonly kind: "missing" };

/** Check every logical parent, so an outside directory cannot be hidden by a file link back in. */
const containedFile = (home: string, relative: string): ContainedFile => {
  try {
    let resolved = home;
    for (const segment of relative.split("/")) {
      resolved = fs.realpathSync(path.join(resolved, segment));
      if (!withinHome(home, resolved)) return { kind: "outside" };
    }
    // A replacement symlink between realpath and lstat is not a checked regular file.
    const stat = fs.lstatSync(resolved);
    return stat.isFile() ? { kind: "file", resolved, stat } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
};

/** Probe curated regular files whose resolved targets and parents stay within the resolved home. */
export const scanDotfileCandidates = (home: string): ReadonlyArray<ScannedDotfile> => {
  const root = resolvedHome(home);
  if (root === null) return [];
  return DOTFILE_CANDIDATES.flatMap(({ group, paths }) =>
    paths.flatMap((relative) => {
      const file = containedFile(root, relative);
      return file.kind === "file" ? [{ path: relative, group, bytes: file.stat.size }] : [];
    }),
  );
};

/**
 * A requested path as the `~`-relative path the server stores, or null when it is not under
 * `home`. Paths are read relative to home; an absolute path under home is taken too (a shell
 * expands `~/.zshrc` before the CLI sees it). Anything that climbs out of home is refused before
 * it is read. This normalization is lexical; scanning and reading also check resolved containment.
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
 * File links and every logical parent must resolve inside the resolved home. Reads hold the
 * checked regular-file descriptor and remain bounded; the mutable tree is not an atomic snapshot.
 * Modes ride along so an executable script stays executable.
 */
export const readSyncFiles = (
  home: string,
  paths_: ReadonlyArray<string>,
): { readonly files: ReadonlyArray<SyncFile> } | { readonly error: string } => {
  const files: SyncFile[] = [];
  if (paths_.length === 0) return { files };
  const root = resolvedHome(home);
  if (root === null) return { error: `${home} is not a readable home directory` };
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  // POSIX-only flags are absent on Windows. Resolved containment and descriptor checks still
  // apply there; they do not promise atomic protection from a concurrently replaced host tree.
  const flags =
    fs.constants.O_RDONLY |
    (typeof noFollow === "number" ? noFollow : 0) |
    (typeof nonBlock === "number" ? nonBlock : 0);
  const outside = (relative: string) => ({
    error: `${relative} resolves outside your home directory — its target and parent directories must stay under ${home}`,
  });
  for (const requested of paths_) {
    const relative = homeRelativePath(home, requested);
    if (relative === null) {
      return {
        error: `${requested} is not under ${home} — only files in your home directory sync`,
      };
    }
    const file = containedFile(root, relative);
    if (file.kind === "outside") return outside(relative);
    if (file.kind === "missing") {
      return { error: `${relative} is not a file under ${home}` };
    }
    if (file.stat.size > MAX_FILE_BYTES) {
      return { error: `${relative} is over 1MB — dotfiles are text; trim the selection` };
    }
    try {
      const fd = fs.openSync(file.resolved, flags);
      try {
        const opened = fs.fstatSync(fd);
        const rechecked = containedFile(root, relative);
        if (rechecked.kind === "outside") return outside(relative);
        if (
          !opened.isFile() ||
          rechecked.kind !== "file" ||
          opened.dev !== file.stat.dev ||
          opened.ino !== file.stat.ino ||
          opened.dev !== rechecked.stat.dev ||
          opened.ino !== rechecked.stat.ino ||
          rechecked.resolved !== file.resolved
        ) {
          return { error: `${relative} changed while preparing dotfiles sync — try again` };
        }
        // Read from the checked descriptor, not the selectable symlink again. Growth cannot turn
        // the size check into an unlimited read; this is not an atomic snapshot of a mutable tree.
        const contents = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < contents.length) {
          const read = fs.readSync(fd, contents, length, contents.length - length, null);
          if (read === 0) break;
          length += read;
        }
        if (length > MAX_FILE_BYTES)
          return { error: `${relative} is over 1MB — dotfiles are text; trim the selection` };
        files.push({
          path: relative,
          contentsBase64: contents.subarray(0, length).toString("base64"),
          // eslint-disable-next-line no-bitwise -- permission bits are the point
          mode: (opened.mode & 0o777).toString(8),
        });
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return {
        error: `${relative} could not be read under ${home} — check permissions or try again`,
      };
    }
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
