import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Storage failures include busy locks and recovery guidance; messages never contain file contents. */
export class ServerStoreError extends Error {
  readonly _tag = "ServerStoreError" as const;
}

/** Expected filesystem failures stay values at the store boundary. */
export type ServerStoreResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "error"; readonly error: ServerStoreError };

/**
 * Complete deployment files, committed together. Only postgresInit and the Caddyfile are public;
 * identity never changes. The optional files exist when the config declares a posture, an edge or
 * mirrors and the t3code gateway: a generation from before them has none, and reads as it did.
 */
export interface ServerFiles {
  readonly identity: string;
  readonly config: string;
  readonly env: string;
  readonly compose: string;
  readonly postgresInit: string;
  /** compose.posture.yaml: the posture variables the mend container receives. */
  readonly posture?: string;
  /** compose.edge.yaml: the TLS edge overlay, the repository's byte for byte. */
  readonly edge?: string;
  /** Caddyfile: the edge's configuration, mounted read-only into the edge container. */
  readonly caddyfile?: string;
  /** compose.mirrors.yaml: the package and image mirrors (server-mirrors.ts). */
  readonly mirrors?: string;
  /** npm-mirror.conf: the npm mirror's nginx configuration, mounted read-only. */
  readonly npmMirrorConf?: string;
  /** docker-mirror-guard.sh: the Docker mirror's entrypoint, which bounds its cache. */
  readonly dockerMirrorGuard?: string;
  /** compose.t3.yaml: the t3code gateway turned on, its port on loopback. */
  readonly t3Gateway?: string;
}

/** An immutable deployment snapshot. Use this directory, not the active symlink, for Compose. */
export interface ServerGeneration {
  readonly directory: string;
  readonly files: ServerFiles;
}

/** Private recovery record. Only a completed, fsynced dump is published as database.sql. */
export interface ServerBackup {
  readonly directory: string;
  readonly partialFile: string;
  complete(): ServerStoreResult<void>;
  /**
   * Record in recovery.json that the target started and answered health at its exact version. Until
   * then the record says `pending`: a recovery may still need this backup, and pruning keeps it.
   */
  markCompleted(): ServerStoreResult<void>;
}

/** One upgrade backup directory as pruning read it. Foreign entries never appear here. */
export interface BackupEntry {
  readonly directory: string;
  /**
   * Bytes removing it frees: database.sql and recovery.json, each only when no other hard link
   * holds it. Directories and symbolic links are never followed.
   */
  readonly bytes: number;
  /**
   * Written before recovery.json recorded an outcome (releases before 0.36): counted as completed
   * because its dump is whole, ordered by its target's version, then the generation chain.
   */
  readonly legacy: boolean;
  /**
   * A removal a crash cut short, finished now: an `upgrade-UUID.removing` directory, a completed
   * record without its dump, or an empty directory. None holds a usable backup.
   */
  readonly interrupted: boolean;
}

/** A backup pruning kept because a recovery may still need it, and why. */
export interface HeldBackup {
  readonly directory: string;
  /**
   * `pending`: the upgrade never recorded a healthy target. `unfinished`: no complete dump.
   * `no-outcome`: no state, but written after a 0.36 backup (by an older CLI), so not from before
   * outcomes were recorded. `unreadable`: this process could not read it, or its record has a state
   * without a valid sequence.
   */
  readonly reason: "pending" | "unfinished" | "no-outcome" | "unreadable";
  /** For `unreadable`: what could not be read. */
  readonly detail?: string;
}

/** A removal that failed partway; what was already removed is still reported. */
export interface FailedRemoval {
  readonly directory: string;
  readonly message: string;
}

/** The outcome of one prune: what went, what stayed by count, what stayed for recovery. */
export interface BackupPrune {
  readonly removed: ReadonlyArray<BackupEntry>;
  readonly kept: ReadonlyArray<BackupEntry>;
  readonly held: ReadonlyArray<HeldBackup>;
  readonly failed: ReadonlyArray<FailedRemoval>;
  /** Set when the removals happened but fsyncing backups/ afterwards failed. */
  readonly unsynced?: string;
}

/** Orders two server versions the way upgrades move: negative when `a` came first. */
export type CompareServerVersions = (a: string, b: string) => number;

/** Valid only inside withServerStore. All lifecycle commands must use the same lock. */
export interface ServerStore {
  readIdentity(): ServerStoreResult<string | null>;
  readActive(): ServerStoreResult<ServerGeneration | null>;
  /** Retains generations, reuses compatible identical active files, and refuses identity replacement. */
  commit(files: ServerFiles): ServerStoreResult<ServerGeneration>;
  /** Prepare without selecting; identical active files require compatible init permissions for reuse. */
  prepare(files: ServerFiles): ServerStoreResult<ServerGeneration>;
  /** Select a retained generation from this store without rewriting it. */
  activate(generation: ServerGeneration): ServerStoreResult<void>;
  /** Retain old/target references before interrupting the app. Never removes a backup; pruneBackups does, after a healthy upgrade. */
  createBackup(
    previous: ServerGeneration,
    target: ServerGeneration,
  ): ServerStoreResult<ServerBackup>;
  /**
   * Keep the newest `keep` completed upgrade backups, `current` among them, and remove the older
   * completed ones. Never removes `current`, a pending or unfinished backup, or anything that is not
   * an `upgrade-UUID` directory holding exactly recovery.json and database.sql. `keep` is at least 1.
   * `compareVersions` orders records from before 0.36 by the version their target generation pins.
   */
  pruneBackups(
    keep: number,
    current: ServerBackup,
    compareVersions: CompareServerVersions,
  ): ServerStoreResult<BackupPrune>;
}

interface StorePaths {
  readonly configDir: string;
  readonly identity: string;
  readonly generations: string;
  readonly active: string;
}

interface OwnedLock {
  assertOwned(): void;
  release(): ServerStoreResult<void>;
}

/** A failure the operating system raised (`EACCES`, `ENOSPC`, …): it carries an errno code. */
const isSystemError = (cause: Error): boolean => "code" in cause && typeof cause.code === "string";

/**
 * A storage failure says what failed and how to recover from it. A refusal raised under the lock
 * (another command holds it, an unknown flag, no server configured) already says what to do, so
 * it arrives as it was written; the filesystem advice is for the operating system's failures.
 */
const storeError = (cause: unknown): ServerStoreError => {
  if (cause instanceof ServerStoreError) return cause;
  if (cause instanceof Error && !isSystemError(cause)) return new ServerStoreError(cause.message);
  const detail = cause instanceof Error ? cause.message.replace(/\.+$/u, "") : "unknown failure";
  return new ServerStoreError(
    `Server storage operation failed: ${detail}. Retain the identity and generations; fix the filesystem problem and retry.`,
  );
};

const attempt = <T>(operation: () => T): ServerStoreResult<T> => {
  try {
    return { _tag: "ok", value: operation() };
  } catch (cause) {
    return { _tag: "error", error: storeError(cause) };
  }
};

const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

const readOptional = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

const syncDirectory = (directory: string): void => {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const writeDurable = (file: string, content: string, mode = 0o600): void => {
  const fd = fs.openSync(file, "wx", mode);
  try {
    fs.writeFileSync(fd, content, "utf8");
    // Creation modes are masked by umask, but the bind-mounted init must be executable by UID 70.
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const fileKeys = ["identity", "config", "env", "compose", "postgresInit"] as const;
/** Present only when the config asks for them; a missing file reads as undefined. */
const optionalFileKeys = [
  "posture",
  "edge",
  "caddyfile",
  "mirrors",
  "npmMirrorConf",
  "dockerMirrorGuard",
  "t3Gateway",
] as const;
const fileNames = {
  identity: "identity.env",
  config: "server.json",
  env: "server.env",
  compose: "compose.yaml",
  postgresInit: "postgres-init.sh",
  posture: "compose.posture.yaml",
  edge: "compose.edge.yaml",
  caddyfile: "Caddyfile",
  mirrors: "compose.mirrors.yaml",
  npmMirrorConf: "npm-mirror.conf",
  dockerMirrorGuard: "docker-mirror-guard.sh",
  t3Gateway: "compose.t3.yaml",
} as const;
/**
 * The bind-mounted files another UID reads: Postgres's init (UID 70), Caddy's configuration and
 * the npm mirror's.
 */
const fileModes: Readonly<Record<(typeof fileKeys | typeof optionalFileKeys)[number], number>> = {
  identity: 0o600,
  config: 0o600,
  env: 0o600,
  compose: 0o600,
  postgresInit: 0o755,
  posture: 0o600,
  edge: 0o600,
  caddyfile: 0o644,
  mirrors: 0o600,
  npmMirrorConf: 0o644,
  dockerMirrorGuard: 0o644,
  t3Gateway: 0o600,
};

/** Every file a generation may hold, in a fixed order, with its content or undefined. */
const allFiles = (
  files: ServerFiles,
): ReadonlyArray<
  readonly [(typeof fileKeys | typeof optionalFileKeys)[number], string | undefined]
> => [...fileKeys, ...optionalFileKeys].map((key) => [key, files[key]] as const);

const parseLockOwner = (
  raw: unknown,
): { readonly pid: number; readonly hostname: string } | null => {
  if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("hostname" in raw))
    return null;
  if (
    typeof raw.pid !== "number" ||
    !Number.isSafeInteger(raw.pid) ||
    raw.pid <= 0 ||
    typeof raw.hostname !== "string"
  )
    return null;
  return { pid: raw.pid, hostname: raw.hostname };
};

const describeOwner = (lockDir: string): string => {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    const owner = parseLockOwner(raw);
    if (owner === null) return "owner metadata is invalid";
    const label = `PID ${owner.pid} on ${owner.hostname}`;
    if (owner.hostname !== os.hostname()) return label;
    try {
      process.kill(owner.pid, 0);
      return `${label} is still live`;
    } catch (cause) {
      return hasCode(cause, "ESRCH")
        ? `${label} is no longer running; the lock may be stale`
        : `${label} cannot be checked`;
    }
  } catch {
    // A crash may precede owner.json. An unreadable lock is never assumed free.
    return "owner metadata is missing or unreadable";
  }
};

const lockGuidance = (lockDir: string): ServerStoreError =>
  new ServerStoreError(
    `Server is busy: ${lockDir} is locked (${describeOwner(lockDir)}). Wait for the owning command. Never remove a live lock. For stale-lock recovery, verify on that host that the owner and its Docker Compose children have stopped, then move only this lock directory aside and retry. Keep identity.env, active, and generations intact.`,
  );

const acquireLock = (configDir: string, create: boolean): OwnedLock => {
  if (create) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
  } else if (!fs.existsSync(configDir)) {
    throw new ServerStoreError(
      "No Mend server is configured. Run mend server setup explicitly to install one.",
    );
  }
  const lockDir = path.join(configDir, "server.lock");
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (cause) {
    if (hasCode(cause, "EEXIST")) throw lockGuidance(lockDir);
    throw cause;
  }
  const owned = fs.statSync(lockDir);
  const ownerFile = path.join(lockDir, "owner.json");
  const owner = `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: randomUUID() })}\n`;
  let open = true;
  const assertOwned = (): void => {
    const current = fs.statSync(lockDir);
    if (
      !open ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      fs.readFileSync(ownerFile, "utf8") !== owner
    ) {
      throw new ServerStoreError(
        "Server lock ownership was lost. Stop and check for another server command before retrying.",
      );
    }
  };
  // If writing metadata fails, retain this uncertain lock with the same recovery guidance.
  try {
    writeDurable(ownerFile, owner);
  } catch {
    throw lockGuidance(lockDir);
  }
  return {
    assertOwned,
    release: () => {
      const result = attempt(() => {
        assertOwned();
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lockDir); // Never recursively delete unexpected or replaced lock contents.
      });
      open = false;
      return result;
    },
  };
};

const readIdentity = (paths: StorePaths): string | null => {
  const identity = readOptional(paths.identity);
  if (
    identity === null &&
    (fs.existsSync(paths.active) ||
      (fs.existsSync(paths.generations) && fs.readdirSync(paths.generations).length > 0))
  ) {
    throw new ServerStoreError(
      "Server identity.env is missing. Restore it from a retained generation or backup; refusing to generate replacement credentials.",
    );
  }
  return identity;
};

const readActive = (paths: StorePaths): ServerGeneration | null => {
  let target: string;
  try {
    target = fs.readlinkSync(paths.active);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
  if (!/^generations\/gen-[0-9a-f-]{36}$/.test(target)) {
    throw new ServerStoreError(
      "Server active pointer is invalid. Restore the symlink to a retained generation before retrying.",
    );
  }
  const directory = path.join(paths.configDir, target);
  const optional = (key: (typeof optionalFileKeys)[number]): string | undefined =>
    readOptional(path.join(directory, fileNames[key])) ?? undefined;
  const posture = optional("posture");
  const edge = optional("edge");
  const caddyfile = optional("caddyfile");
  const mirrors = optional("mirrors");
  const npmMirrorConf = optional("npmMirrorConf");
  const dockerMirrorGuard = optional("dockerMirrorGuard");
  const t3Gateway = optional("t3Gateway");
  const files: ServerFiles = {
    identity: fs.readFileSync(path.join(directory, fileNames.identity), "utf8"),
    config: fs.readFileSync(path.join(directory, fileNames.config), "utf8"),
    env: fs.readFileSync(path.join(directory, fileNames.env), "utf8"),
    compose: fs.readFileSync(path.join(directory, fileNames.compose), "utf8"),
    postgresInit: fs.readFileSync(path.join(directory, fileNames.postgresInit), "utf8"),
    ...(posture === undefined ? {} : { posture }),
    ...(edge === undefined ? {} : { edge }),
    ...(caddyfile === undefined ? {} : { caddyfile }),
    ...(mirrors === undefined ? {} : { mirrors }),
    ...(npmMirrorConf === undefined ? {} : { npmMirrorConf }),
    ...(dockerMirrorGuard === undefined ? {} : { dockerMirrorGuard }),
    ...(t3Gateway === undefined ? {} : { t3Gateway }),
  };
  if (readIdentity(paths) !== files.identity) {
    throw new ServerStoreError(
      "Server generation identity does not match identity.env. Restore from backup; credentials will not be replaced.",
    );
  }
  return { directory, files };
};

const publishIdentity = (paths: StorePaths, identity: string): void => {
  const temporary = path.join(paths.configDir, `.identity-${randomUUID()}`);
  writeDurable(temporary, identity);
  fs.linkSync(temporary, paths.identity); // exclusive publication, never rename over an identity
  syncDirectory(paths.configDir);
  fs.unlinkSync(temporary);
};

const prepareGeneration = (paths: StorePaths, files: ServerFiles): ServerGeneration => {
  fs.mkdirSync(paths.generations, { recursive: true, mode: 0o700 });
  const generationName = `gen-${randomUUID()}`;
  const directory = path.join(paths.generations, generationName);
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [key, content] of allFiles(files)) {
    if (content === undefined) continue;
    writeDurable(path.join(directory, fileNames[key]), content, fileModes[key]);
  }
  syncDirectory(directory);
  syncDirectory(paths.generations);
  syncDirectory(paths.configDir);
  return { directory, files };
};

const activateGeneration = (paths: StorePaths, generation: ServerGeneration): void => {
  const relative = path.relative(paths.configDir, generation.directory);
  if (
    !/^generations\/gen-[0-9a-f-]{36}$/.test(relative) ||
    readIdentity(paths) !== fs.readFileSync(path.join(generation.directory, "identity.env"), "utf8")
  ) {
    throw new ServerStoreError("Cannot activate a generation outside this installation identity.");
  }
  for (const [key, content] of allFiles(generation.files)) {
    if (readOptional(path.join(generation.directory, fileNames[key])) !== (content ?? null)) {
      throw new ServerStoreError("Cannot activate an incomplete or changed server generation.");
    }
  }
  const pointer = path.join(paths.configDir, `.active-${randomUUID()}`);
  fs.symlinkSync(relative, pointer);
  fs.renameSync(pointer, paths.active);
  syncDirectory(paths.configDir);
};

const prepareFiles = (paths: StorePaths, files: ServerFiles): ServerGeneration => {
  const identity = readIdentity(paths);
  if (identity !== null && identity !== files.identity) {
    throw new ServerStoreError("Server identity already exists; refusing to replace credentials.");
  }
  const active = readActive(paths);
  if (
    active !== null &&
    allFiles(files).every(([key, content]) => content === active.files[key]) &&
    (fs.statSync(path.join(active.directory, fileNames.postgresInit)).mode & 0o7777) === 0o755
  )
    return active;
  // Never chmod a retained generation. Old private init scripts need a new snapshot, not new credentials.
  // Publish identity before preparing any generation. A crash here cannot orphan credentials.
  if (identity === null) publishIdentity(paths, files.identity);
  return prepareGeneration(paths, files);
};

const commitGeneration = (paths: StorePaths, files: ServerFiles): ServerGeneration => {
  const generation = prepareFiles(paths, files);
  activateGeneration(paths, generation);
  return generation;
};

const renderRecovery = (record: Readonly<Record<string, string | number>>): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const BACKUP_NAME = /^upgrade-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A backup being removed: renamed first, so a crash partway leaves a name pruning recognises. */
const REMOVING_NAME =
  /^upgrade-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removing$/;
/** markCompleted's temporary record; one left behind means the rename never happened. */
const RECOVERY_TEMPORARY =
  /^\.recovery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RecoveryRecord {
  /** Generation directory names (`gen-UUID`), so a copied installation still chains. */
  readonly previousGeneration: string;
  readonly targetGeneration: string;
  /** Absent in records from before 0.36. */
  readonly state: unknown;
  /** Mend's own order: one more than the highest when written. Absent before 0.36. */
  readonly sequence: number | undefined;
  /** Whether the record has either field: every release that writes one writes both. */
  readonly recordsOutcome: boolean;
  /** The serverVersion the target generation pins, when its server.json reads. */
  readonly targetVersion: string | undefined;
  /** createdAt, else the record's mtime: a tie-break only, since clocks move and copies reset. */
  readonly clock: number;
}

type ReadBackup =
  | { readonly kind: "foreign" }
  | {
      readonly kind: "held";
      readonly reason: HeldBackup["reason"];
      readonly detail?: string;
      readonly record?: RecoveryRecord;
    }
  | { readonly kind: "interrupted"; readonly bytes: number }
  | {
      readonly kind: "completed";
      readonly record: RecoveryRecord;
      readonly bytes: number;
      readonly legacy: boolean;
    };

const lstatOptional = (file: string): fs.Stats | null => {
  try {
    return fs.lstatSync(file);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

/** Bytes unlinking this file frees: none while another hard link holds it. */
const freedBy = (stat: fs.Stats): number => (stat.nlink === 1 ? stat.size : 0);

const GENERATION_NAME = /^gen-[0-9a-f-]{36}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The serverVersion a generation of this installation pins, read by its name under generations/. */
const generationVersion = (configDir: string, generation: string): string | undefined => {
  if (!GENERATION_NAME.test(generation)) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(configDir, "generations", generation, "server.json"), "utf8"),
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      "serverVersion" in parsed &&
      typeof parsed.serverVersion === "string" &&
      VERSION.test(parsed.serverVersion)
      ? parsed.serverVersion
      : undefined;
  } catch {
    return undefined;
  }
};

const readRecord = (configDir: string, file: string, stat: fs.Stats): RecoveryRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("previousGeneration" in parsed) ||
    !("targetGeneration" in parsed) ||
    typeof parsed.previousGeneration !== "string" ||
    typeof parsed.targetGeneration !== "string"
  )
    return null;
  const sequence =
    "sequence" in parsed &&
    typeof parsed.sequence === "number" &&
    Number.isSafeInteger(parsed.sequence) &&
    parsed.sequence > 0
      ? parsed.sequence
      : undefined;
  const stamped =
    "createdAt" in parsed && typeof parsed.createdAt === "string"
      ? Date.parse(parsed.createdAt)
      : Number.NaN;
  const targetGeneration = path.basename(parsed.targetGeneration);
  return {
    previousGeneration: path.basename(parsed.previousGeneration),
    targetGeneration,
    state: "state" in parsed ? parsed.state : undefined,
    sequence,
    recordsOutcome: "state" in parsed || "sequence" in parsed,
    targetVersion: generationVersion(configDir, targetGeneration),
    clock: Number.isFinite(stamped) ? stamped : stat.mtimeMs,
  };
};

/** pg_dumpall's last comment, at the start of a line, then its closing `--` and blank lines. */
const DUMP_TRAILER = /-- PostgreSQL database cluster dump complete\r?\n(?:--\r?\n)?\s*$/;

/** Whether a dump ends with pg_dumpall's trailer: read its last bytes, never the whole file. */
const dumpIsWhole = (file: string, size: number): boolean => {
  const length = Math.min(size, 256);
  if (length === 0) return false;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const tail = buffer.toString("utf8");
  const match = DUMP_TRAILER.exec(tail);
  if (match === null) return false;
  // The line must start there: after a newline, or at the very start of a file this short.
  return match.index === 0 ? length === size : tail[match.index - 1] === "\n";
};

/**
 * Read one entry of backups/ without following a link. Anything Mend did not write is foreign and
 * left alone. A partial dump, a missing one, or one without pg_dumpall's trailer is unfinished. A
 * record that says anything but `completed` is pending, and one with a state but no valid sequence
 * is unreadable. A completed record without its dump, or an empty directory, is a removal a crash
 * cut short. A record from before 0.36 has neither field: it counts as completed once its dump is
 * whole, since those releases recorded no outcome to read.
 */
const readBackup = (configDir: string, directory: string): ReadBackup => {
  const stat = lstatOptional(directory);
  if (stat === null || !stat.isDirectory()) return { kind: "foreign" };
  if (REMOVING_NAME.test(path.basename(directory))) return readRemoving(directory);
  if (!BACKUP_NAME.test(path.basename(directory))) return { kind: "foreign" };
  const entries = fs.readdirSync(directory);
  if (entries.length === 0) return { kind: "interrupted", bytes: 0 };
  const recoveryFile = path.join(directory, "recovery.json");
  const recovery = lstatOptional(recoveryFile);
  if (recovery === null || !recovery.isFile()) return { kind: "foreign" };
  const record = readRecord(configDir, recoveryFile, recovery);
  if (record === null) return { kind: "foreign" };
  if (entries.includes("database.sql.partial"))
    return { kind: "held", reason: "unfinished", record };
  if (
    entries.some(
      (name) =>
        name !== "database.sql" && name !== "recovery.json" && !RECOVERY_TEMPORARY.test(name),
    )
  )
    return { kind: "foreign" };
  if (record.recordsOutcome && (record.sequence === undefined || record.state === undefined))
    return {
      kind: "held",
      reason: "unreadable",
      detail: "recovery.json has a state without a valid sequence",
    };
  // A leftover temporary means markCompleted never renamed: the record still says pending.
  const dump = lstatOptional(path.join(directory, "database.sql"));
  if (dump !== null && !dump.isFile()) return { kind: "foreign" };
  if (dump === null)
    return record.state === "completed"
      ? { kind: "interrupted", bytes: freedBy(recovery) }
      : { kind: "held", reason: "unfinished", record };
  if (!dumpIsWhole(path.join(directory, "database.sql"), dump.size))
    return { kind: "held", reason: "unfinished", record };
  if (record.recordsOutcome && record.state !== "completed")
    return { kind: "held", reason: "pending", record };
  return {
    kind: "completed",
    record,
    bytes: freedBy(dump) + freedBy(recovery),
    legacy: !record.recordsOutcome,
  };
};

/** A removal cut short: only files Mend writes into a backup, or it is not Mend's to finish. */
const readRemoving = (directory: string): ReadBackup => {
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = lstatOptional(path.join(directory, name));
    if (
      file === null ||
      !file.isFile() ||
      !(
        name === "database.sql" ||
        name === "database.sql.partial" ||
        name === "recovery.json" ||
        RECOVERY_TEMPORARY.test(name)
      )
    )
      return { kind: "foreign" };
    bytes += freedBy(file);
  }
  return { kind: "interrupted", bytes };
};

/**
 * One more than the highest sequence any record in backups/ carries; 1 for the first. An entry this
 * process cannot read never refuses an upgrade: it is skipped, and a repeated number only ties.
 */
const nextSequence = (configDir: string, backups: string): number => {
  let highest = 0;
  for (const name of fs.readdirSync(backups)) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const directory = path.join(backups, name);
      const stat = lstatOptional(directory);
      if (stat === null || !stat.isDirectory()) continue;
      const file = path.join(directory, "recovery.json");
      const recovery = lstatOptional(file);
      if (recovery === null || !recovery.isFile()) continue;
      highest = Math.max(highest, readRecord(configDir, file, recovery)?.sequence ?? 0);
    } catch {
      continue;
    }
  }
  return highest + 1;
};

/** Upgrade order between two versions, or 0 when it cannot say. */
const versionOrder = (
  compareVersions: CompareServerVersions,
  a: string | undefined,
  b: string | undefined,
): number => {
  if (a === undefined || b === undefined) return 0;
  try {
    return compareVersions(a, b);
  } catch {
    return 0;
  }
};

/**
 * How many earlier records chain into each one: an upgrade from the generation another targeted
 * came after it. A setup rerun between upgrades breaks the chain; versions order across that gap.
 */
const chainDepths = (
  records: ReadonlyArray<RecoveryRecord>,
): ((record: RecoveryRecord) => number) => {
  const depths = new Map<RecoveryRecord, number>();
  const depth = (record: RecoveryRecord, visiting: ReadonlySet<RecoveryRecord>): number => {
    const known = depths.get(record);
    if (known !== undefined) return known;
    const next = new Set(visiting).add(record);
    const before = records.filter(
      (other) =>
        !next.has(other) &&
        other.targetGeneration === record.previousGeneration &&
        other.targetGeneration !== other.previousGeneration,
    );
    const value = Math.max(-1, ...before.map((other) => depth(other, next))) + 1;
    depths.set(record, value);
    return value;
  };
  return (record) => depth(record, new Set());
};

/**
 * Newest first, by what Mend wrote rather than by clocks: every sequenced record is newer than
 * every record from before 0.36, and sequences order among themselves. Older records order by the
 * version their target pins (versions only move forward), then by the generation chain. The clock
 * only breaks ties.
 */
const newestFirst = (
  records: ReadonlyArray<RecoveryRecord>,
  compareVersions: CompareServerVersions,
): ((a: RecoveryRecord, b: RecoveryRecord) => number) => {
  const depth = chainDepths(records.filter((record) => record.sequence === undefined));
  return (a, b) => {
    if (a.sequence !== undefined || b.sequence !== undefined) {
      if (a.sequence === undefined) return 1;
      if (b.sequence === undefined) return -1;
      if (a.sequence !== b.sequence) return b.sequence - a.sequence;
    } else {
      const byVersion = versionOrder(compareVersions, b.targetVersion, a.targetVersion);
      if (byVersion !== 0) return byVersion;
      const byChain = depth(b) - depth(a);
      if (byChain !== 0) return byChain;
    }
    return b.clock - a.clock;
  };
};

/**
 * Whether a record without an outcome was written after an earlier 0.36 backup, by an older CLI:
 * its generations chain from a sequenced record's target, or its target pins a later version than
 * some sequenced record's other than the current upgrade's (versions only move forward). Clocks
 * are no evidence here: a copy resets every mtime.
 */
const writtenAfterOutcomes = (
  record: RecoveryRecord,
  records: ReadonlyArray<RecoveryRecord>,
  current: RecoveryRecord,
  compareVersions: CompareServerVersions,
): boolean => {
  const sequenced = records.filter((other) => other.sequence !== undefined);
  const unsequenced = records.filter((other) => other.sequence === undefined);
  const seen = new Set<RecoveryRecord>();
  const chainsFromSequenced = (candidate: RecoveryRecord): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (sequenced.some((other) => other.targetGeneration === candidate.previousGeneration))
      return true;
    return unsequenced.some(
      (other) =>
        other.targetGeneration === candidate.previousGeneration && chainsFromSequenced(other),
    );
  };
  return (
    chainsFromSequenced(record) ||
    sequenced.some(
      (other) =>
        other !== current &&
        versionOrder(compareVersions, record.targetVersion, other.targetVersion) > 0,
    )
  );
};

/**
 * Rename the backup to `upgrade-UUID.removing` first, so a crash at any later step leaves a name
 * the next prune finishes off; then unlink the files Mend wrote and the empty directory. Nothing
 * is removed recursively.
 */
const removeBackup = (directory: string): void => {
  const removing = REMOVING_NAME.test(path.basename(directory))
    ? directory
    : `${directory}.removing`;
  if (removing !== directory) fs.renameSync(directory, removing);
  for (const name of fs.readdirSync(removing))
    if (
      name === "database.sql" ||
      name === "database.sql.partial" ||
      name === "recovery.json" ||
      RECOVERY_TEMPORARY.test(name)
    )
      fs.unlinkSync(path.join(removing, name));
  fs.rmdirSync(removing);
};

/** A backup entry without the record pruning ordered it by. */
const entryOf = ({ directory, bytes, legacy }: BackupEntry): BackupEntry => ({
  directory,
  bytes,
  legacy,
  interrupted: false,
});

const failureOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown filesystem error";

const pruneBackups = (
  configDir: string,
  keep: number,
  current: ServerBackup,
  compareVersions: CompareServerVersions,
): BackupPrune => {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new ServerStoreError("Pruning keeps at least one upgrade backup.");
  const backups = path.join(configDir, "backups");
  if (path.dirname(current.directory) !== backups)
    throw new ServerStoreError("The current upgrade backup is outside this installation.");
  const currentRead = readBackup(configDir, current.directory);
  if (currentRead.kind !== "completed" || currentRead.record.sequence === undefined)
    throw new ServerStoreError("The current upgrade backup is not completed; nothing was pruned.");
  const completed: Array<BackupEntry & { readonly record: RecoveryRecord }> = [];
  const interrupted: Array<BackupEntry> = [];
  const held: Array<HeldBackup> = [];
  const records: Array<RecoveryRecord> = [currentRead.record];
  for (const name of fs.readdirSync(backups).toSorted()) {
    const directory = path.join(backups, name);
    if (directory === current.directory) continue;
    let read: ReadBackup;
    try {
      read = readBackup(configDir, directory);
    } catch (cause) {
      // Never removed, and said: an entry this process cannot read is not one it may remove.
      if (BACKUP_NAME.test(name) || REMOVING_NAME.test(name))
        held.push({ directory, reason: "unreadable", detail: failureOf(cause) });
      continue;
    }
    if (read.kind === "held") {
      held.push({
        directory,
        reason: read.reason,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      });
      if (read.record !== undefined) records.push(read.record);
    }
    if (read.kind === "interrupted")
      interrupted.push({ directory, bytes: read.bytes, legacy: false, interrupted: true });
    if (read.kind === "completed") {
      completed.push({
        directory,
        bytes: read.bytes,
        legacy: read.legacy,
        interrupted: false,
        record: read.record,
      });
      records.push(read.record);
    }
  }
  // A record without an outcome that came after a 0.36 one is an older CLI's: no outcome, held.
  const candidates = completed.filter((entry) => {
    if (
      !entry.legacy ||
      !writtenAfterOutcomes(entry.record, records, currentRead.record, compareVersions)
    )
      return true;
    held.push({ directory: entry.directory, reason: "no-outcome" });
    return false;
  });
  const compare = newestFirst(records, compareVersions);
  candidates.sort((a, b) => compare(a.record, b.record));
  const kept: Array<BackupEntry> = [
    { directory: current.directory, bytes: currentRead.bytes, legacy: false, interrupted: false },
    ...candidates.slice(0, keep - 1).map(entryOf),
  ];
  const removed: Array<BackupEntry> = [];
  const failed: Array<FailedRemoval> = [];
  for (const candidate of [...interrupted, ...candidates.slice(keep - 1).map(entryOf)]) {
    try {
      removeBackup(candidate.directory);
      removed.push(candidate);
    } catch (cause) {
      failed.push({ directory: candidate.directory, message: failureOf(cause) });
    }
  }
  let unsynced: string | undefined;
  if (removed.length > 0 || failed.length > 0) {
    try {
      syncDirectory(backups);
    } catch (cause) {
      unsynced = failureOf(cause);
    }
  }
  return { removed, kept, held, failed, ...(unsynced === undefined ? {} : { unsynced }) };
};

const createStore = (configDir: string, lock: OwnedLock): ServerStore => {
  const paths: StorePaths = {
    configDir,
    identity: path.join(configDir, "identity.env"),
    generations: path.join(configDir, "generations"),
    active: path.join(configDir, "active"),
  };
  const whileOwned = <T>(operation: () => T): ServerStoreResult<T> =>
    attempt(() => {
      lock.assertOwned();
      return operation();
    });
  return {
    readIdentity: () => whileOwned(() => readIdentity(paths)),
    readActive: () => whileOwned(() => readActive(paths)),
    commit: (files) => whileOwned(() => commitGeneration(paths, files)),
    prepare: (files) => whileOwned(() => prepareFiles(paths, files)),
    activate: (generation) => whileOwned(() => activateGeneration(paths, generation)),
    createBackup: (previous, target) =>
      whileOwned(() => {
        const backups = path.join(configDir, "backups");
        fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
        fs.chmodSync(backups, 0o700);
        const sequence = nextSequence(configDir, backups);
        const directory = path.join(backups, `upgrade-${randomUUID()}`);
        fs.mkdirSync(directory, { mode: 0o700 });
        const record = {
          previousGeneration: previous.directory,
          targetGeneration: target.directory,
          database: "database.sql",
          sequence,
          createdAt: new Date().toISOString(),
          policy:
            "If target is active, migrations may have begun. Never downgrade or restore automatically.",
        };
        const recoveryFile = path.join(directory, "recovery.json");
        writeDurable(recoveryFile, renderRecovery({ ...record, state: "pending" }));
        syncDirectory(directory);
        syncDirectory(backups);
        syncDirectory(configDir);
        const partialFile = path.join(directory, "database.sql.partial");
        return {
          directory,
          partialFile,
          complete: () =>
            whileOwned(() => {
              if (fs.statSync(partialFile).size === 0)
                throw new ServerStoreError("Database backup is empty; refusing target startup.");
              const fd = fs.openSync(partialFile, "r");
              try {
                fs.fchmodSync(fd, 0o600);
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              fs.renameSync(partialFile, path.join(directory, "database.sql"));
              syncDirectory(directory);
            }),
          markCompleted: () =>
            whileOwned(() => {
              // Replace, never edit in place: a crash leaves the pending record or the completed one.
              const temporary = path.join(directory, `.recovery-${randomUUID()}`);
              writeDurable(temporary, renderRecovery({ ...record, state: "completed" }));
              fs.renameSync(temporary, recoveryFile);
              syncDirectory(directory);
            }),
        };
      }),
    pruneBackups: (keep, current, compareVersions) =>
      whileOwned(() => pruneBackups(configDir, keep, current, compareVersions)),
  };
};

const refuseFlatLayout = (configDir: string): void => {
  if (
    ["server.json", "server.env", "compose.yaml", "postgres-init.sh"].some((name) =>
      fs.existsSync(path.join(configDir, name)),
    )
  ) {
    throw new ServerStoreError(
      "Unreleased flat server configuration found. Preserve its credentials and volumes; migrate it to the generation layout before retrying. Setup will not replace this identity.",
    );
  }
};

/**
 * Own an exclusive cross-process lock through the entire callback, including Compose operations.
 * Locks are never stolen, even after a crash. Expected callback/storage failures become values.
 * A killed process leaves recovery metadata; normal completion removes only its own lock.
 */
export const withServerStore = async <T>(
  directory: string,
  operation: (store: ServerStore) => Promise<T>,
  options: { readonly create?: boolean } = {},
): Promise<ServerStoreResult<T>> => {
  const configDir = path.resolve(directory);
  let lock: OwnedLock | undefined;
  let result: ServerStoreResult<T>;
  try {
    lock = acquireLock(configDir, options.create ?? true);
    refuseFlatLayout(configDir);
    result = { _tag: "ok", value: await operation(createStore(configDir, lock)) };
  } catch (cause) {
    result = { _tag: "error", error: storeError(cause) };
  } finally {
    const release = lock?.release();
    if (release?._tag === "error") result = release;
  }
  return result;
};
