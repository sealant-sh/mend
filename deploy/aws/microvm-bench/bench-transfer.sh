#!/usr/bin/env bash
# Bucket ↔ executor transfer benchmark (decision R1, AWS half): how fast can a
# MicroVM pull a 1 GiB object out of S3 and push one back, against the VM's
# own disk as the ceiling. Nothing here needs AWS credentials: the object
# moves over presigned URLs only, so the execution role stays logs-only.
#
# Inputs (env):
#   BENCH_GET_URL     presigned GET of the 1 GiB object
#   BENCH_PUT_URL     presigned PUT for a fresh key
#   BENCH_S3_URI      s3://bucket/key of the object (recorded, not used: no aws cli/creds in the VM)
#   BENCH_SIZE        expected object size in bytes (default 1 GiB)
#   BENCH_PARALLEL    number of parallel range GETs (default 8)
#   BENCH_EGRESS      label for the egress configuration (recorded)
#   BENCH_ID          identifier for this run
#
# Output: one JSON document on stdout, progress on stderr. curl's -w values are
# bytes per second; the results file keeps them raw and the summary converts.
set -uo pipefail

GET_URL="${BENCH_GET_URL:?}"
PUT_URL="${BENCH_PUT_URL:?}"
S3_URI="${BENCH_S3_URI:-}"
SIZE="${BENCH_SIZE:-1073741824}"
PARALLEL="${BENCH_PARALLEL:-8}"
EGRESS="${BENCH_EGRESS:-unknown}"
ID="${BENCH_ID:-$(date +%s)}"
WORK="${BENCH_WORK:-/tmp}"
BLOB="$WORK/blob"

log() { echo "transfer: $*" >&2; }
now_ms() { date +%s%3N; }

declare -A R
set_r() { R["$1"]="$2"; log "$1 = $2"; }

# curl_w <name> <curl args...>: run curl once, record time_total/speed/size/code.
curl_w() {
  local name="$1"; shift
  local out
  out="$(curl -sS -w '%{time_total} %{time_starttransfer} %{speed_download} %{speed_upload} %{size_download} %{size_upload} %{http_code} %{remote_ip}' "$@" 2>>"$WORK/curl-$name.err")"
  local rc=$?
  read -r t ttfb sd su szd szu code ip <<<"$out"
  set_r "$name.time_s" "${t:-0}"
  set_r "$name.ttfb_s" "${ttfb:-0}"
  set_r "$name.speed_down_bps" "${sd:-0}"
  set_r "$name.speed_up_bps" "${su:-0}"
  set_r "$name.size_down" "${szd:-0}"
  set_r "$name.size_up" "${szu:-0}"
  set_r "$name.http_code" "\"${code:-000}\""
  set_r "$name.remote_ip" "\"${ip:-}\""
  set_r "$name.curl_rc" "$rc"
  [[ -s "$WORK/curl-$name.err" ]] && set_r "$name.error" "\"$(tr -d '"\n' <"$WORK/curl-$name.err" | head -c 300)\""
  return $rc
}

# ---- system facts --------------------------------------------------------
set_r "sys.nproc" "$(nproc)"
set_r "sys.arch" "\"$(uname -m)\""
set_r "sys.kernel" "\"$(uname -r)\""
set_r "sys.mem_total_mib" "$(free -m | awk '/^Mem:/{print $2}')"
set_r "sys.mem_avail_mib" "$(free -m | awk '/^Mem:/{print $7}')"
set_r "sys.tmp_fs" "\"$(df -hT "$WORK" | awk 'NR==2{print $1" "$2" size="$3" avail="$5}')\""
set_r "sys.root_fs" "\"$(df -hT / | awk 'NR==2{print $1" "$2" size="$3" avail="$5}')\""
set_r "sys.inotify_watches_before" "$(sysctl -n fs.inotify.max_user_watches 2>/dev/null || echo -1)"
if sysctl -w fs.inotify.max_user_watches=524288 >/dev/null 2>"$WORK/sysctl.err"; then
  set_r "sys.inotify_raise_ok" "true"
else
  set_r "sys.inotify_raise_ok" "false"
  set_r "sys.inotify_raise_error" "\"$(tr -d '"\n' <"$WORK/sysctl.err" | head -c 200)\""
fi
set_r "sys.inotify_watches_after" "$(sysctl -n fs.inotify.max_user_watches 2>/dev/null || echo -1)"
set_r "sys.inotify_instances" "$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo -1)"
set_r "sys.public_egress_ip" "\"$(curl -sS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '\n')\""
set_r "sys.aws_cli" "\"$(command -v aws 2>/dev/null || echo none)\""
set_r "sys.curl_version" "\"$(curl --version | head -1)\""

# ---- S3 GET, single stream -------------------------------------------------
rm -f "$BLOB"
log "GET single stream"
curl_w get_single -o "$BLOB" "$GET_URL" || log "get_single failed"
set_r "get_single.file_size" "$(stat -c %s "$BLOB" 2>/dev/null || echo 0)"

# ---- S3 GET again (second pull, same VM: any warm path on the S3 side?) -----
log "GET single stream, second pull"
curl_w get_single_2 -o "$WORK/blob2" "$GET_URL" || log "get_single_2 failed"
rm -f "$WORK/blob2"

# ---- S3 GET, parallel ranges (what a multipart-aware client does) ----------
if [[ "$PARALLEL" -gt 1 ]]; then
  log "GET $PARALLEL parallel ranges"
  part=$(( (SIZE + PARALLEL - 1) / PARALLEL ))
  t0=$(now_ms)
  pids=()
  for ((i = 0; i < PARALLEL; i++)); do
    start=$((i * part)); end=$((start + part - 1)); (( end >= SIZE )) && end=$((SIZE - 1))
    curl -sS -r "$start-$end" -o "$WORK/part.$i" "$GET_URL" 2>>"$WORK/curl-parallel.err" &
    pids+=($!)
  done
  fail=0; for p in "${pids[@]}"; do wait "$p" || fail=1; done
  t1=$(now_ms)
  total=0; for ((i = 0; i < PARALLEL; i++)); do total=$((total + $(stat -c %s "$WORK/part.$i" 2>/dev/null || echo 0))); done
  set_r "get_parallel.streams" "$PARALLEL"
  set_r "get_parallel.time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
  set_r "get_parallel.bytes" "$total"
  set_r "get_parallel.speed_down_bps" "$(awk -v b="$total" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"
  set_r "get_parallel.failed" "$fail"
  [[ -s "$WORK/curl-parallel.err" ]] && set_r "get_parallel.error" "\"$(tr -d '"\n' <"$WORK/curl-parallel.err" | head -c 300)\""
  rm -f "$WORK"/part.*
fi

# ---- S3 PUT, single stream -------------------------------------------------
if [[ -s "$BLOB" ]]; then
  log "PUT single stream"
  curl_w put_single -T "$BLOB" -o /dev/null "$PUT_URL" || log "put_single failed"
else
  log "no blob to PUT"
fi

# ---- local disk ceiling ----------------------------------------------------
log "local disk write (dd 1 GiB zeros, fsync)"
t0=$(now_ms); dd if=/dev/zero of="$WORK/dd-blob" bs=4M count=$((SIZE / 4194304)) conv=fsync 2>"$WORK/dd.err"; t1=$(now_ms)
set_r "disk.write_time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
set_r "disk.write_bps" "$(awk -v b="$SIZE" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"
set_r "disk.dd_report" "\"$(tail -1 "$WORK/dd.err" | tr -d '"')\""
rm -f "$WORK/dd-blob"

log "local disk copy of the downloaded blob (read+write)"
sync
t0=$(now_ms); cp "$BLOB" "$WORK/blob-copy" && sync; t1=$(now_ms)
set_r "disk.copy_time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
set_r "disk.copy_bps" "$(awk -v b="$SIZE" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"
rm -f "$WORK/blob-copy"

log "local disk read after drop_caches (cat > /dev/null)"
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || set_r "disk.drop_caches_ok" "false"
t0=$(now_ms); cat "$BLOB" > /dev/null; t1=$(now_ms)
set_r "disk.read_cold_time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
set_r "disk.read_cold_bps" "$(awk -v b="$SIZE" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"
t0=$(now_ms); cat "$BLOB" > /dev/null; t1=$(now_ms)
set_r "disk.read_warm_time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
set_r "disk.read_warm_bps" "$(awk -v b="$SIZE" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"

log "sha256 of the blob (CPU ceiling for capture hashing on this VM)"
t0=$(now_ms); sum=$(sha256sum "$BLOB" | cut -d' ' -f1); t1=$(now_ms)
set_r "cpu.sha256_time_s" "$(awk -v ms=$((t1 - t0)) 'BEGIN{printf "%.3f", ms/1000}')"
set_r "cpu.sha256_bps" "$(awk -v b="$SIZE" -v ms=$((t1 - t0)) 'BEGIN{printf "%.0f", (ms>0)?b*1000/ms:0}')"
set_r "cpu.sha256" "\"$sum\""
rm -f "$BLOB"

# ---- emit ------------------------------------------------------------------
{
  echo "{"
  echo "  \"id\": \"$ID\", \"mode\": \"transfer\", \"egress\": \"$EGRESS\", \"s3Uri\": \"$S3_URI\", \"size\": $SIZE,"
  echo "  \"results\": {"
  first=1
  for k in $(printf '%s\n' "${!R[@]}" | sort); do
    [[ $first == 1 ]] || echo ","
    first=0
    printf '    "%s": %s' "$k" "${R[$k]}"
  done
  echo
  echo "  }"
  echo "}"
}
