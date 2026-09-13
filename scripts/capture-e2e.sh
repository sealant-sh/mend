#!/usr/bin/env bash
# The capture-mode proof (docs/adr/0002-session-capture-store.md; decision record §4 step 3):
#
#   the API in capture mode + an S3 bucket + a Docker executor with no bind mount → adopt →
#   session → an edit in the executor → checkpoint → the change read from the summary →
#   docker kill mid-work → the reaper settles "executor lost" → resume = pickup on a fresh
#   executor → the edit survived.
#
# Every step checks an observable fact and stops at the first one that does not hold, so a
# partial run reports exactly how far the stack got. Nothing here fakes a pass.
#
# What it needs on this machine:
#   - a Sealant control plane at SEALANT_BASE_URL that launches the `capture` workspace source
#     (Core PR sealant#231) with a workspace image carrying the sealantd capture build (sealantd
#     PR #71); the executor container must be able to reach the two URLs below
#   - the Mend API in capture mode. Either it is already up on $MEND_API_URL (this script reuses
#     it) or the script starts the API process alone — never `pnpm dev`: the web dev server is
#     not part of the proof and 3105 is often held by an installed mend — from this environment:
#       MEND_SESSION_STORE=captured
#       MEND_SESSION_ENDPOINT_LISTEN=0.0.0.0:3106
#       MEND_SESSION_ENDPOINT_URL=http://<host the executor resolves>:3106
#       MEND_BLOB_STORE='s3://mend?endpoint=http://localhost:3900&region=garage'   (compose.dev.yaml)
#       MEND_BLOB_STORE_PUBLIC_URL=http://<host the executor resolves>:3900
#       AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (deploy/dev/garage-init.sh)
#     A `dir://` bucket cannot serve a Docker executor: its presigned URLs are `file://`.
#   - the dev Postgres (compose.dev.yaml) on :5434; `psql` on PATH or the `mend-dev-postgres-1`
#     container (the script falls back to `docker exec`); `jq`, `curl`, `docker`
#   - MEND_TOKEN: a bearer for the API (the dev static token `mend` when MEND_STATIC_TOKEN=mend)
#   - MEND_E2E_REPO: a small cloneable repository (default: octocat/Hello-World)
#   - MEND_E2E_HARNESS: `shell` (default) edits through `docker exec` in the executor — the proof
#     needs no model credentials; `codex` / `claude` submit a protocol turn instead and also
#     check the native resume, which needs that harness connected on the control plane.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${MEND_E2E_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/mend-capture-e2e.XXXXXX")}"
API="${MEND_API_URL:-http://localhost:3101}"
REPO="${MEND_E2E_REPO:-https://github.com/octocat/Hello-World.git}"
HARNESS="${MEND_E2E_HARNESS:-shell}"
DB="${DATABASE_URL:-postgres://mend:mend@localhost:5434/mend}"
TOKEN="${MEND_TOKEN:-mend}"
LOG="${MEND_E2E_API_LOG:-$SCRATCH/api.log}"
MARK="capture-e2e-$(date +%s)"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL · %s\n' "$*" >&2; exit 1; }
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f s", b - a }'; }
api() { curl -sS -H "authorization: Bearer $TOKEN" "$@"; }
sql() {
  if command -v psql >/dev/null 2>&1; then psql "$DB" -tAc "$1";
  else docker exec mend-dev-postgres-1 psql -U mend -d mend -tAc "$1"; fi
}
in_capture_mode() {
  curl -sf "$API/api/health" 2>/dev/null | jq -e '.sessionChannel.mode == "network"' >/dev/null 2>&1
}
executor_of() {
  # Core names the container after its own launch attempt, not the workspace id; the one fact
  # both sides share is the session id Mend puts in the workspace env (`MEND_SESSION_ID`).
  local c
  for c in $(docker ps --format '{{.Names}}' | grep '^sealant-' | grep -v -- '-docker$'); do
    if docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
      | grep -qx "MEND_SESSION_ID=$1"; then echo "$c"; return; fi
  done
}
wait_for() { # wait_for <seconds> <description> <command…>
  local seconds="$1" what="$2" deadline; deadline=$(( $(date +%s) + seconds )); shift 2
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "timed out after $seconds s waiting for $what"
    sleep 1
  done
}

step "1 · the API in capture mode ($API)"
if in_capture_mode; then
  echo "reusing the running API (log: $LOG)"
  [ -f "$LOG" ] || echo "note: no API log at $LOG — set MEND_E2E_API_LOG to watch the capture routes"
else
  [ "${MEND_SESSION_STORE:-}" = captured ] || fail "no API on $API and MEND_SESSION_STORE is not 'captured'"
  case "${MEND_BLOB_STORE:-}" in s3://*) ;; *) fail "MEND_BLOB_STORE must be an s3:// bucket for a Docker executor";; esac
  ( cd "$ROOT" && pnpm --filter @mend/api-server exec tsx watch src/main.ts > "$LOG" 2>&1 & echo $! > "$SCRATCH/api.pid" )
  wait_for 90 "the API on $API" in_capture_mode
  grep -q "sessionStore: 'captured'" "$LOG" || fail "the API is not in capture mode (see $LOG)"
fi
T0="$(now)"

step "2 · adopt $REPO"
# A previous run's project of the same name would refuse the adoption: remove it first.
for OLD in $(api "$API/api/projects" | jq -r '.[] | select(.name == "capture-e2e") | .id'); do
  api -X DELETE "$API/api/projects/$OLD" >/dev/null && echo "removed the previous capture-e2e project $OLD"
done
PROJECT="$(api -X POST "$API/api/projects" -H 'content-type: application/json' \
  -d "{\"name\":\"capture-e2e\",\"source\":\"$REPO\"}")"
PROJECT_ID="$(jq -r '.id // empty' <<<"$PROJECT")"
[ -n "$PROJECT_ID" ] || fail "adoption returned no project id: $PROJECT"
STORE_PATH="$(jq -r '.storePath // empty' <<<"$PROJECT")"
# The Docker service (a privileged dind sidecar) puts the executor on a per-workspace network,
# which cannot reach a relay on the default bridge (the host-firewall case above). The proof is
# about the capture store, not Services: switch it off for this project unless asked to keep it.
if [ "${MEND_E2E_DOCKER_SERVICE:-off}" = off ]; then
  IMAGE="$(api "$API/api/settings" | jq -c '.workspaceImage | .services.docker = false')"
  api -X PUT "$API/api/projects/$PROJECT_ID/workspace-image" -H 'content-type: application/json' \
    -d "{\"workspaceImage\":$IMAGE}" | jq -e '.' >/dev/null || fail "could not set the project's workspace image"
fi
echo "project $PROJECT_ID adopted in $(since "$T0")"

step "3 · a session: capture 0 registered, lease + chain rows, no worktree directory"
T1="$(now)"
SESSION="$(api -X POST "$API/api/projects/$PROJECT_ID/sessions" -H 'content-type: application/json' \
  -d "{\"harness\":\"$HARNESS\",\"label\":\"capture e2e\",\"name\":null,\"base\":null}")"
SESSION_ID="$(jq -r '.id // empty' <<<"$SESSION")"
WORKTREE_ID="$(jq -r '.worktreeId // empty' <<<"$SESSION")"
[ -n "$SESSION_ID" ] && [ -n "$WORKTREE_ID" ] || fail "no session/worktree id: $SESSION"
sql "select 1 from captures where worktree_id='$WORKTREE_ID' and n=0" | grep -q 1 \
  || fail "capture 0 is not registered for worktree $WORKTREE_ID"
sql "select 1 from worktree_chain where worktree_id='$WORKTREE_ID' and head_n=0" | grep -q 1 \
  || fail "the chain head is not capture 0"
if [ -n "$STORE_PATH" ] && [ -d "$STORE_PATH/worktrees" ] && [ -n "$(ls -A "$STORE_PATH/worktrees" 2>/dev/null)" ]; then
  fail "a worktree directory exists under $STORE_PATH/worktrees — this is not capture mode"
fi
echo "session $SESSION_ID · worktree $WORKTREE_ID · capture 0 in $(since "$T1")"

step "4 · launch: the executor materialises the head plan, claims the lease, heartbeats"
T2="$(now)"
if [ "$HARNESS" = shell ]; then LAUNCH='{}'; else LAUNCH="{\"mode\":\"protocol\"}"; fi
api -X POST "$API/api/sessions/$SESSION_ID/launch" -H 'content-type: application/json' -d "$LAUNCH" \
  | jq -e '.id' >/dev/null || fail "launch was refused"
lease_live() {
  sql "select 1 from worktree_leases where worktree_id='$WORKTREE_ID' and executor_id='$SESSION_ID' and expires_at > now()" | grep -q 1
}
wait_for 300 "the lease to be held by session $SESSION_ID" lease_live
EPOCH0="$(sql "select epoch from worktree_leases where worktree_id='$WORKTREE_ID'")"
CONTAINER=""
container_up() { CONTAINER="$(executor_of "$SESSION_ID")"; [ -n "$CONTAINER" ]; }
wait_for 120 "the executor container" container_up
plan_fetched() { [ -f "$LOG" ] && grep -q "POST /plan.get" "$LOG"; }
if [ -f "$LOG" ]; then wait_for 120 "plan.get on the session channel" plan_fetched; fi
docker inspect "$CONTAINER" --format '{{json .HostConfig.Binds}}' | grep -q '/workspace' \
  && fail "the executor bind-mounts a workspace path — this is not capture mode"
echo "executor $CONTAINER · epoch $EPOCH0 · lease live in $(since "$T2")"
docker exec "$CONTAINER" sh -lc 'cd /workspace/repo && git status --short --branch | head -5' || fail "no repository in the executor"

step "5 · an edit in the executor, then the first capture and a checkpoint"
T3="$(now)"
if [ "$HARNESS" = shell ]; then
  docker exec "$CONTAINER" sh -lc "cd /workspace/repo && printf '%s\n' '$MARK' >> README.md" \
    || fail "could not edit README.md in the executor"
else
  api -X POST "$API/api/sessions/$SESSION_ID/turns" -H 'content-type: application/json' \
    -d "{\"input\":\"append a line reading $MARK to README.md, then stop\"}" >/dev/null
fi
captured() { sql "select 1 from worktree_chain where worktree_id='$WORKTREE_ID' and head_n>=1" | grep -q 1; }
wait_for 120 "the first capture after the edit" captured
echo "first capture registered $(since "$T3") after the edit"
api -X POST "$API/api/sessions/$SESSION_ID/checkpoints" -H 'content-type: application/json' \
  -d '{"trigger":"user-mark"}' | jq -e '.sha' >/dev/null || fail "the checkpoint was refused"
HEAD_N="$(sql "select head_n from worktree_chain where worktree_id='$WORKTREE_ID'")"
sql "select count(*) from checkpoints where worktree_id='$WORKTREE_ID' and capture_id is not null" \
  | grep -qv '^0$' || fail "no checkpoint row names a capture"
echo "chain head n=$HEAD_N · checkpoint names a capture · $(since "$T3") since the edit"

step "6 · the change is read from the capture, stamped"
CHANGE_ID="$(api "$API/api/sessions/$SESSION_ID" | jq -r '.change.id // empty')"
[ -n "$CHANGE_ID" ] || fail "the session has no change"
DIFF="$(api "$API/api/changes/$CHANGE_ID/diff")"
jq -e '.observation.source == "capture"' <<<"$DIFF" >/dev/null || fail "the diff is not stamped from a capture: $(jq -c '.observation' <<<"$DIFF")"
jq -e --arg m "$MARK" '.diff | contains($m)' <<<"$DIFF" >/dev/null || fail "the edit is not in the observed diff"
echo "diff · $(jq -r '.observation.label' <<<"$DIFF")"

step "7 · docker kill mid-work: the lease lapses, the reaper settles 'executor lost'"
docker exec "$CONTAINER" sh -lc "cd /workspace/repo && printf '%s\n' '$MARK-second' >> README.md" >/dev/null 2>&1 || true
T4="$(now)"
docker kill "$CONTAINER" >/dev/null
lost() { api "$API/api/sessions/$SESSION_ID" | jq -e '.session.status == "failed" and (.session.summary // "" | test("executor lost"))' >/dev/null 2>&1; }
wait_for 180 "the reaper to settle the session as 'executor lost'" lost
echo "settled 'executor lost' $(since "$T4") after docker kill"

step "8 · pickup: resume launches a fresh executor on the head plan with epoch + 1"
T5="$(now)"
api -X POST "$API/api/sessions/$SESSION_ID/resume" -H 'content-type: application/json' \
  -d '{"harness":null}' | jq -e '.id' >/dev/null || fail "resume was refused"
new_epoch() { [ "$(sql "select epoch from worktree_leases where worktree_id='$WORKTREE_ID'")" -gt "$EPOCH0" ]; }
wait_for 300 "a new epoch on the lease" new_epoch
EPOCH1="$(sql "select epoch from worktree_leases where worktree_id='$WORKTREE_ID'")"
CONTAINER2=""
container2_up() { CONTAINER2="$(executor_of "$SESSION_ID")"; [ -n "$CONTAINER2" ] && [ "$CONTAINER2" != "$CONTAINER" ]; }
wait_for 120 "a fresh executor container" container2_up
wait_for 120 "the new executor's lease" lease_live
echo "pickup · epoch $EPOCH0 → $EPOCH1 · executor $CONTAINER2 · $(since "$T5") after resume"
echo "-- git status in the new executor:"
docker exec "$CONTAINER2" sh -lc 'cd /workspace/repo && git status --short --branch && git log --oneline -3 && tail -3 README.md' \
  || fail "the new executor has no repository"
docker exec "$CONTAINER2" sh -lc "grep -q '$MARK' /workspace/repo/README.md" || fail "the edit is not on the new executor's disk"
api "$API/api/changes/$CHANGE_ID/diff" | jq -e --arg m "$MARK" '.diff | contains($m)' >/dev/null \
  || fail "the edit did not survive the pickup"
if [ "$HARNESS" != shell ]; then
  api "$API/api/sessions/$SESSION_ID" | jq -e '.currentAgent.argv | index("resume") != null' >/dev/null \
    || fail "the pickup did not resume the harness natively"
fi

printf '\nPASS · capture mode end to end · total %s · scratch at %s\n' "$(since "$T0")" "$SCRATCH"
