#!/bin/sh
# Linux Docker smoke: starts only the bundle and Postgres with uniquely named resources.
set -eu

SCRIPT_DIR=$(
  unset CDPATH
  cd -- "$(dirname -- "$0")" && pwd
)
TOKEN="mend-bundle-smoke-$(node -p 'crypto.randomUUID()')"
PROJECT=$(printf '%s' "$TOKEN" | tr -c 'a-z0-9_-' '-')
ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/$PROJECT.env.XXXXXX")
STORE_VOLUME="$PROJECT-store"
CONTROL_VOLUME="$PROJECT-control"
IMAGE_REPOSITORY=${MEND_SMOKE_IMAGE_REPOSITORY:-mend-bundle-packaging}
IMAGE_VERSION=${MEND_SMOKE_IMAGE_VERSION:-test}

secret_hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

free_port() {
  node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

WEB_PORT=$(free_port)
SSH_PORT=$(free_port)

cat >"$ENV_FILE" <<EOF
MEND_IMAGE_REPOSITORY=$IMAGE_REPOSITORY
MEND_VERSION=$IMAGE_VERSION
APP_URL=http://localhost:$WEB_PORT
MEND_ALLOWED_ORIGINS=[]
MEND_BIND_HOST=127.0.0.1
MEND_PORT=$WEB_PORT
MEND_SSH_PORT=$SSH_PORT
SEALANT_SSH_HOST=localhost
MEND_POSTGRES_ADMIN_PASSWORD=$(secret_hex)
MEND_DB_PASSWORD=$(secret_hex)
SEALANT_DB_PASSWORD=$(secret_hex)
BETTER_AUTH_SECRET=$(secret_hex)
WORKSPACE_SSH_GATEWAY_TOKEN=$(secret_hex)
SEALANT_SERVICE_KEY=slt_svc_$(secret_hex)
SEALANT_CREDENTIALS_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
MEND_STORE_VOLUME_NAME=$STORE_VOLUME
MEND_CONTROL_VOLUME_NAME=$CONTROL_VOLUME
EOF
chmod 600 "$ENV_FILE"

compose() {
  docker compose --project-name "$PROJECT" --project-directory "$SCRIPT_DIR" \
    --env-file "$ENV_FILE" -f "$SCRIPT_DIR/compose.v2.yaml" "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color --tail 300 >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$STORE_VOLUME" "$CONTROL_VOLUME" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  exit "$status"
}
trap cleanup EXIT INT TERM

docker volume create --label "dev.sealant.mend.smoke=$TOKEN" "$STORE_VOLUME" >/dev/null
docker volume create --label "dev.sealant.mend.smoke=$TOKEN" "$CONTROL_VOLUME" >/dev/null
compose up --detach --wait --wait-timeout 240

running=$(compose ps --services --status running | sort)
expected=$(printf 'mend\npostgres')
[ "$running" = "$expected" ] || {
  compose ps
  printf 'expected only mend and postgres, got:\n%s\n' "$running" >&2
  exit 1
}
[ "$(docker ps --quiet --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" = 2 ]

MEND_SMOKE_EXPECTED_VERSION=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE_REPOSITORY:$IMAGE_VERSION")
MEND_SMOKE_HEALTH_URL="http://127.0.0.1:$WEB_PORT/api/health"
export MEND_SMOKE_EXPECTED_VERSION MEND_SMOKE_HEALTH_URL
node --input-type=module -e '
  const response = await fetch(process.env.MEND_SMOKE_HEALTH_URL);
  if (!response.ok) throw Error(`Health returned ${response.status}`);
  const body = await response.json();
  if (body.status !== "ok" || body.version !== process.env.MEND_SMOKE_EXPECTED_VERSION) {
    throw Error("Health must identify the running image version");
  }
'
# No registry: the only published ports are web and SSH.
[ "$(docker port "$(compose ps --quiet mend)" | wc -l | tr -d ' ')" = 2 ]
# Sealant answers through Mend's process tree.
compose exec --no-TTY mend node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>{if(!r.ok)throw Error(String(r.status))})"

compose exec --no-TTY postgres psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "SELECT datname FROM pg_database WHERE datname IN ('mend','sealant_control_plane') ORDER BY datname" |
  grep -Fx 'mend' >/dev/null
compose exec --no-TTY postgres psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "SELECT datname FROM pg_database WHERE datname IN ('mend','sealant_control_plane') ORDER BY datname" |
  grep -Fx 'sealant_control_plane' >/dev/null

compose exec --no-TTY mend sh -c 'printf smoke > /var/lib/mend/store/.bundle-smoke'
host_key_before=$(compose exec --no-TTY mend sha256sum /var/lib/mend/ssh/ssh_gateway_host_key | cut -d' ' -f1)
compose restart mend >/dev/null
compose up --detach --wait --wait-timeout 240 mend >/dev/null
compose exec --no-TTY mend grep -Fx smoke /var/lib/mend/store/.bundle-smoke >/dev/null
host_key_after=$(compose exec --no-TTY mend sha256sum /var/lib/mend/ssh/ssh_gateway_host_key | cut -d' ' -f1)
[ "$host_key_before" = "$host_key_after" ]

# A supporting-process exit must fail the bundle so Docker restarts every process as one unit.
container=$(compose ps --quiet mend)
restart_count=$(docker inspect --format '{{.RestartCount}}' "$container")
compose exec --no-TTY mend sh -c 'pid=$(pgrep -f "^node /opt/sealant/ssh-gateway/dist/index.js"); test -n "$pid"; kill "$pid"'
i=0
while :; do
  current_count=$(docker inspect --format '{{.RestartCount}}' "$container")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
  [ "$current_count" -gt "$restart_count" ] && [ "$health" = healthy ] && break
  i=$((i + 1))
  [ "$i" -lt 120 ] || {
    printf 'bundle did not recover after the SSH gateway child exited\n' >&2
    exit 1
  }
  sleep 1
done
compose exec --no-TTY mend grep -Fx smoke /var/lib/mend/store/.bundle-smoke >/dev/null

printf 'bundle smoke passed: %s (web %s, ssh %s)\n' "$PROJECT" "$WEB_PORT" "$SSH_PORT"
