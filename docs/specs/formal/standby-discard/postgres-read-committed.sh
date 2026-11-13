#!/usr/bin/env bash
# What Postgres does when HotWorkspacesRepo's claim and retire race, observed on a throwaway
# database: the facts StandbyDiscard.tla's CScan/CTake and DRetireScan/DRetireApply rest on.
# The statements are the repository's, written out by hand (packages/db/src/repos/hot-workspaces.ts).
# An open transaction holds a row lock where the code's statement would still be running, and a
# `pg_sleep` inside a statement opens the gap between its snapshot and its row lock.
#
# Postgres comes from the repository's pinned nixpkgs when Nix is installed, else from PATH. The
# database lives in a new temporary directory, on a Unix socket only, and is deleted afterwards.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)

if [[ "${1:-}" != "--inside" ]]; then
  if command -v nix >/dev/null && ! command -v initdb >/dev/null; then
    exec nix shell --inputs-from "$root" nixpkgs#postgresql -c bash "$0" --inside
  fi
  exec bash "$0" --inside
fi

dir=$(mktemp -d -t standby-discard-pg.XXXXXX)
initdb -D "$dir/data" -A trust -U fv >/dev/null
pg_ctl -D "$dir/data" -o "-c listen_addresses='' -k $dir -p 54329" -l "$dir/pg.log" -w start >/dev/null
trap 'pg_ctl -D "$dir/data" -m fast stop >/dev/null 2>&1 || true; rm -rf -- "$dir"' EXIT
psql_() { psql -h "$dir" -p 54329 -U fv -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "$(postgres --version) · default_transaction_isolation = $(psql_ -At -c 'show default_transaction_isolation')"

reset() {
  psql_ <<'SQL'
SET client_min_messages = warning;
DROP TABLE IF EXISTS hot_workspaces;
CREATE TABLE hot_workspaces (id text PRIMARY KEY, project_id text NOT NULL, owner_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'warming', error text, fingerprint text NOT NULL,
  sealant_workspace_id text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO hot_workspaces (id, project_id, owner_user_id, status, fingerprint, sealant_workspace_id)
  VALUES ('s1', 'p', 'u', 'ready', 'f', 'w1');
SQL
}
candidates="SELECT id FROM hot_workspaces WHERE project_id = 'p' AND status = 'ready' AND fingerprint = 'f' AND owner_user_id = 'u'"
claim="UPDATE hot_workspaces SET status = 'claimed', updated_at = now() WHERE id IN ($candidates ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id"
claim_slow="UPDATE hot_workspaces SET status = 'claimed', updated_at = now() WHERE id IN ($candidates AND (SELECT pg_sleep(2)) IS NOT NULL ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id"
retire="UPDATE hot_workspaces SET status = 'failed', error = 'ending', updated_at = now() WHERE id = 's1' AND status <> 'claimed' RETURNING id"
retire_slow="UPDATE hot_workspaces SET status = 'failed', error = 'ending', updated_at = now() WHERE id = (SELECT 's1'::text FROM pg_sleep(2)) AND status <> 'claimed' RETURNING id"
set_failed="UPDATE hot_workspaces SET status = 'failed', error = 'draining', updated_at = now() WHERE id = 's1'"
rows() { psql_ -At -c "$1" | grep -c . || true; }
now_status() { psql_ -At -c "SELECT status FROM hot_workspaces WHERE id = 's1'"; }

echo
echo "E1  retire meets the row locked by a claim still running; it waits, then re-checks its WHERE on the version the claim committed"
reset
psql_ -At -c "BEGIN; $claim; SELECT pg_sleep(2); COMMIT;" >/dev/null &
sleep 0.5
r=$(rows "$retire")
wait
echo "    retire: $r row(s) · row: $(now_status)"

echo "E2  claim meets the row locked by a retire still running; SKIP LOCKED passes it by"
reset
psql_ -At -c "BEGIN; $retire; SELECT pg_sleep(2); COMMIT;" >/dev/null &
sleep 0.5
c=$(rows "$claim")
wait
echo "    claim: $c row(s) · row: $(now_status)"

echo "E3  claim's snapshot has the row ready; a retire commits before the claim locks it; the claim re-checks and takes nothing"
reset
rows "$claim_slow" >"$dir/e3" &
sleep 0.5
r=$(rows "$retire")
wait
echo "    retire: $r row(s) · claim: $(cat "$dir/e3") row(s) · row: $(now_status)"

echo "E4  retire's snapshot has the row ready; a claim commits before the retire locks it; the retire re-checks and takes nothing"
reset
rows "$retire_slow" >"$dir/e4" &
sleep 0.5
c=$(rows "$claim")
wait
echo "    claim: $c row(s) · retire: $(cat "$dir/e4") row(s) · row: $(now_status)"

echo "E5  retire's snapshot has the row claimed; setFailed commits before the retire reaches it; the retire takes nothing"
reset
psql_ -c "UPDATE hot_workspaces SET status = 'claimed' WHERE id = 's1'"
rows "$retire_slow" >"$dir/e5" &
sleep 0.5
psql_ -c "$set_failed"
wait
echo "    retire: $(cat "$dir/e5") row(s) · row: $(now_status)"

echo "E6  retire's snapshot has the row ready; a claim, then setFailed, commit before the retire locks it; the retire takes the row"
reset
rows "$retire_slow" >"$dir/e6" &
sleep 0.5
c=$(rows "$claim")
psql_ -c "$set_failed"
wait
echo "    claim: $c row(s) · retire: $(cat "$dir/e6") row(s) · row: $(now_status)"

echo "E7  one statement after another: claim, setFailed (no status condition), retire"
reset
c=$(rows "$claim")
psql_ -c "$set_failed"
r=$(rows "$retire")
echo "    claim: $c row(s) · retire: $r row(s) · row: $(now_status)"
