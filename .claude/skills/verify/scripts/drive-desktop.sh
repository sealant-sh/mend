#!/bin/sh
# The verify skill's desktop driver: the Electron app, built from a Mend checkout, signed in to the
# stack through the tunnel as the stack's first account, on a display of its own, with a remote
# debugging port that drive-web.mjs --cdp attaches to.
#
#   drive-desktop.sh start <app-dir> <web> <cdp-port> <display>   e.g. start ./apps/desktop $web 9333 :93
#   drive-desktop.sh stop
#
# <app-dir> is apps/desktop in a checkout where `pnpm --filter @mend/desktop build` has run (out/
# exists). The app reads the CLI config the terminal driver writes ($MEND_VERIFY_PRIVATE/tui-cli,
# written here if absent), keeps its user data and its log in $MEND_VERIFY_PRIVATE.desktop (0700, beside
# the private directory, not in it: every non-JSON file under the private directory joins the secret
# registry, a log included), and draws on an Xvfb display started here, so no window opens on this
# machine's screen. <web> must be this run's own stack through its tunnel, with MEND_VERIFY_OUTER_URL
# declared (guard/policy.mjs, as for every command): any other server is refused (exit 97), and so
# is a config already there that names one. The pids go to $MEND_VERIFY_PRIVATE.desktop/pids; stop ends those processes and no
# others, and removes that directory.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${MEND_VERIFY_PRIVATE:?set MEND_VERIFY_PRIVATE to the run's private directory}"
side=$MEND_VERIFY_PRIVATE.desktop
pids=$side/pids
case "${1:-}" in
start)
  app=$(cd "${2:?the desktop app dir}" && pwd); web=${3:?the stack web URL}; port=${4:?a CDP port}; display=${5:?an X display, e.g. :93}
  [ -f "$app/out/main/index.js" ] || { echo "drive-desktop: $app/out is missing; build the desktop first" >&2; exit 1; }
  MEND_VERIFY_PRIVATE=$(cd "$MEND_VERIFY_PRIVATE" && pwd -P) || exit 1
  export MEND_VERIFY_PRIVATE
  node "$here/guard/policy.mjs" target "$web" || exit 97
  conf=$MEND_VERIFY_PRIVATE/tui-cli
  if [ ! -f "$conf/mend/cli.json" ]; then
    mkdir -p "$conf/mend" && chmod 700 "$conf"
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const account = JSON.parse(readFileSync(process.argv[1], "utf8"));
      writeFileSync(process.argv[2], JSON.stringify({ url: process.argv[3], token: account.token }), { mode: 0o600 });
    ' "$MEND_VERIFY_PRIVATE/account.json" "$conf/mend/cli.json" "$web"
  fi
  node "$here/guard/policy.mjs" target "$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).url ?? ""))' "$conf/mend/cli.json")" || exit 97
  mkdir -p "$side" && chmod 700 "$side"
  Xvfb "$display" -screen 0 1440x900x24 -nolisten tcp > /dev/null 2>&1 &
  echo $! > "$pids"
  sleep 1
  (cd "$app" && env -u MEND_TOKEN -u MEND_URL -u WAYLAND_DISPLAY -u ELECTRON_RUN_AS_NODE DISPLAY="$display" XDG_CONFIG_HOME="$conf" \
    MEND_USER_DATA="$side/user-data" \
    ./node_modules/.bin/electron . --remote-debugging-port="$port" --ozone-platform=x11 \
    > "$side/desktop.log" 2>&1 &
   echo $! >> "$pids")
  i=0
  until curl -fsS "http://127.0.0.1:$port/json/version" > /dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { echo "drive-desktop: no CDP on :$port after 60 s; see $side/desktop.log" >&2; exit 1; }
    sleep 1
  done
  echo "drive-desktop · app on display $display · CDP http://127.0.0.1:$port"
  ;;
stop)
  [ -f "$pids" ] || { echo "drive-desktop · nothing started"; exit 0; }
  # Reverse order: the app first, then its display.
  for pid in $(tac "$pids"); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$side"
  echo "drive-desktop · stopped"
  ;;
*) echo "usage: drive-desktop.sh start <app-dir> <web> <cdp-port> <display> | stop" >&2; exit 2 ;;
esac
