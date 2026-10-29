/**
 * `mend service init` — the mend.toml scaffolder (docs/SESSION-SERVICES.md).
 * Static suggestion, not detection: an offline read of manifests the project
 * already ships (package.json scripts, compose files), producing a proposal
 * the user confirms and commits. Nothing runs; nothing is observed.
 *
 * Pure functions here; the command in main.ts does the I/O.
 */

export interface ServiceProposal {
  readonly name: string;
  readonly command: string;
  readonly port: number;
  /** Declared transport; compose "N:N/udp" mappings propose udp. */
  readonly protocol: "tcp" | "udp";
  /** True when the port came from a tool default, not the manifest. */
  readonly guessed: boolean;
  /** `http` for a known dev server: something to open in a browser, so a preview. */
  readonly browserScheme: "http" | null;
  /** A workspace package's directory, repository-relative; null runs at the root. */
  readonly cwd: string | null;
  /** `docker` for a compose service: Docker publishes its port (ADR 0017). */
  readonly address: "loopback" | "docker";
  /** Where the proposal came from — lands in the file as a comment. */
  readonly source: string;
}

/** Scripts that mean "a server" in practice; dev first, the rest as extras. */
const SERVER_SCRIPTS = ["dev", "start", "serve", "preview"];

/** Dev servers that serve a page, with their default port for when the script names none. */
const DEV_SERVERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bvite\b(?!.*build)/, 5173],
  [/\bnext dev\b/, 3000],
  [/\bnuxt\b/, 3000],
  [/\bastro dev\b/, 4321],
  [/\bremix\b/, 3000],
];

const devServerPort = (script: string): number | null =>
  DEV_SERVERS.find(([pattern]) => pattern.test(script))?.[1] ?? null;

const portFromScript = (script: string): { port: number; guessed: boolean } | null => {
  const explicit =
    /(?:--port[= ]|(?<![\w-])-p[= ])(\d{2,5})/.exec(script) ?? /\bPORT=(\d{2,5})/.exec(script);
  if (explicit?.[1] !== undefined) {
    const port = Number(explicit[1]);
    if (port >= 1 && port <= 65535) return { port, guessed: false };
  }
  const guessed = devServerPort(script);
  return guessed === null ? null : { port: guessed, guessed: true };
};

const packageManagerOf = (lockfiles: ReadonlyArray<string>): string => {
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock")) return "bun";
  return "npm";
};

/** A folder or compose service's name as a recipe name (`RECIPE_NAME`); null when none is left. */
export const recipeNameOf = (raw: string): string | null => {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return name === "" ? null : name;
};

/** Proposals from package.json scripts. `files` = names present in the repo root. */
export const proposeFromPackageJson = (
  packageJsonText: string,
  rootFiles: ReadonlyArray<string>,
): ReadonlyArray<ServiceProposal> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];

  const pm = packageManagerOf(rootFiles);
  const proposals: ServiceProposal[] = [];
  for (const scriptName of SERVER_SCRIPTS) {
    const script = scripts[scriptName];
    if (typeof script !== "string") continue;
    const port = portFromScript(script);
    if (port === null) continue; // no port, no Service — the user can add one by hand
    proposals.push({
      name: scriptName === "dev" ? "web" : scriptName,
      command: `${pm} run ${scriptName}`,
      port: port.port,
      protocol: "tcp",
      guessed: port.guessed,
      browserScheme: devServerPort(script) === null ? null : "http",
      cwd: null,
      address: "loopback",
      source: `package.json "${scriptName}": ${script}`,
    });
    break; // one entry from scripts — the first server-ish one wins
  }
  return proposals;
};

/**
 * Proposals from a compose file: every service with a published port becomes
 * `docker compose up <name>` at the HOST side of the first mapping — that is
 * where the workspace's docker sidecar publishes it.
 */
export const proposeFromCompose = (composeText: string): ReadonlyArray<ServiceProposal> => {
  // Deliberately narrow YAML reading: top-level `services:`, two-space
  // indented names, `ports:` entries as "- host:container". A full YAML
  // parser is not worth a dependency for a suggestion.
  const proposals: ServiceProposal[] = [];
  const lines = composeText.split("\n");
  let inServices = false;
  let current: string | null = null;
  let inPorts = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) {
      inServices = false; // left the services block
    }
    if (!inServices) continue;
    const serviceHead = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (serviceHead?.[1] !== undefined) {
      current = serviceHead[1];
      inPorts = false;
      continue;
    }
    if (current === null) continue;
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      const mapping =
        /^\s+-\s+["']?(\d{2,5}):/.exec(line) ??
        /^\s+-\s+["']?\$\{[A-Z_a-z0-9]+:-(\d{2,5})\}:/.exec(line) ??
        /^\s+-\s+["']?(\d{2,5})["']?\s*$/.exec(line);
      if (mapping?.[1] !== undefined) {
        const port = Number(mapping[1]);
        const protocol = /\/udp["']?\s*$/.test(line) ? ("udp" as const) : ("tcp" as const);
        const name = recipeNameOf(current);
        if (
          name !== null &&
          port >= 1 &&
          port <= 65535 &&
          !proposals.some((p) => p.name === name)
        ) {
          proposals.push({
            name,
            command: `docker compose up ${current}`,
            port,
            protocol,
            guessed: false,
            browserScheme: null,
            cwd: null,
            // Docker publishes a UDP port too, but only TCP has a port-scoped dial (ADR 0017).
            address: protocol === "udp" ? "loopback" : "docker",
            source: `compose service "${current}" publishes :${mapping[1]}${protocol === "udp" ? "/udp" : ""}`,
          });
        }
        inPorts = false; // first mapping wins
        continue;
      }
      if (!/^\s+-/.test(line)) inPorts = false;
    }
  }
  return proposals;
};

/** Any compose flavor counts: compose.yaml, docker-compose.yml, compose.dev.yaml… */
export const isComposeFile = (name: string): boolean =>
  /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/.test(name);

/** Workspace dir globs from pnpm-workspace.yaml / package.json "workspaces". Single-level only. */
export const workspaceGlobs = (
  pnpmWorkspaceText: string | null,
  packageJsonText: string | null,
): ReadonlyArray<string> => {
  const globs: string[] = [];
  if (pnpmWorkspaceText !== null) {
    let inPackages = false;
    for (const line of pnpmWorkspaceText.split("\n")) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      if (!inPackages) continue;
      const entry = /^\s+-\s+["']?([^"'#]+?)["']?\s*$/.exec(line);
      if (entry?.[1] !== undefined && !entry[1].startsWith("!")) globs.push(entry[1].trim());
    }
  }
  if (packageJsonText !== null) {
    try {
      const parsed = JSON.parse(packageJsonText) as { workspaces?: unknown };
      if (Array.isArray(parsed.workspaces)) {
        globs.push(...parsed.workspaces.filter((g): g is string => typeof g === "string"));
      }
    } catch {
      // no workspaces to read
    }
  }
  return globs;
};

/**
 * A workspace package's proposal: named after its folder, run with the package manager in that
 * folder (`cwd`), so a root dev script's fan-out never starts.
 */
export const proposeFromWorkspacePackage = (
  dir: string,
  packageJsonText: string,
  rootFiles: ReadonlyArray<string>,
): ReadonlyArray<ServiceProposal> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  const pm = packageManagerOf(rootFiles);
  const name = recipeNameOf(dir.split("/").at(-1) ?? dir);
  if (name === null) return [];
  for (const scriptName of SERVER_SCRIPTS) {
    const script = scripts[scriptName];
    if (typeof script !== "string") continue;
    const port = portFromScript(script);
    if (port === null) continue;
    return [
      {
        name,
        command: `${pm} run ${scriptName}`,
        port: port.port,
        protocol: "tcp",
        guessed: port.guessed,
        browserScheme: devServerPort(script) === null ? null : "http",
        cwd: dir,
        address: "loopback",
        source: `${dir}/package.json "${scriptName}": ${script}`,
      },
    ];
  }
  return [];
};

/**
 * The proposal as the file the user will commit, with a `[preview]` when exactly one proposal is
 * something to open in a browser.
 */
export const renderMendToml = (proposals: ReadonlyArray<ServiceProposal>): string => {
  const blocks = proposals.map((proposal) =>
    [
      `# ${proposal.source.replace(/[\r\n]+/g, " ")}`,
      // A name with a dot is one key only when quoted.
      `[service.${/^[a-z0-9_-]+$/.test(proposal.name) ? proposal.name : JSON.stringify(proposal.name)}]`,
      `command = ${JSON.stringify(proposal.command)}`,
      proposal.guessed ? `port = ${proposal.port} # guessed — verify` : `port = ${proposal.port}`,
      ...(proposal.protocol === "udp" ? [`protocol = "udp"`] : []),
      ...(proposal.browserScheme === null
        ? []
        : [`browserScheme = ${JSON.stringify(proposal.browserScheme)}`]),
      ...(proposal.cwd === null ? [] : [`cwd = ${JSON.stringify(proposal.cwd)}`]),
      ...(proposal.address === "docker" ? [`address = "docker"`] : []),
    ].join("\n"),
  );
  const browsers = proposals.filter((proposal) => proposal.browserScheme !== null);
  const preview =
    browsers.length === 1 && browsers[0] !== undefined
      ? [`[preview]\nservice = ${JSON.stringify(browsers[0].name)}`]
      : [];
  return `${[...blocks, ...preview].join("\n\n")}\n`;
};

export interface RepositoryManifests {
  readonly rootFiles: ReadonlyArray<string>;
  readonly packageJson: string | null;
  readonly workspacePackages: ReadonlyArray<{ readonly dir: string; readonly packageJson: string }>;
  readonly composeFiles: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}

/** Every proposal; on a name two of them share, the first wins. */
export const proposeForRepository = (
  manifests: RepositoryManifests,
): ReadonlyArray<ServiceProposal> => {
  const proposals: ServiceProposal[] = [];
  const add = (proposal: ServiceProposal) => {
    if (!proposals.some((existing) => existing.name === proposal.name)) proposals.push(proposal);
  };
  if (manifests.packageJson !== null) {
    proposeFromPackageJson(manifests.packageJson, manifests.rootFiles).forEach(add);
  }
  for (const { dir, packageJson } of manifests.workspacePackages) {
    proposeFromWorkspacePackage(dir, packageJson, manifests.rootFiles).forEach(add);
  }
  for (const { name, text } of manifests.composeFiles.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const isDefault = name === "compose.yaml" || name === "docker-compose.yml";
    for (const proposal of proposeFromCompose(text)) {
      add({
        ...proposal,
        command: isDefault
          ? proposal.command
          : proposal.command.replace("docker compose ", `docker compose -f ${name} `),
        source: `${name}: ${proposal.source}`,
      });
    }
  }
  return proposals;
};
