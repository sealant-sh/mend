#!/bin/sh
# The verify skill's terminal driver: the Mend CLI and its dashboard on this machine, signed in to the
# stack through the tunnel as the stack's first account, in a detached tmux session.
#
#   drive-tui.sh build   <checkout>                     bundle that checkout's CLI (once per run;
#                                                       the checkout needs `pnpm install`)
#   drive-tui.sh start   <name> <web> -- <command...>   e.g. start tui-1 $web -- mend ui
#   drive-tui.sh keys    <name> <tmux key>...          e.g. keys tui-1 j Enter
#   drive-tui.sh wait    <name> <regex> [seconds]      until the screen matches (default 30 s)
#   drive-tui.sh capture <name> <dir> <step>           the screen, redacted, as <dir>/<step>.txt
#   drive-tui.sh stop    <name>
#
# The dashboard (`mend ui`) cannot run from the CLI's TypeScript source (`node main.ts` refuses
# dashboard.tsx), so `build` bundles the checkout's apps/cli with its own esbuild into
# ${XDG_CACHE_HOME:-~/.cache}/mend-verify/tui-cli-bundle (outside every checkout and outside the
# private directory). The bundle's launcher is <bundle>/real/mend, which is never on PATH: `start`
# puts the skill's guard first on the terminal's PATH and names the launcher as the guard's real CLI
# (MEND_VERIFY_REAL_MEND), so every `mend` in the terminal passes the guard, a typed one included.
#
# `start` refuses (exit 97) unless <web> is this run's own stack through its tunnel (the port
# $MEND_VERIFY_PRIVATE/tunnel.json records) and MEND_VERIFY_OUTER_URL is declared: guard/policy.mjs
# decides, the same policy the guard applies to every command.
#
# It runs on a tmux server of its own (`tmux -L st-verify-tui`, with `extended-keys on`, so Ctrl+Enter
# reaches the dashboard's editors), and its PATH starts with a no-op `xdg-open`: the dashboard's `o`
# and `mend login` would otherwise open a real browser on this machine (with a profile nobody
# cleans up). What they would have opened is an observation of the terminal; nothing is opened.
#
# The CLI config (the stack's URL and the handed-over CLI token) is written under
# $MEND_VERIFY_PRIVATE/tui-cli, so the token is in the run's secret registry and never on a command
# line. The terminal's environment is given in full on its command line (a tmux server keeps the
# environment of whoever started it): the config home, the outer declaration, the private directory,
# the guard's real CLI and PATH. The tmux session is named st-verify-tui-<name> and sized 200x50.
# Only redacted captures leave the private directory: every registered value and every credential
# shape redact.mjs knows. A code the screen shows (`mend login`'s authorization code and its
# /authorize?code= link, `mend pair`'s pairing code) is registered by value before the capture is
# written, so every later output and the evidence scan know it too.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
: "${MEND_VERIFY_PRIVATE:?set MEND_VERIFY_PRIVATE to the run's private directory}"
MEND_VERIFY_PRIVATE=$(cd "$MEND_VERIFY_PRIVATE" && pwd -P) || exit 1
export MEND_VERIFY_PRIVATE
cmd=${1:?usage: drive-tui.sh build|start|keys|wait|capture|stop ...}
bundle=${XDG_CACHE_HOME:-$HOME/.cache}/mend-verify/tui-cli-bundle
if [ "$cmd" = build ]; then
  src=$(cd "${2:?a Mend checkout}/apps/cli" && pwd)
  rm -rf "$bundle" && mkdir -p "$bundle/bin" "$bundle/real"
  node --input-type=module -e '
    import { createRequire } from "node:module";
    const [src, out] = process.argv.slice(1);
    const require = createRequire(`${src}/package.json`);
    const { build } = require("esbuild");
    const manifest = require(`${src}/package.json`);
    await build({
      absWorkingDir: src, entryPoints: ["src/main.ts"], outdir: `${out}/dist`, bundle: true,
      splitting: true, format: "esm", platform: "node", target: "node22", chunkNames: "[name]-[hash]",
      external: Object.keys(manifest.dependencies), logLevel: "warning",
    });
  ' "$src" "$bundle"
  # The bundle resolves its dependencies from the checkout's node_modules.
  ln -s "$src/node_modules" "$bundle/node_modules"
  # Reached only through the guard (MEND_VERIFY_REAL_MEND); real/ is never on PATH.
  printf '#!/bin/sh\nexec node "%s/dist/main.js" "$@"\n' "$bundle" > "$bundle/real/mend"
  printf '#!/bin/sh\necho "drive-tui: xdg-open not run (a browser would have opened)" >&2\nexit 0\n' > "$bundle/bin/xdg-open"
  chmod +x "$bundle/real/mend" "$bundle/bin/xdg-open"
  echo "drive-tui · CLI of $src bundled in $bundle"
  exit 0
fi
tmux() { command tmux -L st-verify-tui "$@"; }
name=st-verify-tui-${2:?a session name}
shift 2
case "$cmd" in
start)
  web=${1:?the stack web URL}; shift
  [ "${1:-}" = "--" ] && shift
  node "$here/guard/policy.mjs" target "$web" || exit 97
  conf=$MEND_VERIFY_PRIVATE/tui-cli
  mkdir -p "$conf/mend" && chmod 700 "$conf"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const account = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!account.token) { console.error("drive-tui: account.json has no token"); process.exit(1); }
    writeFileSync(process.argv[2], JSON.stringify({ url: process.argv[3], token: account.token }), { mode: 0o600 });
  ' "$MEND_VERIFY_PRIVATE/account.json" "$conf/mend/cli.json" "$web"
  [ -x "$bundle/real/mend" ] || { echo "drive-tui: run 'drive-tui.sh build <checkout>' first" >&2; exit 1; }
  [ ! -e "$bundle/bin/mend" ] || { echo "drive-tui: $bundle holds an unguarded CLI from an older build; run 'drive-tui.sh build <checkout>' again" >&2; exit 1; }
  q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  quoted=""
  for word in "$@"; do quoted="$quoted $(q "$word")"; done
  tmux new-session -d -s "$name" -x 200 -y 50 \
    "env -u MEND_TOKEN -u MEND_URL XDG_CONFIG_HOME=$(q "$conf") MEND_VERIFY_OUTER_URL=$(q "$MEND_VERIFY_OUTER_URL") MEND_VERIFY_PRIVATE=$(q "$MEND_VERIFY_PRIVATE") MEND_VERIFY_REAL_MEND=$(q "$bundle/real/mend") PATH=$(q "$here/guard:$bundle/bin:$PATH") $quoted; echo; echo '[drive-tui: command ended]'; sleep 3600"
  # A server option: Ctrl+Enter and other modified keys reach the dashboard as themselves.
  tmux set -s extended-keys on
  echo "drive-tui · $name started"
  ;;
keys)
  tmux send-keys -t "$name" "$@"
  ;;
wait)
  regex=${1:?a regex}; secs=${2:-30}; end=$(( $(date +%s) + secs ))
  while :; do
    tmux capture-pane -p -t "$name" | grep -qE -- "$regex" && exit 0
    [ "$(date +%s)" -ge "$end" ] && { echo "drive-tui: $name did not show /$regex/ in ${secs}s" >&2; exit 1; }
    sleep 0.5
  done
  ;;
capture)
  dir=${1:?an evidence dir}; step=${2:?a step name}
  mkdir -p "$dir"
  tmux capture-pane -p -t "$name" | node "$here/redact.mjs" --secrets "$MEND_VERIFY_PRIVATE" --register-minted > "$dir/$step.txt"
  echo "$(date -u +%FT%TZ) capture $step" >> "$dir/steps.log"
  ;;
stop)
  tmux kill-session -t "$name" 2>/dev/null && echo "drive-tui · $name stopped" || echo "drive-tui · no $name"
  ;;
*) echo "drive-tui.sh: unknown command $cmd" >&2; exit 2 ;;
esac
