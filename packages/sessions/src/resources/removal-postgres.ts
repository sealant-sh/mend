import { DUMPS_MOUNT, OWN_DATABASE, POSTGRES_USER } from "@mend/domain/workbench";

import { dumpStamp } from "./postgres-ops.ts";

/** Stable name reserved in the row before removal makes the dump. */
export const removalDumpName = (database: string, at: Date): string =>
  `${database}-removed-${dumpStamp(at)}.dump`;

const CHECKED_DUMP = `set -eu
db="$1"
file="$2"
if test -f "$file"; then
  pg_restore --list "$file" > /dev/null
else
  pg_dump -U ${POSTGRES_USER} -Fc -f "$file.partial" "$db"
  pg_restore --list "$file.partial" > /dev/null
  mv "$file.partial" "$file"
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
  phase: "save" | "drop",
  database: string,
  dumpName: string,
): ReadonlyArray<string> => {
  if (
    !OWN_DATABASE.test(database) ||
    !/^own_[a-f0-9]{12}-removed-\d{8}T\d{6}Z\.dump$/.test(dumpName) ||
    !dumpName.startsWith(`${database}-removed-`)
  ) {
    throw new Error("invalid own database removal path");
  }
  return [
    "sh",
    "-c",
    phase === "save" ? CHECKED_DUMP : DROP_SAVED,
    "sh",
    database,
    `${DUMPS_MOUNT}/${dumpName}`,
  ];
};
