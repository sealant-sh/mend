import { SCREEN_LIMITS, type DisplayNumber, type ScreenDegraded } from "@mend/domain/workbench";

import { MEND_HELPER_PATH } from "../session-socket.ts";

/**
 * The screen's process (ADR 0020), as `sh -c SCREEN_SCRIPT mend-screen :<n> <width>x<height>`: it
 * travels in argv, so the image holds no Mend file. The passwords come from the session channel
 * and never touch argv or env; the X cookie is written through stdin for the same reason. One
 * child waits for the display, starts the window manager, says how that went, and ends the
 * process group once Xvnc is gone or the terminal hangs up, so nothing outlives the display.
 */
export const SCREEN_SCRIPT = `set -eu
display=$1
n=\${display#:}
dir=\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}}/mend-screen-$n
umask 077
rm -rf "$dir"
mkdir -m 700 "$dir"
secret=$(${MEND_HELPER_PATH} screen-secret)
printf '%s\\n' "$secret" | vncpasswd -f >"$dir/passwd"
cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')
: >"$dir/auth"
printf 'add %s . %s\\n' "$display" "$cookie" | xauth -q -f "$dir/auth" source -
unset secret cookie
export DISPLAY="$display" XAUTHORITY="$dir/auth"
(
  trap 'trap "" TERM; kill -TERM 0; exit 0' HUP
  tries=0
  until xdpyinfo >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 50 ]; then echo "mend-screen failed display"; kill -TERM 0; exit 1; fi
    sleep 0.2
  done
  openbox >/dev/null 2>&1 &
  wm=$!
  said=
  while sleep 0.5 && kill -0 $$ 2>/dev/null; do
    if kill -0 "$wm" 2>/dev/null; then
      [ -n "$said" ] || { said=ready; echo "mend-screen ready"; }
    elif [ "$said" != degraded ]; then
      said=degraded
      echo "mend-screen degraded openbox"
    fi
  done
  trap "" TERM
  kill -TERM 0
) &
exec Xvnc "$display" -geometry "$2" -depth 24 -localhost -nolisten tcp -rfbport $((5900 + n)) \\
  -SecurityTypes VncAuth -PasswordFile "$dir/passwd" -auth "$dir/auth" \\
  -SendCutText=0 -AcceptCutText=1 -AlwaysShared
`;

export const screenArgv = (display: DisplayNumber): ReadonlyArray<string> => [
  "sh",
  "-c",
  SCREEN_SCRIPT,
  "mend-screen",
  `:${display}`,
  `${SCREEN_LIMITS.width}x${SCREEN_LIMITS.height}`,
];

/** Xvnc's port inside the workspace, on its loopback only. */
export const screenPort = (display: DisplayNumber): number => 5900 + display;

export type ScreenReport =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Degraded"; readonly reason: ScreenDegraded };

/** One line of the screen's output: what the script says of its display, or nothing. */
export const screenReportOf = (line: string): ScreenReport | null => {
  const said = line.trim();
  if (said === "mend-screen ready") return { _tag: "Ready" };
  return said.startsWith("mend-screen degraded ")
    ? { _tag: "Degraded", reason: "client-failed" }
    : null;
};
