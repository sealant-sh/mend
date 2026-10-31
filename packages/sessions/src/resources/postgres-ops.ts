import { OWN_DATABASE, POSTGRES_USER, SHARED_DATABASE } from "@mend/domain/workbench";

/**
 * The commands Mend runs inside a project's Postgres (`instances.exec`, as user `postgres`), so a
 * copy's bytes never leave its container. Each database name is passed as an argument, never
 * spliced into the script, and is checked against `OWN_DATABASE` before it is.
 */

/** What the own database script found or did, on the last line of its stdout. */
export type OwnDatabaseOutcome = "exists" | "copied" | "empty";

const OWN_DATABASE_SCRIPT = `set -eu
own="$1"
shared="$2"
q() { psql -X -q -At -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} "$@"; }
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$own'")" = 1 ]; then
  echo exists
  exit 0
fi
tables=$(q -d "$shared" -c "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
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
 * Makes a worktree's own database once: a copy of the shared database when it has tables, empty
 * otherwise. The copy lands under a temporary name and is renamed into place, so an interrupted
 * copy never reads as made; the next run drops what it left.
 */
export const ownDatabaseArgv = (own: string): ReadonlyArray<string> => {
  if (!OWN_DATABASE.test(own)) throw new Error(`${own} is not an own database's name`);
  return ["sh", "-c", OWN_DATABASE_SCRIPT, "sh", own, SHARED_DATABASE];
};

/** The outcome on the script's last line, or null when it printed none. */
export const ownDatabaseOutcome = (stdout: string): OwnDatabaseOutcome | null => {
  const last = stdout.trim().split("\n").at(-1)?.trim();
  return last === "exists" || last === "copied" || last === "empty" ? last : null;
};

/** How long a copy of the shared database may take before Mend stops waiting on it. */
export const OWN_DATABASE_TIMEOUT_MS = 10 * 60 * 1000;
