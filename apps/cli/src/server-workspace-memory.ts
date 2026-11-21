/**
 * The memory limit of each session's workspace container, and of its Docker service (the
 * `-docker` sidecar), on the bundled sealant worker's Docker runtime (SLNT-1233). sealant reads
 * `SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT` and `SEALANT_DOCKER_SERVICE_MEMORY_LIMIT`; unset, each is
 * `auto`: half of the Docker host's memory for a workspace, at least 2 GiB, at most 16 GiB, never
 * above three quarters of the host; a quarter for its Docker service, at least 1 GiB, at most
 * 8 GiB, never above half. At the limit the kernel stops a process inside that workspace, and the
 * session says so.
 *
 * The operator's values live in the server config (`--workspace-memory`,
 * `--workspace-docker-memory`), and `compose.workspace-memory.yaml` hands them to the `mend`
 * container, whose environment the bundled worker inherits. The values are written into the
 * overlay itself, not `server.env`: a CLI from before this setting refuses a `server.env` line it
 * does not know, and ignores a file it does not know, so an older CLI can still read and upgrade
 * the install (and drops the setting, which returns the worker to sealant's `auto`). Unset, no
 * overlay is written and the generation is what it was before the setting existed.
 *
 * Mend checks a value against sealant's own grammar before saving it, so the worker never starts
 * with a value it refuses: `auto`, `none`, or a size in bytes, or with a binary unit `k`, `m`,
 * `g` or `t` (`4g`, `4096m`, `4GiB`, `4gb`), at least 64 MiB.
 */

export const WORKSPACE_MEMORY_COMPOSE_FILE = "compose.workspace-memory.yaml";

/** A saved limit: `auto`, `none`, or a size as the operator wrote it. */
export type WorkspaceMemoryLimit = string;

/** The values an install sets; a value it does not set is sealant's `auto`. */
export interface ServerWorkspaceMemory {
  /** `SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT`: each session's workspace container. */
  readonly workspace?: WorkspaceMemoryLimit;
  /** `SEALANT_DOCKER_SERVICE_MEMORY_LIMIT`: each workspace's Docker service. */
  readonly dockerService?: WorkspaceMemoryLimit;
}

/**
 * A flag's value: a limit, or `default` to go back to sealant's own. `default` is never a limit,
 * so the one string type holds both.
 */
export type WorkspaceMemoryValue = string;

const MIN_BYTES = 64 * 1024 ** 2;
const UNIT_BYTES: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/** A size's bytes, or null when it is not a size sealant reads. */
const sizeBytes = (value: string): number | null => {
  const match = /^(\d{1,16})(?:([kmgt])(?:ib|b)?)?$/i.exec(value);
  if (match === null) return null;
  const [, digits = "", unit] = match;
  const bytes = Number(digits) * (unit === undefined ? 1 : (UNIT_BYTES[unit.toLowerCase()] ?? 0));
  return Number.isSafeInteger(bytes) ? bytes : null;
};

/** A limit sealant reads, or null. */
const isLimit = (value: string): boolean => {
  if (value === "auto" || value === "none") return true;
  const bytes = sizeBytes(value);
  return bytes !== null && bytes >= MIN_BYTES;
};

export const parseWorkspaceMemory = (value: string): WorkspaceMemoryValue | null =>
  value === "default" || isLimit(value) ? value : null;

export const WORKSPACE_MEMORY_RULE =
  "auto, none, a size of at least 64m such as 4g, 4096m or 4GiB, or default";

/** A flag's value over the saved one: `default` takes it away, silence keeps it. */
const pick = (flag: WorkspaceMemoryValue | undefined, kept: WorkspaceMemoryLimit | undefined) =>
  flag === "default" ? undefined : (flag ?? kept);

/**
 * What a setup writes: each flag given, else what the install saved. `default` takes a saved value
 * away. Undefined when neither value is set, so the config carries no field at all.
 */
export const resolveWorkspaceMemory = (
  saved: ServerWorkspaceMemory | undefined,
  options: {
    readonly workspaceMemory: WorkspaceMemoryValue | undefined;
    readonly workspaceDockerMemory: WorkspaceMemoryValue | undefined;
  },
): ServerWorkspaceMemory | undefined => {
  const workspace = pick(options.workspaceMemory, saved?.workspace);
  const dockerService = pick(options.workspaceDockerMemory, saved?.dockerService);
  if (workspace === undefined && dockerService === undefined) return undefined;
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(dockerService === undefined ? {} : { dockerService }),
  };
};

/** The saved field, or null when it is not what a setup writes. */
export const parseWorkspaceMemoryField = (raw: unknown): ServerWorkspaceMemory | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = new Map(Object.entries(raw));
  if ([...fields.keys()].some((key) => key !== "workspace" && key !== "dockerService")) return null;
  const read = (key: string): WorkspaceMemoryLimit | undefined | null => {
    const value = fields.get(key);
    if (value === undefined) return undefined;
    return typeof value === "string" && isLimit(value) ? value : null;
  };
  const workspace = read("workspace");
  const dockerService = read("dockerService");
  if (
    workspace === null ||
    dockerService === null ||
    (workspace === undefined && dockerService === undefined)
  )
    return null;
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(dockerService === undefined ? {} : { dockerService }),
  };
};

/** `compose.workspace-memory.yaml`, or undefined when the install sets neither value. */
export const renderWorkspaceMemoryOverlay = (
  memory: ServerWorkspaceMemory | undefined,
): string | undefined => {
  if (memory === undefined) return undefined;
  return [
    "# Written by mend server setup from server.json: the memory limit of each session's workspace",
    "# (--workspace-memory) and of its Docker service (--workspace-docker-memory).",
    "# A value not named here is sealant's default, auto.",
    "services:",
    "  mend:",
    "    environment:",
    ...(memory.workspace === undefined
      ? []
      : [`      SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT: "${memory.workspace}"`]),
    ...(memory.dockerService === undefined
      ? []
      : [`      SEALANT_DOCKER_SERVICE_MEMORY_LIMIT: "${memory.dockerService}"`]),
    "",
  ].join("\n");
};

/** The one line `mend server status` says, among the settings the install declares. */
export const workspaceMemoryLine = (memory: ServerWorkspaceMemory | undefined): string => {
  const workspace = memory?.workspace ?? "auto";
  const dockerService = memory?.dockerService ?? "auto";
  const workspaceWords =
    workspace === "auto"
      ? "half of this machine's memory (2 to 16 GiB)"
      : workspace === "none"
        ? "no limit"
        : workspace;
  const dockerServiceWords =
    dockerService === "auto"
      ? workspace === "auto"
        ? "a quarter (1 to 8 GiB)"
        : "a quarter of this machine's memory (1 to 8 GiB)"
      : dockerService === "none"
        ? "no limit"
        : dockerService;
  const source =
    memory === undefined
      ? "sealant's defaults, not set on this install"
      : memory.workspace === undefined
        ? "the workspace's limit is sealant's default"
        : memory.dockerService === undefined
          ? "the Docker service's limit is sealant's default"
          : "set on this install";
  return `workspace memory · each session's workspace gets ${workspaceWords}, its Docker service ${dockerServiceWords} · ${source}`;
};

/** What setup says when this run changes either value; nothing when it does not. */
export const workspaceMemoryChangedLines = (
  before: ServerWorkspaceMemory | undefined,
  after: ServerWorkspaceMemory | undefined,
): ReadonlyArray<string> =>
  before?.workspace === after?.workspace && before?.dockerService === after?.dockerService
    ? []
    : [
        `${workspaceMemoryLine(after)}. Sessions started after Mend restarts get these limits; running ones keep theirs.`,
      ];
