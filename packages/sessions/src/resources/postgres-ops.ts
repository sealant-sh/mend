import {
  DUMPS_MOUNT,
  OWN_DATABASE,
  POSTGRES_USER,
  SHARED_DATABASE,
  WORKTREE_DATABASE,
} from "@mend/domain/workbench";

/**
 * The commands Mend runs inside a project's Postgres (`instances.exec`, as user `postgres`), so a
 * copy's bytes never leave its container. Each database name is passed as an argument, never
 * spliced into the script, and is checked against `WORKTREE_DATABASE` before it is.
 */

/** What the own database script found or did, on the last line of its stdout. */
export type OwnDatabaseOutcome = "exists" | "copied" | "empty";

const OWN_DATABASE_SCRIPT = `set -eu
own="$1"
shared="$2"
copy="$3"
q() { psql -X -q -At -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} "$@"; }
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$own'")" = 1 ]; then
  echo exists
  exit 0
fi
tables=0
if [ "$copy" = 1 ]; then
  tables=$(q -d "$shared" -c "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
fi
q -d postgres -c "drop database if exists \\"$own.copy\\""
q -d postgres -c "create database \\"$own.copy\\""
origin=empty
if [ "$tables" -gt 0 ]; then
  pg_dump -U ${POSTGRES_USER} -Fc -f "/tmp/$own.dump" "$shared"
  pg_restore -U ${POSTGRES_USER} --no-owner --no-acl -d "$own.copy" "/tmp/$own.dump"
  rm -f "/tmp/$own.dump"
  origin=copied
fi
q -d postgres -c "alter database \\"$own.copy\\" rename to \\"$own\\""
echo "$origin"
`;

/**
 * Makes a tracked worktree database once: a copy of shared when it has tables, empty
 * otherwise. The copy lands under a temporary name and is renamed into place, so an interrupted
 * copy never reads as made; the next run drops what it left.
 */
export const ownDatabaseArgv = (own: string, empty = false): ReadonlyArray<string> => {
  if (!WORKTREE_DATABASE.test(own))
    throw new Error(`${own} is not a tracked worktree database's name`);
  return ["sh", "-c", OWN_DATABASE_SCRIPT, "sh", own, SHARED_DATABASE, empty ? "0" : "1"];
};

/** The outcome on the script's last line, or null when it printed none. */
export const ownDatabaseOutcome = (stdout: string): OwnDatabaseOutcome | null => {
  const last = stdout.trim().split("\n").at(-1)?.trim();
  return last === "exists" || last === "copied" || last === "empty" ? last : null;
};

/** How long a copy of the shared database may take before Mend stops waiting on it. */
export const OWN_DATABASE_TIMEOUT_MS = 10 * 60 * 1000;

const RESET_SCRIPT = `set -eu
db="$1"
shared="$2"
copy="$3"
file="$4"
q() { psql -X -q -At -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} "$@"; }
saved=none
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$db'")" = 1 ]; then
  pg_dump -U ${POSTGRES_USER} -Fc -f "$file" "$db"
  pg_restore --list "$file" > /dev/null
  saved=saved
fi
q -d postgres -c "drop database if exists \\"$db\\" with (force)"
q -d postgres -c "create database \\"$db\\""
origin=empty
if [ "$copy" = 1 ] && [ "$(q -d "$shared" -c "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")" -gt 0 ]; then
  pg_dump -U ${POSTGRES_USER} -Fc -f "/tmp/$db.copy.dump" "$shared"
  pg_restore -U ${POSTGRES_USER} --no-owner --no-acl -d "$db" "/tmp/$db.copy.dump"
  rm -f "/tmp/$db.copy.dump"
  origin=copied
fi
echo "$saved $origin"
`;

/** `20261031T140200Z`: a dump's time in its file name, sortable and safe in a shell. */
export const dumpStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Where a reset saves a database's data before it empties it. */
export const dumpPath = (database: string, at: Date): string =>
  `${DUMPS_MOUNT}/${database}-${dumpStamp(at)}.dump`;

/** As root, once before a dump: the dumps volume is mounted root's, and `postgres` writes it. */
export const DUMPS_READY_ARGV: ReadonlyArray<string> = [
  "sh",
  "-c",
  `mkdir -p ${DUMPS_MOUNT} && chown ${POSTGRES_USER} ${DUMPS_MOUNT}`,
];

/**
 * Saves `database` as a custom-format dump at `file`, checks the dump reads back, then drops and
 * makes it again: empty, or copied from the shared database when `copy` is set and it has tables.
 * A database that does not exist yet is made and nothing is saved.
 */
export const resetArgv = (input: {
  readonly database: string;
  readonly copy: boolean;
  readonly file: string;
}): ReadonlyArray<string> => {
  if (input.database !== SHARED_DATABASE && !OWN_DATABASE.test(input.database)) {
    throw new Error(`${input.database} is not a database Mend resets`);
  }
  if (!/^\/mend\/dumps\/[a-z0-9_]+-\d{8}T\d{6}Z\.dump$/.test(input.file)) {
    throw new Error(`${input.file} is not a dump's path`);
  }
  return [
    "sh",
    "-c",
    RESET_SCRIPT,
    "sh",
    input.database,
    SHARED_DATABASE,
    input.copy ? "1" : "0",
    input.file,
  ];
};

/** What the reset script saved and how the database begins again, from its last line. */
export const resetOutcome = (
  stdout: string,
): { readonly saved: boolean; readonly origin: "empty" | "copied" } | null => {
  const [saved, origin] = (stdout.trim().split("\n").at(-1) ?? "").split(" ");
  if ((saved !== "saved" && saved !== "none") || (origin !== "empty" && origin !== "copied")) {
    return null;
  }
  return { saved: saved === "saved", origin };
};
