command=$1
# shellcheck source=/dev/null
source "$2"

env_file=/run/mend/server.env

fail() {
  echo "mend: $*" >&2
  exit 1
}

compose() {
  local args=(--project-name mend --project-directory "$compose_dir" --env-file "$env_file")
  local file
  for file in "${compose_files[@]}"; do args+=(-f "$file"); done
  docker-compose "${args[@]}" "$@"
}

if [[ $command == stop ]]; then
  if [[ -e $env_file ]]; then
    compose stop
  else
    mapfile -t running < <(docker ps --quiet --filter label=com.docker.compose.project=mend)
    if ((${#running[@]} > 0)); then docker stop "${running[@]}"; fi
  fi
  exit 0
fi
[[ $command == start ]] || fail "unknown command $command"

umask 077
install -d -m 0700 "$state_dir"

if [[ ! -e $identity ]]; then
  [[ $generate_identity == 1 ]] || fail "services.mend.secretsFile is $identity, which does not exist."
  install -d -m 0700 "$(dirname "$identity")"
  draft=$(mktemp "$identity.XXXXXX")
  {
    printf 'MEND_POSTGRES_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'MEND_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'SEALANT_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'SEALANT_CREDENTIALS_KEY=%s\n' "$(openssl rand -base64 32)"
    printf 'SEALANT_SERVICE_KEY=slt_svc_%s\n' "$(openssl rand -hex 32)"
    printf 'WORKSPACE_SSH_GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } >"$draft"
  sync "$draft"
  mv "$draft" "$identity"
  echo "mend: generated this install's identity at $identity. Back it up: it owns the data volumes."
fi

declare -A secret=()
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z $line ]] && continue
  key=${line%%=*}
  [[ $line == *=* && -n $key ]] || fail "$identity has a malformed line; each line is KEY=value."
  [[ -z ${secret[$key]+set} ]] || fail "$identity names $key more than once."
  secret[$key]=${line#*=}
done <"$identity"

hex64='^[0-9a-f]{64}$'
for key in MEND_POSTGRES_ADMIN_PASSWORD MEND_DB_PASSWORD SEALANT_DB_PASSWORD BETTER_AUTH_SECRET WORKSPACE_SSH_GATEWAY_TOKEN; do
  [[ ${secret[$key]:-} =~ $hex64 ]] || fail "$identity: $key is missing or is not 64 lowercase hex characters."
done
[[ ${secret[SEALANT_SERVICE_KEY]:-} =~ ^slt_svc_[0-9a-f]{64}$ ]] ||
  fail "$identity: SEALANT_SERVICE_KEY is missing or is not slt_svc_ followed by 64 lowercase hex characters."
[[ ${secret[SEALANT_CREDENTIALS_KEY]:-} =~ ^[0-9A-Za-z+/]{43}=$ ]] ||
  fail "$identity: SEALANT_CREDENTIALS_KEY is missing or is not 32 bytes as base64."

# HMAC-SHA256 under a hex key, built from sha256sum so the key never appears in a process's
# arguments, where any local user could read it.
hmac_sha256_hexkey() {
  local key=$1 message=$2 i byte escaped ipad="" opad="" inner inner_bytes=""
  for ((i = 0; i < 128; i += 2)); do
    byte=0
    if ((i < ${#key})); then byte=$((16#${key:i:2})); fi
    printf -v escaped '\\x%02x' $((byte ^ 0x36))
    ipad+=$escaped
    printf -v escaped '\\x%02x' $((byte ^ 0x5c))
    opad+=$escaped
  done
  read -r inner _ < <({
    printf '%b' "$ipad"
    printf '%s' "$message"
  } | sha256sum)
  for ((i = 0; i < 64; i += 2)); do inner_bytes+="\\x${inner:i:2}"; done
  read -r inner _ < <({
    printf '%b' "$opad"
    printf '%b' "$inner_bytes"
  } | sha256sum)
  printf '%s' "$inner"
}

auth=${secret[BETTER_AUTH_SECRET]}
garage_rpc_secret=$(hmac_sha256_hexkey "$auth" mend-garage-rpc-secret)
garage_admin_token=$(hmac_sha256_hexkey "$auth" mend-garage-admin-token)
garage_key_id=GK$(hmac_sha256_hexkey "$auth" mend-garage-key-id | cut -c1-24)
garage_key_secret=$(hmac_sha256_hexkey "$auth" mend-garage-key-secret)

account_marker=$state_dir/first-account
render_env() {
  local origins=$allowed_origins draft
  if [[ $1 == tunnel ]]; then origins=$(jq --compact-output --arg o "$tunnel_origin" '. + [$o] | unique' <<<"$origins"); fi
  draft=$(mktemp "$env_file.XXXXXX")
  {
    cat "$static_env"
    printf 'MEND_ALLOWED_ORIGINS=%s\n' "$origins"
    for key in MEND_POSTGRES_ADMIN_PASSWORD MEND_DB_PASSWORD SEALANT_DB_PASSWORD BETTER_AUTH_SECRET SEALANT_CREDENTIALS_KEY SEALANT_SERVICE_KEY WORKSPACE_SSH_GATEWAY_TOKEN; do
      printf '%s=%s\n' "$key" "${secret[$key]}"
    done
    printf 'MEND_GARAGE_RPC_SECRET=%s\n' "$garage_rpc_secret"
    printf 'MEND_GARAGE_ADMIN_TOKEN=%s\n' "$garage_admin_token"
    printf 'MEND_GARAGE_KEY_ID=%s\n' "$garage_key_id"
    printf 'MEND_GARAGE_KEY_SECRET=%s\n' "$garage_key_secret"
  } >"$draft"
  mv "$draft" "$env_file"
}

origins_mode=configured
if [[ ! -e $account_marker ]]; then origins_mode=tunnel; fi
render_env "$origins_mode"

owner=$(sha256sum <"$identity" | cut -d' ' -f1)
for volume in mend-store mend-control mend-garage; do
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume create --label "dev.sealant.mend.installation=$owner" "$volume" >/dev/null
  fi
  label=$(docker volume inspect --format '{{index .Labels "dev.sealant.mend.installation"}}' "$volume")
  [[ $label == "$owner" ]] ||
    fail "Docker volume $volume belongs to another Mend identity (or to none). Its data stays. Point services.mend.secretsFile at the identity.env that owns it, or move the volume aside yourself."
done

report_failed_start() {
  local status=$?
  ((status == 0)) && return
  local log
  log=$(docker logs "$mend_container" 2>&1) || true
  echo "mend: the start failed. The Mend container's errors, then the last lines of its log:" >&2
  grep -E '\bERROR\b|FATAL|Refused' <<<"$log" | tail -n 20 | sed 's/^/mend container: /' >&2 || true
  tail -n 20 <<<"$log" | sed 's/^/mend container: /' >&2
}
trap report_failed_start EXIT

mapfile -t services < <(compose config --services)
gated=()
for service in "${services[@]}"; do
  [[ $edge == 1 && $service == edge ]] || gated+=("$service")
done

for stray in edge npm-mirror docker-mirror; do
  [[ " ${services[*]} " == *" $stray "* ]] && continue
  mapfile -t containers < <(docker container ls --all --quiet \
    --filter label=com.docker.compose.project=mend --filter "label=com.docker.compose.service=$stray")
  if ((${#containers[@]} > 0)); then
    docker container rm --force "${containers[@]}" >/dev/null
    echo "mend: removed the $stray container, which this configuration does not run."
  fi
done

up_core() { compose up --detach --wait --wait-timeout 900 --pull missing --no-build "${gated[@]}"; }
echo "mend: starting Mend $version (${gated[*]})"
up_core

garage() { compose exec -T garage /garage -c /etc/garage.toml "$@"; }
node=$(garage status | grep -oE '^[0-9a-f]{16}\b' | head -n1)
[[ -n $node ]] || fail "Garage reported no node in its status."
# Each of these answers an error once it already holds; bucket info below is the check.
garage layout assign -z mend -c 1GB "$node" >/dev/null 2>&1 || true
garage layout apply --version 1 >/dev/null 2>&1 || true
garage bucket create mend >/dev/null 2>&1 || true
garage key import --yes -n mend "$garage_key_id" "$garage_key_secret" >/dev/null 2>&1 || true
garage bucket allow --read --write --owner mend --key mend >/dev/null
garage bucket info mend | grep -q "$garage_key_id" || fail "Garage bucket mend is not readable by Mend's key."

auth_text_hex=""
for ((i = 0; i < ${#auth}; i++)); do
  printf -v byte '%02x' "'${auth:i:1}"
  auth_text_hex+=$byte
done
instance=$(hmac_sha256_hexkey "$auth_text_hex" 'mend instance id' | cut -c1-32)
wait_health() {
  local health
  for _ in $(seq 150); do
    health=$(curl --silent --max-time 3 "$health_origin/api/health" || true)
    if jq --exit-status --arg v "$version" --arg i "$instance" \
      '.status == "ok" and .version == $v and (.instance == null or .instance == $i)' \
      <<<"$health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  fail "Mend started, but $health_origin/api/health did not answer as this install."
}
wait_health
echo "mend: Mend $version answers at $health_origin"

users=$(curl --silent --fail --max-time 5 "$health_origin/api/instance" | jq -r .users) || true
case $users in
some)
  touch "$account_marker"
  if [[ $origins_mode == tunnel ]]; then
    render_env configured
    up_core
    wait_health
    echo "mend: the first account exists, so Mend no longer allows $tunnel_origin"
  fi
  if [[ $edge == 1 ]]; then
    compose up --detach --wait --wait-timeout 300 --pull missing --no-build edge
    echo "mend: the edge serves $app_url"
  fi
  ;;
none)
  rm -f "$account_marker"
  if [[ $origins_mode != tunnel ]]; then
    render_env tunnel
    up_core
    wait_health
  fi
  if [[ $edge == 1 ]]; then
    mapfile -t containers < <(docker container ls --all --quiet \
      --filter label=com.docker.compose.project=mend --filter label=com.docker.compose.service=edge)
    if ((${#containers[@]} > 0)); then docker container rm --force "${containers[@]}" >/dev/null; fi
    echo "mend: the edge stays down until the first account exists, since until then registration is open to whoever reaches $app_url first."
  fi
  echo "mend: no account exists yet. $first_account_hint"
  ;;
*)
  [[ $edge == 1 ]] && fail "$health_origin/api/instance did not say whether an account exists, so the edge stays down."
  echo "mend: $health_origin/api/instance did not say whether an account exists."
  ;;
esac
