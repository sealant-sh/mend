#!/usr/bin/env bash
# Make lane A's copy the one place the run's agent logins are refreshed (SKILL.md, steps 3 and 6).
#
#   MEND_VERIFY_BOX_SSH='<lane A>' .agents/skills/box-main-run/refresher.sh lift
#   MEND_VERIFY_BOX_SSH='<lane A>' .agents/skills/box-main-run/refresher.sh state
#   MEND_VERIFY_BOX_SSH='<lane B or C>' .agents/skills/box-main-run/refresher.sh hold
#
# Every copy holds the same Codex and Claude logins, and a refresh spends the refresh token every
# other copy holds. So the saved data holds each login against refresh (`pnpm verify vm save` sets a
# refresh claim of 2999 that sealant's keep-fresh sweepers never take), and only lane A lifts it.
#
#   lift    clears that claim in the copy: its sweepers then refresh a login that is due, Claude's
#           within 15 minutes, Codex's on the hourly tick 60 minutes after Mend started, once its
#           access token is within 24 hours of expiry. Prints `lifted=<n>`.
#   hold    sets that claim in a copy whose data lacks it (a master built before SLNT-1216): every lane
#           but A, at once after it boots. Prints `held=<n>`.
#   state   one line per active login, non-secret columns only:
#           `login <provider> <kind> · <status> · synced <UTC> · claim held|free|<until> · <outcome>`
set -uo pipefail

verb=${1:?usage: refresher.sh lift|hold|state}
: "${MEND_VERIFY_BOX_SSH:?set MEND_VERIFY_BOX_SSH to the copy of lane A}"
read -r -a box_ssh <<<"$MEND_VERIFY_BOX_SSH"
# q <sql>: runs it in sealant's database on the copy, the SQL on stdin, one row per line.
q() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${box_ssh[@]}" \
    "docker exec -i mend-postgres-1 psql -U postgres -d sealant_control_plane -At -F ' · ' -v ON_ERROR_STOP=1" <<<"$1"
}

LIFT="update connected_accounts set refresh_claimed_until = null where refresh_claimed_until >= '2999-01-01'"
HOLD="update connected_accounts set refresh_claimed_until = '2999-01-01 00:00:00+00' where archived_at is null and kind in ('auth-json', 'credentials-json')"
read -r -d '' STATE_SQL <<'SQL'
select 'login ' || provider || ' ' || kind,
  status,
  'synced ' || coalesce(to_char(last_synced_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI"Z"'), 'never'),
  'claim ' || case when refresh_claimed_until is null then 'free'
    when refresh_claimed_until >= '2999-01-01' then 'held'
    else 'until ' || to_char(refresh_claimed_until at time zone 'utc', 'HH24:MI"Z"') end,
  coalesce(metadata->>'lastRefreshOutcome', '-')
from connected_accounts
where archived_at is null and kind in ('auth-json', 'credentials-json')
order by provider
SQL

if [[ $verb == lift ]]; then
  out=$(q "$LIFT") || { echo "lifted=failed"; exit 1; }
  echo "lifted=${out#UPDATE }"
elif [[ $verb == hold ]]; then
  out=$(q "$HOLD") || { echo "held=failed"; exit 1; }
  echo "held=${out#UPDATE }"
elif [[ $verb == state ]]; then
  q "$STATE_SQL" || exit 1
else
  echo "usage: refresher.sh lift|hold|state" >&2
  exit 2
fi
