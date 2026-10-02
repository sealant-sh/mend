import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PI_PROFILE_AGENT_PATH,
  PI_PROFILE_LOCAL_PACKAGES,
  PI_PROFILE_MAX_FILE_BYTES,
} from "@mend/domain/workbench";

/**
 * `mend connect pi`: read the person's pi setup from this machine, as a profile Mend delivers into
 * each pi session they start (pi-profile.ts in @mend/domain). Symlinks are followed, so a setup a
 * tool like Home Manager links in from elsewhere is read as the files it points at.
 *
 * A package `settings.json` names by local path is copied into the profile and the entry rewritten
 * to the copy; npm and git packages stay as declared, and the session installs them.
 */

/** pi's agent directory on this machine, as pi resolves it. */
export const piAgentDir = (): string =>
  process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");

type ProfileFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

export interface PiProfileScan {
  readonly agentDir: string;
  readonly files: ReadonlyArray<ProfileFile>;
  readonly bytes: number;
  readonly extensions: ReadonlyArray<string>;
  readonly themes: number;
  readonly prompts: number;
  /** Each declared package, and where a local one was copied from. */
  readonly packages: ReadonlyArray<{ readonly source: string; readonly from: string | null }>;
  /** The settings it carries, by name. */
  readonly settings: ReadonlyArray<string>;
  /** Files beside the resources: `package.json`, the lock, `mcp.json`, `keybindings.json`. */
  readonly beside: ReadonlyArray<string>;
  /** What is in the agent directory and stays on this machine, each with why when it helps. */
  readonly leftHere: ReadonlyArray<string>;
  /** Anything the scan could not carry, one line each. */
  readonly notes: ReadonlyArray<string>;
}

/** Directories pi resources live in, carried whole. */
const RESOURCE_DIRS = ["extensions", "themes", "prompts"] as const;

/** Files read from the agent directory, and where each goes in the profile. */
const BESIDE: ReadonlyArray<readonly [string, string]> = [
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["mcp.json", "root/mcp.json"],
  ["keybindings.json", "root/keybindings.json"],
];

/** Settings that are pi's record of this machine, not a choice. */
const MACHINE_SETTINGS = new Set(["lastChangelogVersion"]);

/** What stays here, and why when it is not obvious. */
const LEFT_HERE_WHY: Readonly<Record<string, string>> = {
  "auth.json": "auth.json (pi runs on your ChatGPT login: mend connect codex)",
  skills: "skills (mend skills push --dir <agent dir>/skills)",
  "AGENTS.md": "AGENTS.md (Mend writes its workspace note there)",
  npm: "npm (the session installs what settings.json declares)",
  git: "git (the session installs what settings.json declares)",
};

/** Never part of a profile, and not worth a line: pi's own state. */
const SILENT = new Set(["node_modules", "settings.json", ".gitignore"]);

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

const asProfileFile = (profilePath: string, bytes: Buffer): ProfileFile => {
  if (!bytes.includes(0)) {
    try {
      return { path: profilePath, encoding: "utf8", contents: utf8.decode(bytes) };
    } catch {
      // Not UTF-8: it travels as base64.
    }
  }
  return { path: profilePath, encoding: "base64", contents: bytes.toString("base64") };
};

/** Every file under `root`, following symlinks, as `[absolute, relative]`. */
const walk = (root: string, notes: Array<string>): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  const visit = (dir: string, rel: string) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    // A link back up the tree would never end.
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of fs.readdirSync(dir).toSorted()) {
      if (SKIPPED_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        notes.push(`${relPath}: a link to nothing, left out`);
        continue;
      }
      if (stat.isDirectory()) visit(abs, relPath);
      else if (stat.isFile()) found.push([abs, relPath]);
    }
  };
  visit(root, "");
  return found;
};

const isLocalSource = (source: string): boolean =>
  !/^(npm|git):/.test(source) &&
  !/^(https?|ssh|git):\/\//.test(source) &&
  !source.startsWith("git@");

const expandHome = (source: string): string =>
  source === "~" || source.startsWith("~/") ? path.join(os.homedir(), source.slice(1)) : source;

/** A directory name for a bundled local package: its package name's last part, else its own. */
const bundleName = (abs: string): string => {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf8"));
    if (manifest !== null && typeof manifest === "object" && "name" in manifest) {
      const name = manifest.name;
      if (typeof name === "string" && name !== "") return name.split("/").at(-1) ?? name;
    }
  } catch {
    // No manifest: the directory's own name.
  }
  // A Nix store path starts with its hash: `/nix/store/<hash>-pi-usage-0.60.3`.
  return path.basename(abs).replace(/^[0-9a-z]{32}-/, "");
};

/** pi provides these to extensions itself; an installed copy only shadows its own. */
const HOST_PROVIDED = (name: string): boolean =>
  name.startsWith("@earendil-works/") || name === "typebox";

/** The version a package directory says it is, or null. */
const versionOf = (dir: string): string | null => {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return manifest !== null &&
      typeof manifest === "object" &&
      "version" in manifest &&
      typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    return null;
  }
};

/** Every package installed at the top of `nodeModules`, at the version installed. */
const installedPackages = (nodeModules: string): Record<string, string> => {
  const names = fs.readdirSync(nodeModules).flatMap((entry) => {
    if (entry.startsWith(".")) return [];
    if (!entry.startsWith("@")) return [entry];
    try {
      return fs.readdirSync(path.join(nodeModules, entry)).map((scoped) => `${entry}/${scoped}`);
    } catch {
      return [];
    }
  });
  const dependencies: Record<string, string> = {};
  for (const name of names.toSorted()) {
    if (HOST_PROVIDED(name)) continue;
    const version = versionOf(path.join(nodeModules, name));
    if (version !== null) dependencies[name] = version;
  }
  return dependencies;
};

/** Read the pi setup in `agentDir` as a profile. */
export const scanPiProfile = (agentDir: string): PiProfileScan | { readonly error: string } => {
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    return { error: `no pi agent directory at ${agentDir}; run pi once, or pass --dir` };
  }
  const notes: Array<string> = [];
  const files: Array<ProfileFile> = [];
  const add = (abs: string, profilePath: string) => {
    const bytes = fs.readFileSync(abs);
    if (bytes.byteLength > PI_PROFILE_MAX_FILE_BYTES) {
      notes.push(`${profilePath}: over ${PI_PROFILE_MAX_FILE_BYTES / (1024 * 1024)} MB, left out`);
      return;
    }
    files.push(asProfileFile(profilePath, bytes));
  };

  for (const dir of RESOURCE_DIRS) {
    const abs = path.join(agentDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const [file, rel] of walk(abs, notes)) add(file, `${dir}/${rel}`);
  }

  const beside: Array<string> = [];
  for (const [name, profilePath] of BESIDE) {
    const abs = path.join(agentDir, name);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    add(abs, profilePath);
    beside.push(name);
  }

  // Extensions that import from a node_modules beside them, with no package.json saying what it
  // holds (Home Manager links one in): the profile names exactly what is installed there.
  const nodeModules = path.join(agentDir, "node_modules");
  if (!beside.includes("package.json") && fs.existsSync(nodeModules)) {
    const dependencies = installedPackages(nodeModules);
    const count = Object.keys(dependencies).length;
    if (count > 0) {
      files.push({
        path: "package.json",
        encoding: "utf8",
        contents: `${JSON.stringify(
          {
            name: "pi-agent-dependencies",
            private: true,
            description: "Written by mend connect pi from the node_modules beside your extensions",
            dependencies,
          },
          null,
          2,
        )}\n`,
      });
      beside.push(`package.json (written from node_modules: ${count} packages)`);
    }
  }

  const packages: Array<{ readonly source: string; readonly from: string | null }> = [];
  let settingNames: ReadonlyArray<string> = [];
  const settingsPath = path.join(agentDir, "settings.json");
  if (fs.existsSync(settingsPath)) {
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      settings = null;
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      return { error: `${settingsPath} is not a JSON object; fix it or move it aside first` };
    }
    const carried: Record<string, unknown> = {};
    const names = new Set<string>();
    for (const [key, value] of Object.entries(settings)) {
      if (MACHINE_SETTINGS.has(key)) continue;
      if (key !== "packages") {
        carried[key] = value;
        continue;
      }
      if (!Array.isArray(value)) {
        notes.push("settings.json: packages is not a list, left out");
        continue;
      }
      const declared: Array<unknown> = [];
      for (const entry of value) {
        const source =
          typeof entry === "string"
            ? entry
            : entry !== null && typeof entry === "object" && "source" in entry
              ? entry.source
              : null;
        if (typeof source !== "string") {
          notes.push(`settings.json: a package entry without a source, left out`);
          continue;
        }
        if (!isLocalSource(source)) {
          declared.push(entry);
          packages.push({ source, from: null });
          continue;
        }
        const abs = path.resolve(agentDir, expandHome(source));
        if (!fs.existsSync(abs)) {
          notes.push(`package ${source}: not on this machine, left out`);
          continue;
        }
        let name = bundleName(abs);
        for (let n = 2; names.has(name); n += 1) name = `${bundleName(abs)}-${n}`;
        names.add(name);
        const bundled = `${PI_PROFILE_LOCAL_PACKAGES}/${name}`;
        if (fs.statSync(abs).isDirectory()) {
          for (const [file, rel] of walk(abs, notes)) add(file, `${bundled}/${rel}`);
        } else {
          add(abs, `${bundled}/${path.basename(abs)}`);
        }
        const rewritten = `./${PI_PROFILE_AGENT_PATH}/${bundled}${
          fs.statSync(abs).isDirectory() ? "" : `/${path.basename(abs)}`
        }`;
        declared.push(
          entry !== null && typeof entry === "object" ? { ...entry, source: rewritten } : rewritten,
        );
        packages.push({ source: rewritten, from: source });
      }
      carried["packages"] = declared;
    }
    settingNames = Object.keys(carried).filter((key) => key !== "packages");
    files.push({
      path: "settings.json",
      encoding: "utf8",
      contents: `${JSON.stringify(carried, null, 2)}\n`,
    });
  }

  // An MCP server whose command is an absolute path off this machine's agent dir will not exist in
  // a workspace: say so now rather than leave pi to find out.
  const mcpPath = path.join(agentDir, "mcp.json");
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp: unknown = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      const servers =
        mcp !== null && typeof mcp === "object" && "mcpServers" in mcp ? mcp.mcpServers : null;
      if (servers !== null && typeof servers === "object") {
        for (const [name, server] of Object.entries(servers)) {
          const command =
            server !== null && typeof server === "object" && "command" in server
              ? server.command
              : null;
          if (typeof command === "string" && path.isAbsolute(command)) {
            notes.push(
              `mcp.json: server ${name} runs ${command}, a path on this machine a session may not have`,
            );
          }
        }
      }
    } catch {
      notes.push("mcp.json: not JSON; sent as it is");
    }
  }

  const carriedTop = new Set<string>([...RESOURCE_DIRS, ...BESIDE.map(([name]) => name)]);
  const leftHere = fs
    .readdirSync(agentDir)
    .toSorted()
    .filter((name) => !carriedTop.has(name) && !SILENT.has(name))
    .map((name) => LEFT_HERE_WHY[name] ?? name);

  return {
    agentDir,
    files,
    bytes: files.reduce(
      (sum, file) =>
        sum +
        (file.encoding === "utf8"
          ? Buffer.byteLength(file.contents, "utf8")
          : Buffer.from(file.contents, "base64").byteLength),
      0,
    ),
    extensions: [
      ...new Set(
        files.flatMap((file) => {
          const [top, name] = file.path.split("/");
          return top === "extensions" && name !== undefined ? [name] : [];
        }),
      ),
    ],
    themes: files.filter((file) => file.path.startsWith("themes/") && file.path.endsWith(".json"))
      .length,
    prompts: files.filter((file) => file.path.startsWith("prompts/") && file.path.endsWith(".md"))
      .length,
    packages,
    settings: settingNames,
    beside,
    leftHere,
    notes,
  };
};

const megabytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const list = (items: ReadonlyArray<string>) => (items.length === 0 ? "none" : items.join(", "));

/** What `mend connect pi` prints before it sends anything: what goes, and what stays. */
export const piProfileLines = (scan: PiProfileScan): ReadonlyArray<string> => {
  return [
    `pi profile · ${scan.agentDir} · ${scan.files.length} files · ${megabytes(scan.bytes)}`,
    `  extensions  ${scan.extensions.length === 0 ? "none" : `${scan.extensions.length} · ${list(scan.extensions)}`}`,
    `  themes      ${scan.themes}`,
    `  prompts     ${scan.prompts}`,
    `  packages    ${list(
      scan.packages.map((entry) =>
        entry.from === null ? entry.source : `${entry.from} (copied in)`,
      ),
    )}`,
    `  settings    ${list(scan.settings)}`,
    ...(scan.beside.length === 0
      ? []
      : [
          `  also        ${list(
            scan.beside.map((name) =>
              name === "mcp.json" ? "mcp.json (as it is, with any keys in it)" : name,
            ),
          )}`,
        ]),
    ...(scan.leftHere.length === 0 ? [] : [`  left here   ${list(scan.leftHere)}`]),
    ...scan.notes.map((note) => `  ! ${note}`),
  ];
};
