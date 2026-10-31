import { createHash } from "node:crypto";

import type { ResourceLoadId } from "@mend/domain";
import { OWN_DATABASE, SHARED_DATABASE } from "@mend/domain/workbench";

/** All scripts run inside Postgres. No dump bytes or credentials reach argv or the record. */
const Q = 'q() { psql -X -q -At -v ON_ERROR_STOP=1 -U postgres "$@"; }';
export const LOAD_TIMEOUT_MS = 60 * 60 * 1000;
export const LOAD_DIR_ARGV = [
  "sh",
  "-c",
  "mkdir -p /mend/dumps/incoming && chown -R postgres /mend/dumps",
];

/** A digest avoids collisions between UUIDs whose first eight characters happen to match. */
export const loadNames = (database: string, id: ResourceLoadId) => {
  if (database !== SHARED_DATABASE && !OWN_DATABASE.test(database))
    throw new Error("invalid load database");
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("invalid load id");
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return {
    target: database,
    temp: `${database}__load_${suffix}`,
    prev: `${database}__prev_${suffix}`,
    file: `/mend/dumps/incoming/${id}`,
  };
};
export type LoadNames = ReturnType<typeof loadNames>;
const script = (body: string, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -eu\n${Q}\n${body}`,
  "sh",
  ...args,
];

export const stageLoadArgv = (names: LoadNames) => script('cat > "$1"', [names.file]);
export const pullLoadArgv = (names: LoadNames, connection: string) =>
  script(
    'IFS= read -r PGPASSWORD\nexport PGPASSWORD\nexec pg_dump --format=custom --no-owner --no-acl --dbname="$1" --file="$2"',
    [connection, names.file],
  );
export const loadSizeArgv = (names: LoadNames) => [
  "sh",
  "-c",
  'if [ -f "$1" ]; then stat -c %s "$1"; else echo 0; fi',
  "sh",
  names.file,
];

/** Always end a previous restore's backend before dropping its database. */
export const discardLoadArgv = (names: LoadNames) =>
  script(
    'q -d postgres -c "drop database if exists \\"$1\\" with (force)"\nrm -f "$2" "$2.errors"',
    [names.temp, names.file],
  );

/**
 * psql verbose errors carry SQLSTATE. Only undefined-role errors (42704, role ... does not exist)
 * are ignored; syntax, COPY, permissions and every other error refuse installation. Stderr stays
 * in the instance; the response never echoes dump contents, which could themselves be secrets.
 */
export const restoreLoadArgv = (names: LoadNames) =>
  script(
    `tmp="$1"
file="$2"
q -d postgres -c "drop database if exists \\"$tmp\\" with (force)"
q -d postgres -c "create database \\"$tmp\\""
if [ "$(head -c 5 "$file")" = PGDMP ]; then
  pg_restore -U postgres --no-owner --no-acl --exit-on-error -d "$tmp" "$file" > /dev/null 2> "$file.errors"
else
  psql -X -U postgres -v VERBOSITY=verbose -v ON_ERROR_STOP=0 -d "$tmp" -f "$file" > /dev/null 2> "$file.errors"
  if grep 'ERROR:' "$file.errors" | grep -vE 'ERROR:  42704: role ".*" does not exist' > /dev/null; then exit 1; fi
  if grep -E 'FATAL:|PANIC:|psql:.*error:' "$file.errors" > /dev/null; then exit 1; fi
fi`,
    [names.temp, names.file],
  );

/** The three names are the installation journal, including crashes between either rename. */
export const observeLoadArgv = (names: LoadNames) =>
  script(
    `for db in "$@"; do
  if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$db'")" = 1 ]; then echo "$db"; fi
done`,
    [names.target, names.temp, names.prev],
  );

/**
 * Quiesce before counting tables, on the connection which excludes itself from termination.
 * The old database is renamed before the new one, and is dumped only after installation.
 */
export const installLoadArgv = (names: LoadNames) =>
  script(
    `target="$1"
tmp="$2"
prev="$3"
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$tmp'")" = 1 ] && [ "$(q -d postgres -c "select 1 from pg_database where datname = '$prev'")" != 1 ] && [ "$(q -d postgres -c "select 1 from pg_database where datname = '$target'")" = 1 ]; then
  tables=$(q -d "$target" <<SQL
\\! psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'alter database "$target" allow_connections false' > /dev/null
\\if :SHELL_ERROR
select 1/0;
\\endif
select pg_terminate_backend(pid) from pg_stat_activity where datname = '$target' and pid <> pg_backend_pid() \\g /dev/null
select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');
SQL
)
  if [ "$tables" -gt 0 ]; then
    q -d postgres -c "alter database \\"$target\\" rename to \\"$prev\\""
  else
    q -d postgres -c "drop database \\"$target\\" with (force)"
  fi
fi
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$tmp'")" = 1 ]; then
  q -d postgres -c "alter database \\"$tmp\\" allow_connections false" -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$tmp'"
  q -d postgres -c "alter database \\"$tmp\\" rename to \\"$target\\""
fi
q -d postgres -c "alter database \\"$target\\" allow_connections true"`,
    [names.target, names.temp, names.prev],
  );

export const allowLoadTargetArgv = (names: LoadNames) =>
  script('q -d postgres -c "alter database \\"$1\\" allow_connections true"', [names.target]);

/** A checked final file or a retained previous database always exists before it is dropped. */
export const saveLoadArgv = (names: LoadNames, path: string) =>
  script(
    `prev="$1"
file="$2"
if [ "$(q -d postgres -c "select 1 from pg_database where datname = '$prev'")" = 1 ]; then
  q -d postgres -c "alter database \\"$prev\\" allow_connections true"
  if ! pg_restore --list "$file" > /dev/null 2>&1; then
    pg_dump -U postgres -Fc -f "$file.partial" "$prev"
    pg_restore --list "$file.partial" > /dev/null
    mv "$file.partial" "$file"
  fi
  q -d postgres -c "drop database \\"$prev\\" with (force)"
fi
pg_restore --list "$file" > /dev/null`,
    [names.prev, path],
  );

export const removeIncomingArgv = (names: LoadNames) => [
  "rm",
  "-f",
  names.file,
  `${names.file}.errors`,
];
