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
 * identity never changes. The three optional files exist when the config declares a posture or an
 * edge: a generation from before them has none, and reads as it did.
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
  /** Bytes in database.sql and recovery.json; directories and links are never followed. */
  readonly bytes: number;
}

/** A backup pruning kept because a recovery may still need it, and why. */
export interface HeldBackup {
  readonly directory: string;
  /** `pending`: the upgrade never recorded a healthy target. `unfinished`: no complete dump. */
  readonly reason: "pending" | "unfinished";
}

/** The outcome of one prune: what went, what stayed by count, what stayed for recovery. */
export interface BackupPrune {
  readonly removed: ReadonlyArray<BackupEntry>;
  readonly kept: ReadonlyArray<BackupEntry>;
  readonly held: ReadonlyArray<HeldBackup>;
}

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
   */
  pruneBackups(keep: number, current: ServerBackup): ServerStoreResult<BackupPrune>;
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

const storeError = (cause: unknown): ServerStoreError => {
  if (cause instanceof ServerStoreError) return cause;
  const detail = cause instanceof Error ? cause.message : "unknown filesystem error";
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
const optionalFileKeys = ["posture", "edge", "caddyfile"] as const;
const fileNames = {
  identity: "identity.env",
  config: "server.json",
  env: "server.env",
  compose: "compose.yaml",
  postgresInit: "postgres-init.sh",
  posture: "compose.posture.yaml",
  edge: "compose.edge.yaml",
  caddyfile: "Caddyfile",
} as const;
/** The bind-mounted files another UID reads: Postgres's init (UID 70) and Caddy's configuration. */
const fileModes: Readonly<Record<(typeof fileKeys | typeof optionalFileKeys)[number], number>> = {
  identity: 0o600,
  config: 0o600,
  env: 0o600,
  compose: 0o600,
  postgresInit: 0o755,
  posture: 0o600,
  edge: 0o600,
  caddyfile: 0o644,
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
  const files: ServerFiles = {
    identity: fs.readFileSync(path.join(directory, fileNames.identity), "utf8"),
    config: fs.readFileSync(path.join(directory, fileNames.config), "utf8"),
    env: fs.readFileSync(path.join(directory, fileNames.env), "utf8"),
    compose: fs.readFileSync(path.join(directory, fileNames.compose), "utf8"),
    postgresInit: fs.readFileSync(path.join(directory, fileNames.postgresInit), "utf8"),
    ...(posture === undefined ? {} : { posture }),
    ...(edge === undefined ? {} : { edge }),
    ...(caddyfile === undefined ? {} : { caddyfile }),
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

const renderRecovery = (record: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const BACKUP_NAME = /^upgrade-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BACKUP_FILES = ["database.sql", "recovery.json"] as const;

type ReadBackup =
  | { readonly kind: "foreign" }
  | { readonly kind: "held"; readonly reason: HeldBackup["reason"] }
  | { readonly kind: "completed"; readonly createdAt: number; readonly bytes: number };

const lstatOptional = (file: string): fs.Stats | null => {
  try {
    return fs.lstatSync(file);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

/**
 * Read one entry of backups/ without following a link. Anything Mend did not write is foreign and
 * left alone; a partial or missing dump is unfinished; a record that does not say `completed` is
 * pending. A record from before the state field counts as completed once its dump is whole: those
 * releases deleted nothing either, so they wrote no state to read.
 */
const readBackup = (directory: string): ReadBackup => {
  const stat = lstatOptional(directory);
  if (stat === null || !stat.isDirectory() || !BACKUP_NAME.test(path.basename(directory)))
    return { kind: "foreign" };
  const recovery = lstatOptional(path.join(directory, "recovery.json"));
  if (recovery === null || !recovery.isFile()) return { kind: "foreign" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(directory, "recovery.json"), "utf8"));
  } catch {
    return { kind: "foreign" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("previousGeneration" in parsed) ||
    !("targetGeneration" in parsed) ||
    typeof parsed.previousGeneration !== "string" ||
    typeof parsed.targetGeneration !== "string"
  )
    return { kind: "foreign" };
  const entries = fs.readdirSync(directory);
  if (entries.includes("database.sql.partial")) return { kind: "held", reason: "unfinished" };
  if (entries.some((name) => !BACKUP_FILES.some((expected) => expected === name)))
    return { kind: "foreign" };
  const dump = lstatOptional(path.join(directory, "database.sql"));
  if (dump === null || !dump.isFile() || dump.size === 0)
    return dump === null || dump.isFile()
      ? { kind: "held", reason: "unfinished" }
      : { kind: "foreign" };
  const state = "state" in parsed ? parsed.state : undefined;
  if (state !== undefined && state !== "completed") return { kind: "held", reason: "pending" };
  const stamped =
    "createdAt" in parsed && typeof parsed.createdAt === "string"
      ? Date.parse(parsed.createdAt)
      : Number.NaN;
  return {
    kind: "completed",
    createdAt: Number.isFinite(stamped) ? stamped : recovery.mtimeMs,
    bytes: dump.size + recovery.size,
  };
};

const pruneBackups = (configDir: string, keep: number, current: ServerBackup): BackupPrune => {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new ServerStoreError("Pruning keeps at least one upgrade backup.");
  const backups = path.join(configDir, "backups");
  if (path.dirname(current.directory) !== backups)
    throw new ServerStoreError("The current upgrade backup is outside this installation.");
  const currentRead = readBackup(current.directory);
  if (currentRead.kind !== "completed")
    throw new ServerStoreError("The current upgrade backup is not completed; nothing was pruned.");
  const completed: Array<BackupEntry & { readonly createdAt: number }> = [];
  const held: Array<HeldBackup> = [];
  for (const name of fs.readdirSync(backups).toSorted()) {
    const directory = path.join(backups, name);
    if (directory === current.directory) continue;
    const read = readBackup(directory);
    if (read.kind === "held") held.push({ directory, reason: read.reason });
    if (read.kind === "completed")
      completed.push({ directory, bytes: read.bytes, createdAt: read.createdAt });
  }
  completed.sort((a, b) => b.createdAt - a.createdAt);
  const kept: Array<BackupEntry> = [
    { directory: current.directory, bytes: currentRead.bytes },
    ...completed.slice(0, keep - 1).map(({ directory, bytes }) => ({ directory, bytes })),
  ];
  const removed: Array<BackupEntry> = [];
  for (const { directory, bytes } of completed.slice(keep - 1)) {
    // The dump first: it is the space. A crash after it leaves a record without a dump, which
    // reads as unfinished and stays; nothing is ever removed recursively.
    for (const file of BACKUP_FILES) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
    removed.push({ directory, bytes });
  }
  if (removed.length > 0) syncDirectory(backups);
  return { removed, kept, held };
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
        const directory = path.join(backups, `upgrade-${randomUUID()}`);
        fs.mkdirSync(directory, { mode: 0o700 });
        const record = {
          previousGeneration: previous.directory,
          targetGeneration: target.directory,
          database: "database.sql",
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
    pruneBackups: (keep, current) => whileOwned(() => pruneBackups(configDir, keep, current)),
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
