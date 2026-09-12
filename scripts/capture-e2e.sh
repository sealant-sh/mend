#!/usr/bin/env bash
# The capture-mode proof (docs/adr/0002-session-capture-store.md; decision record §4 step 3):
#
#   pnpm dev with MEND_SESSION_STORE=captured + a dir:// bucket + a Docker executor with no bind
#   mount → adopt → session → checkpoint → review page from the summary → docker kill mid-turn
#   → pickup → resume.
#
# STATUS: written against the contract, UNVERIFIED end to end. It needs the sealantd side
# (crates/sealant-capture on branch feat/sealant-capture, sealantd PR #71) baked into the
# workspace image Sealant Core launches, and Core PR sealant#231 (the `capture` workspace
# source) on the control plane at SEALANT_BASE_URL. Every step below checks an observable fact
# and stops at the first one that does not hold, so a partial run reports exactly how far the
# stack got. Nothing here fakes a pass.
#
# Prerequisites (this machine):
#   - the dev Postgres (compose.dev.yaml) on :5434; Garage is optional — this proof uses dir://
#   - a Sealant control plane at $SEALANT_BASE_URL whose Docker runtime launches the capture
#     source; its workspace image must carry the sealantd capture build
#   - `mend` CLI logged in against the dev API (`mend login`), `jq`, `curl`, `docker`
#   - a throwaway repository URL in $MEND_E2E_REPO (default: this checkout's origin)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${MEND_E2E_SCRATCH:-$(mktemp -d /tmp/mend-capture-e2e.XXXXXX)}"
API="${MEND_API_URL:-http://localhost:3101}"
ENDPOINT_LISTEN="${MEND_SESSION_ENDPOINT_LISTEN:-0.0.0.0:3106}"
ENDPOINT_URL="${MEND_SESSION_ENDPOINT_URL:-http://host.docker.internal:3106}"
REPO="${MEND_E2E_REPO:-$(git -C "$ROOT" remote get-url origin)}"
BLOBS="$SCRATCH/blobs"
mkdir -p "$BLOBS"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL · %s\n' "$*" >&2; exit 1; }
api() { curl -sS -H "authorization: Bearer ${MEND_TOKEN:?set MEND_TOKEN (mend login prints it)}" "$@"; }

step "1 · dev loop in capture mode (dir:// bucket at $BLOBS)"
export MEND_SESSION_STORE=captured
export MEND_BLOB_STORE="dir://$BLOBS"
export MEND_SESSION_ENDPOINT_LISTEN="$ENDPOINT_LISTEN"
export MEND_SESSION_ENDPOINT_URL="$ENDPOINT_URL"
( cd "$ROOT" && pnpm dev > "$SCRATCH/dev.log" 2>&1 & echo $! > "$SCRATCH/dev.pid" )
for _ in $(seq 1 60); do
  curl -sf "$API/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/api/health" >/dev/null || fail "the API did not come up on $API (see $SCRATCH/dev.log)"
grep -q "sessionStore: 'captured'" "$SCRATCH/dev.log" || fail "the API is not in capture mode"
grep -q "network endpoint listening" "$SCRATCH/dev.log" || fail "the session channel is not listening"

step "2 · adopt $REPO"
PROJECT_ID="$(api -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d "{\"name\":\"capture-e2e\",\"url\":\"$REPO\"}" | jq -r .id)"
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != null ] || fail "adoption returned no project id"

step "3 · provision a session: capture 0 must register, no worktree directory"
SESSION="$(api -X POST "$API/api/projects/$PROJECT_ID/sessions" -H 'content-type: application/json' \
  -d '{"harness":"codex","label":"capture e2e","name":null,"base":null}')"
SESSION_ID="$(jq -r .id <<<"$SESSION")"
WORKTREE_ID="$(jq -r .worktreeId <<<"$SESSION")"
[ -n "$SESSION_ID" ] || fail "no session id"
ls "$BLOBS/captures/$WORKTREE_ID/1/manifests/" >/dev/null 2>&1 || fail "capture 0 manifest is not in the bucket"
[ ! -d "$HOME/.config/mend/store/capture-e2e/worktrees" ] || fail "a worktree directory exists — this is not capture mode"

step "4 · launch: the executor must claim the lease and heartbeat"
api -X POST "$API/api/sessions/$SESSION_ID/launch" -H 'content-type: application/json' \
  -d '{"argv":["codex"]}' >/dev/null
for _ in $(seq 1 90); do
  grep -q "plan.get\|capture plan fetched" "$SCRATCH/dev.log" 2>/dev/null && break
  sleep 1
done
psql "${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}" -tAc \
  "select executor_id, epoch, expires_at > now() from worktree_leases where worktree_id='$WORKTREE_ID'" \
  | grep -q "^$SESSION_ID|" || fail "the lease is not held by the session's executor"

step "5 · a turn, then a checkpoint: the chain must advance and the checkpoint row name a capture"
api -X POST "$API/api/sessions/$SESSION_ID/turns" -H 'content-type: application/json' \
  -d '{"input":"append a line reading capture-e2e to README.md and stop"}' >/dev/null
sleep 30
api -X POST "$API/api/sessions/$SESSION_ID/checkpoint" >/dev/null
HEAD_N="$(psql "${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}" -tAc \
  "select head_n from worktree_chain where worktree_id='$WORKTREE_ID'")"
[ "${HEAD_N:-0}" -ge 1 ] || fail "the chain head did not advance past capture 0 (head_n=$HEAD_N)"
psql "${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}" -tAc \
  "select count(*) from checkpoints where worktree_id='$WORKTREE_ID' and capture_id is not null" \
  | grep -qv '^0$' || fail "no checkpoint row names a capture"

step "6 · the review page reads the change from the summary or the runner, stamped"
CHANGE_ID="$(api "$API/api/sessions/$SESSION_ID" | jq -r .change.id)"
DIFF="$(api "$API/api/changes/$CHANGE_ID/diff")"
jq -e '.observation.label | test("observed at capture|claimed at capture")' <<<"$DIFF" >/dev/null \
  || fail "the change diff carries no observation stamp"
jq -e '.diff | test("capture-e2e")' <<<"$DIFF" >/dev/null || fail "the edit is not in the observed diff"

step "7 · docker kill mid-turn: the lease lapses and the reaper settles 'executor lost'"
api -X POST "$API/api/sessions/$SESSION_ID/turns" -H 'content-type: application/json' \
  -d '{"input":"append another line and keep going"}' >/dev/null
sleep 5
CONTAINER="$(docker ps --format '{{.Names}}' | grep -m1 "mend-${SESSION_ID:0:8}" || true)"
[ -n "$CONTAINER" ] || fail "no executor container named mend-${SESSION_ID:0:8}"
docker kill "$CONTAINER" >/dev/null
for _ in $(seq 1 60); do
  api "$API/api/sessions/$SESSION_ID" | jq -e '.session.status == "failed"' >/dev/null 2>&1 && break
  sleep 2
done
api "$API/api/sessions/$SESSION_ID" | jq -e '.session.summary | test("executor lost")' >/dev/null \
  || fail "the reaper did not settle the session as 'executor lost'"

step "8 · pickup: resume launches a new executor with the head plan, epoch + 1, native resume"
EPOCH_BEFORE="$(psql "${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}" -tAc \
  "select epoch from worktree_leases where worktree_id='$WORKTREE_ID'")"
api -X POST "$API/api/sessions/$SESSION_ID/resume" -H 'content-type: application/json' -d '{}' >/dev/null
sleep 20
EPOCH_AFTER="$(psql "${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}" -tAc \
  "select epoch from worktree_leases where worktree_id='$WORKTREE_ID'")"
[ "$EPOCH_AFTER" -gt "$EPOCH_BEFORE" ] || fail "the pickup did not claim a new epoch"
api "$API/api/sessions/$SESSION_ID" | jq -e '.currentAgent.argv | index("resume") != null' >/dev/null \
  || fail "the pickup did not resume the harness natively"
api "$API/api/changes/$CHANGE_ID/diff" | jq -e '.diff | test("capture-e2e")' >/dev/null \
  || fail "the edit did not survive the pickup"

printf '\nPASS · capture mode end to end · scratch at %s\n' "$SCRATCH"
