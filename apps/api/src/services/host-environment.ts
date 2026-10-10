import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

export interface HostToolSuggestion {
  readonly executable: string;
  readonly kind: "package" | "service";
  readonly id: string;
}

export interface HostConfigSuggestion {
  readonly label: string;
  readonly path: string;
}

export interface HostEnvironmentSuggestions {
  readonly tools: ReadonlyArray<HostToolSuggestion>;
  readonly configs: ReadonlyArray<HostConfigSuggestion>;
}

export interface HostEnvironmentScanInput {
  readonly homeDirectory: string;
  readonly pathDirectories: ReadonlyArray<string>;
}

export class HostEnvironment extends Context.Service<
  HostEnvironment,
  {
    readonly scan: () => Effect.Effect<HostEnvironmentSuggestions>;
  }
>()("@mend/api/HostEnvironment") {}

const TOOL_PROBES: ReadonlyArray<{
  readonly executables: ReadonlyArray<string>;
  readonly kind: "package" | "service";
  readonly id: string;
}> = [
  { executables: ["docker"], kind: "service", id: "docker" },
  { executables: ["bat", "batcat"], kind: "package", id: "bat" },
  { executables: ["bun"], kind: "package", id: "bun" },
  { executables: ["curl"], kind: "package", id: "curl" },
  { executables: ["fd", "fdfind"], kind: "package", id: "fd" },
  { executables: ["fzf"], kind: "package", id: "fzf" },
  { executables: ["gh"], kind: "package", id: "github-cli" },
  { executables: ["jq"], kind: "package", id: "jq" },
  { executables: ["lazygit"], kind: "package", id: "lazygit" },
  { executables: ["mise"], kind: "package", id: "mise" },
  { executables: ["node"], kind: "package", id: "nodejs" },
  { executables: ["pnpm"], kind: "package", id: "pnpm" },
  { executables: ["python3", "python"], kind: "package", id: "python" },
  { executables: ["rg"], kind: "package", id: "ripgrep" },
  { executables: ["unzip"], kind: "package", id: "unzip" },
  { executables: ["uv"], kind: "package", id: "uv" },
];

const CONFIG_PROBES: ReadonlyArray<{ readonly label: string; readonly relativePath: string }> = [
  { label: "Git", relativePath: ".gitconfig" },
  { label: "Git", relativePath: ".config/git/config" },
  { label: "GitHub CLI", relativePath: ".config/gh/config.yml" },
  { label: "Lazygit", relativePath: ".config/lazygit/config.yml" },
  { label: "mise", relativePath: ".config/mise/config.toml" },
  { label: "Zsh", relativePath: ".zshrc" },
  { label: "Bash", relativePath: ".bashrc" },
  { label: "Fish", relativePath: ".config/fish/config.fish" },
  { label: "Neovim", relativePath: ".config/nvim" },
  { label: "tmux", relativePath: ".tmux.conf" },
  { label: "Starship", relativePath: ".config/starship.toml" },
];

const isExecutable = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read-only, allowlisted discovery for the machine running Mend. It never lists a directory and
 * never opens a file: only known executable names and known config paths are probed.
 */
export const scanHostEnvironment = async (
  input: HostEnvironmentScanInput = {
    homeDirectory: homedir(),
    pathDirectories: (process.env["PATH"] ?? "").split(delimiter).filter((part) => part !== ""),
  },
): Promise<HostEnvironmentSuggestions> => {
  const executableDirectories = [
    ...new Set([
      ...input.pathDirectories,
      join(input.homeDirectory, "bin"),
      join(input.homeDirectory, ".local", "bin"),
    ]),
  ];
  const tools: HostToolSuggestion[] = [];
  for (const probe of TOOL_PROBES) {
    let observedExecutable: string | undefined;
    for (const executable of probe.executables) {
      for (const directory of executableDirectories) {
        if (await isExecutable(join(directory, executable))) {
          observedExecutable = executable;
          break;
        }
      }
      if (observedExecutable !== undefined) break;
    }
    if (observedExecutable !== undefined) {
      tools.push({ executable: observedExecutable, kind: probe.kind, id: probe.id });
    }
  }

  const configs: HostConfigSuggestion[] = [];
  for (const probe of CONFIG_PROBES) {
    if (await exists(join(input.homeDirectory, probe.relativePath))) {
      configs.push({ label: probe.label, path: `~/${probe.relativePath}` });
    }
  }

  return { tools, configs };
};

export const HostEnvironmentLive: Layer.Layer<HostEnvironment> = Layer.succeed(HostEnvironment, {
  scan: () => Effect.promise(() => scanHostEnvironment()),
});
