import type { WorktreeId } from "@mend/domain";
import {
  DUMPS_MOUNT,
  WORKTREE_DATABASE,
  POSTGRES_USER,
  worktreeDatabaseName,
} from "@mend/domain/workbench";
import type { ResourceScope, ScopeExecResult } from "@mend/sealant";
import { Effect, Schema } from "effect";

import { DUMPS_READY_ARGV, OWN_DATABASE_TIMEOUT_MS, dumpStamp } from "./postgres-ops.ts";

/** Stable name reserved in the row before removal makes the dump. */
export const removalDumpName = (database: string, at: Date): string =>
  `${database}-removed-${dumpStamp(at)}.dump`;

const SAVE_DUMP = `pg_dump -U ${POSTGRES_USER} -Fc -f "$file.partial" "$db"
pg_restore --list "$file.partial" > /dev/null
mv "$file.partial" "$file"
`;
const FRESH_DUMP = `set -eu
db="$1"
file="$2"
${SAVE_DUMP}`;
const CHECKED_DUMP = `set -eu
db="$1"
file="$2"
# A failed archive leaves the database live. Save its current data before a later removal.
exists=$(psql -X -qAt -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} -d postgres -c "select exists(select 1 from pg_database where datname = '$db')")
if test "$exists" = t; then
  ${SAVE_DUMP}
else
  # The drop may have completed before Mend received its reply. Keep the checked dump.
  pg_restore --list "$file" > /dev/null
fi
`;
const DROP_SAVED = `set -eu
db="$1"
file="$2"
pg_restore --list "$file" > /dev/null
psql -X -q -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()"
psql -X -q -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} -d postgres -c "drop database if exists \\"$db\\" with (force)"
`;

/** Save and check, or drop only after checking again. Database and path never come from shell text. */
export const removalDatabaseArgv = (
  phase: "save" | "refresh" | "drop",
  database: string,
  dumpName: string,
): ReadonlyArray<string> => {
  if (
    !WORKTREE_DATABASE.test(database) ||
    !/^(?:own|base)_[a-f0-9]{12}-removed-\d{8}T\d{6}Z\.dump$/.test(dumpName) ||
    !dumpName.startsWith(`${database}-removed-`)
  ) {
    throw new Error("invalid worktree database removal path");
  }
  return [
    "sh",
    "-c",
    phase === "drop" ? DROP_SAVED : phase === "refresh" ? FRESH_DUMP : CHECKED_DUMP,
    "sh",
    database,
    `${DUMPS_MOUNT}/${dumpName}`,
  ];
};

/** A failed dump or check leaves the database and the instance in place. */
export class OwnDatabaseDumpFailed extends Schema.TaggedError<OwnDatabaseDumpFailed>()(
  "OwnDatabaseDumpFailed",
  { message: Schema.String },
) {}

/** The bounded command's failure, suitable for a resource status line. */
export const removalExecFailure = (result: ScopeExecResult): string | null =>
  result.timedOut
    ? "the command reached its time limit"
    : result.exitCode === 0
      ? null
      : `exit ${result.exitCode ?? "none"} · ${result.stderr.trim().split("\n").at(-1) || "the command failed"}`;

/** Saves and checks the reserved dump; archive refreshes it because the database can still change. */
export const saveRemovalDump: (
  scope: ResourceScope,
  key: string,
  worktreeId: WorktreeId,
  dumpName: string,
  refresh?: boolean,
  purpose?: "own" | "base",
) => Effect.Effect<void, OwnDatabaseDumpFailed> = Effect.fn("saveRemovalDump")(
  function* (
    scope: ResourceScope,
    key: string,
    worktreeId: WorktreeId,
    dumpName: string,
    refresh = false,
    purpose: "own" | "base" = "own",
  ) {
    const ready = removalExecFailure(
      yield* scope.exec(key, { argv: DUMPS_READY_ARGV, user: "root", timeoutMs: 30_000 }),
    );
    if (ready !== null)
      return yield* new OwnDatabaseDumpFailed({ message: `dumps volume · ${ready}` });
    const failure = removalExecFailure(
      yield* scope.exec(key, {
        argv: removalDatabaseArgv(
          refresh ? "refresh" : "save",
          worktreeDatabaseName(worktreeId, purpose),
          dumpName,
        ),
        user: "postgres",
        timeoutMs: OWN_DATABASE_TIMEOUT_MS,
      }),
    );
    if (failure !== null)
      return yield* new OwnDatabaseDumpFailed({
        message: `dump or dump check failed · ${failure}`,
      });
  },
  Effect.catchTag("SealantPlatformError", (error) =>
    Effect.fail(new OwnDatabaseDumpFailed({ message: error.message })),
  ),
);
