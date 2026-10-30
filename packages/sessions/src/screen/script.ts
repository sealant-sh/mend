import { SCREEN_LIMITS, type DisplayNumber, type ScreenDegraded } from "@mend/domain/workbench";

import { privateRuntimeOf } from "../harness-layout.ts";
import {
  CHROMIUM_WRAPPER_PATH,
  MEND_HELPER_PATH,
  SESSION_SOCKET_MOUNT_PATH,
} from "../session-socket.ts";

/**
 * The screen's process (ADR 0020), as `sh -c SCREEN_SCRIPT mend-screen :<n> <width>x<height> <dir>`:
 * it travels in argv, so the image holds no Mend file. The passwords come from the session channel
 * and never touch argv or env; the X cookie is written through stdin for the same reason. One
 * child waits for the display, starts the window manager and the browser (through the wrapper,
 * so the agent's `chromium <url>` reaches the same one), says how the window manager went, and
 * ends the process group once Xvnc is gone or the terminal hangs up, so nothing outlives it.
 */
export const SCREEN_SCRIPT = `set -eu
display=$1
n=\${display#:}
dir=$3
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
  ${CHROMIUM_WRAPPER_PATH} about:blank >/dev/null 2>&1 &
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

/** Who a screen runs as: a person by their uid, or null for root. */
export type ScreenUser = { readonly uid: number } | null;

/**
 * The screen's own directory, made afresh at each start, so its cookie's path is the same at
 * every start: in its person's private runtime directory, or `/tmp` as root.
 */
export const screenDirOf = (display: DisplayNumber, user: ScreenUser): string =>
  `${user === null ? "/tmp" : privateRuntimeOf(user.uid)}/mend-screen-${display}`;

/**
 * A process of the session started with the wrapper's directory first on its PATH. The PATH is
 * the workspace's own, which Mend cannot read, so the shell puts the directory in front of it.
 */
export const onScreenPath = (argv: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  `PATH=${SESSION_SOCKET_MOUNT_PATH}/bin:$PATH exec "$@"`,
  "mend-screen-path",
  ...argv,
];

/** What a process of the session needs to open its windows on the session's screen. */
export const screenEnvOf = (
  display: DisplayNumber,
  user: ScreenUser,
): Readonly<Record<string, string>> => ({
  DISPLAY: `:${display}`,
  XAUTHORITY: `${screenDirOf(display, user)}/auth`,
});

export const screenArgv = (display: DisplayNumber, user: ScreenUser): ReadonlyArray<string> => [
  "sh",
  "-c",
  SCREEN_SCRIPT,
  "mend-screen",
  `:${display}`,
  `${SCREEN_LIMITS.width}x${SCREEN_LIMITS.height}`,
  screenDirOf(display, user),
];

const REAP_SCRIPT = `lock=/tmp/.X$1-lock
pid=$(tr -d ' ' <"$lock" 2>/dev/null) || exit 0
[ -n "$pid" ] || exit 0
kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || exit 0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "$lock" ] || exit 0
  sleep 0.2
done
`;

/** Ends what a lost start left on the display: the process group its X lock names, Xvnc's. */
export const screenReapArgv = (display: DisplayNumber): ReadonlyArray<string> => [
  "sh",
  "-c",
  REAP_SCRIPT,
  "mend-screen-reap",
  String(display),
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
