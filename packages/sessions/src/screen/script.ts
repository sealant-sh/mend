import {
  SCREEN_LIMITS,
  type DisplayNumber,
  type ProofRegion,
  type ScreenDegraded,
} from "@mend/domain/workbench";

import { privateRuntimeOf } from "../harness-layout.ts";
import {
  CHROMIUM_WRAPPER_PATH,
  MEND_HELPER_PATH,
  SESSION_SOCKET_MOUNT_PATH,
} from "../session-socket.ts";
import { XFCE_CONFIG_SCRIPT } from "./xfce.ts";

/**
 * The screen's process (ADR 0020), as `sh -c SCREEN_SCRIPT mend-screen :<n> <width>x<height> <dir>
 * <start>`: it travels in argv, so the image holds no Mend file. `<start>` names this start, and
 * its fresh directory keeps it for a rekey to check. The passwords come from the session channel
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
printf '%s\\n' "$4" >"$dir/start"
secret=$(${MEND_HELPER_PATH} screen-secret)
printf '%s\\n' "$secret" | vncpasswd -f >"$dir/passwd"
cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')
: >"$dir/auth"
printf 'add %s . %s\\n' "$display" "$cookie" | xauth -q -f "$dir/auth" source -
unset secret cookie
export DISPLAY="$display" XAUTHORITY="$dir/auth"
if command -v startxfce4 >/dev/null 2>&1 && command -v dbus-run-session >/dev/null 2>&1; then
  wm=xfwm4
${XFCE_CONFIG_SCRIPT}
else
  wm=openbox
fi
(
  trap 'trap "" TERM; kill -TERM 0; exit 0' HUP
  tries=0
  until xdpyinfo >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 50 ]; then echo "mend-screen failed display"; kill -TERM 0; exit 1; fi
    sleep 0.2
  done
  xset s off -dpms >/dev/null 2>&1 || true
  wm_alive() {
    if [ "$wm" = openbox ]; then kill -0 "$openbox" 2>/dev/null; return; fi
    [ -n "$(pgrep -u "$(id -u)" -x xfwm4 | while read -r pid; do
      tr '\\0' '\\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx "DISPLAY=$display" && echo "$pid"
    done)" ]
  }
  if [ "$wm" = xfwm4 ]; then
    # A person's processes keep CAP_FOWNER (ADR 0016: pnpm fixes restored files with it), and
    # with it bwrap fails with words glycin does not know, so glycin sandboxed every image load
    # through a bwrap that cannot run here: libwnck got no default icon and XFCE stopped at
    # start. The session finds a bwrap first that fails as bwrap does without namespaces, so
    # glycin loads unsandboxed, as it does wherever bwrap cannot run, and every program keeps
    # the capability. Started again a few times should it still stop.
    mkdir -p "$dir/bin"
    cat >"$dir/bin/bwrap" <<'MEND_BWRAP'
#!/bin/sh
echo "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces." >&2
exit 1
MEND_BWRAP
    chmod 755 "$dir/bin/bwrap"
    (
      starts=0
      while [ "$starts" -lt 5 ]; do
        starts=$((starts + 1))
        PATH="$dir/bin:$PATH" dbus-run-session -- startxfce4 >>"$dir/xfce.log" 2>&1 || true
        sleep 1
      done
    ) &
  else
    openbox >/dev/null 2>&1 &
    openbox=$!
  fi
  # The browser opens once the window manager runs: a window that appears while the session
  # starts is what it stopped on.
  waited=0
  until wm_alive || [ "$waited" -ge 50 ]; do waited=$((waited + 1)); sleep 0.2; done
  ${CHROMIUM_WRAPPER_PATH} about:blank >/dev/null 2>&1 &
  browser=$!
  browser_wait=0
  browser_ready() {
    command -v xprop >/dev/null 2>&1 || return 0
    for window in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | sed 's/.*#//; s/,/ /g'); do
      xprop -id "$window" WM_CLASS 2>/dev/null | grep -qi '"Chromium"' && return 0
    done
    return 1
  }
  encoders=
  said=
  sandbox=
  while sleep 0.5 && kill -0 $$ 2>/dev/null; do
    if wm_alive; then
      # The wrapper probes Chromium's sandbox before opening its first window. Reporting ready
      # sooner lets that delayed window cover the agent's first app, including live video.
      # A missing or failed browser must not prevent the display from becoming usable.
      if [ -z "$encoders" ] && [ "$browser_wait" -lt 20 ] && kill -0 "$browser" 2>/dev/null && ! browser_ready; then
        browser_wait=$((browser_wait + 1))
      else
        [ "$said" = ready ] || { said=ready; echo "mend-screen ready"; }
        # XFCE can take longer than the initial wait on a slow machine.
        if [ -z "$encoders" ]; then
          encoders=started
          if command -v ffmpeg >/dev/null 2>&1; then
            # Separate listeners let a person see only their local pointer.
            # Displays are 10..99: 8100+n never overlaps the pointer listeners at 7900+n.
            for mouse in 1 0; do
              (
                if [ "$mouse" -eq 1 ]; then port=$((7900 + n)); else port=$((8100 + n)); fi
                while :; do
                  # X11 already supplies its format; probe one frame and discard it before accepting a viewer.
                  ffmpeg -nostdin -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 -f x11grab -draw_mouse "$mouse" -framerate 30 \\
                    -video_size "$2" -i "$display" -c:v libx264 -threads 2 -preset ultrafast \\
                    -tune zerolatency -profile:v baseline -level:v 3.1 -pix_fmt yuv420p \\
                    -vf scale=out_color_matrix=bt709 -colorspace bt709 -color_primaries bt709 -color_trc bt709 \\
                    -g 30 -keyint_min 30 -bf 0 -x264-params aud=1:repeat-headers=1 \\
                    -f h264 "tcp://127.0.0.1:$port?listen=1" 2>"$dir/stream-$mouse.log" || true
                  sleep 0.2
                done
              ) &
            done
          fi
        fi
      fi
    elif [ "$said" != degraded ]; then
      said=degraded
      echo "mend-screen degraded $wm"
    fi
    if [ -z "$sandbox" ] && [ "$(cat "$dir/browser-sandbox" 2>/dev/null)" = off ]; then
      sandbox=off
      echo "mend-screen browser sandbox off"
    fi
  done
  trap "" TERM
  kill -TERM 0
) &
exec Xvnc "$display" -geometry "$2" -depth 24 -localhost -nolisten tcp -rfbport $((5900 + n)) \\
  -SecurityTypes VncAuth -PasswordFile "$dir/passwd" -auth "$dir/auth" \\
  -SendCutText=0 -AcceptCutText=1 -AlwaysShared
`;

/** Who a screen runs as: always a person (ADR 0020), by their uid. */
export interface ScreenUser {
  readonly uid: number;
}

/**
 * The screen's own directory, made afresh at each start, so its cookie's path is the same at
 * every start: in its person's private runtime directory.
 */
export const screenDirOf = (display: DisplayNumber, user: ScreenUser): string =>
  `${privateRuntimeOf(user.uid)}/mend-screen-${display}`;

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

/** `start` names this start of the screen, so a rekey can tell it from a later one. */
export const screenArgv = (
  display: DisplayNumber,
  user: ScreenUser,
  start: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  SCREEN_SCRIPT,
  "mend-screen",
  `:${display}`,
  `${SCREEN_LIMITS.width}x${SCREEN_LIMITS.height}`,
  screenDirOf(display, user),
  start,
];

/** One start of a screen: its directory, and the name that start wrote into it. */
export interface ScreenStart {
  readonly dir: string;
  readonly start: string;
}

/** The start a screen process was, read from the argv it was started with. */
export const screenStartOfArgv = (argv: ReadonlyArray<string>): ScreenStart | null => {
  const [, , , name, , , dir, start] = argv;
  return argv.length === 8 && name === "mend-screen" && dir !== undefined && start !== undefined
    ? { dir, start }
    : null;
};

/** The line the rekey script ends with once the new passwords are in place. */
export const SCREEN_REKEYED = "mend-screen rekeyed";

/**
 * A running screen signed for again, as its person, when Mend restarted and kept none of its
 * passwords: fresh ones fetched over the session channel replace the old file in one rename. Xvnc
 * reads its password file at each sign-in, so the screen and its apps keep running.
 *
 * It writes only for the start it was asked about. It holds that start's directory as its working
 * directory and writes only relative to it, and it goes no further unless the directory names
 * that start. A later start removes the directory and makes a new one, so a rekey left running
 * from before can only write into the removed one, and one that begins after finds another
 * start's name and fetches nothing.
 */
const REKEY_SCRIPT = `set -eu
cd "$1"
[ "$(cat start 2>/dev/null)" = "$2" ] || { echo "mend-screen rekey refused"; exit 1; }
umask 077
secret=$(${MEND_HELPER_PATH} screen-secret)
printf '%s\\n' "$secret" | vncpasswd -f >passwd.next
unset secret
mv -f passwd.next passwd
echo "${SCREEN_REKEYED}"
`;

export const screenRekeyArgv = ({ dir, start }: ScreenStart): ReadonlyArray<string> => [
  "sh",
  "-c",
  REKEY_SCRIPT,
  "mend-screen-rekey",
  dir,
  start,
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
  | { readonly _tag: "Ready" | "BrowserSandboxOff" }
  | { readonly _tag: "Degraded"; readonly reason: ScreenDegraded };

/** One line of the screen's output: what the script says of its display, or nothing. */
export const screenReportOf = (line: string): ScreenReport | null => {
  const said = line.trim();
  if (said === "mend-screen ready") return { _tag: "Ready" };
  if (said === "mend-screen browser sandbox off") return { _tag: "BrowserSandboxOff" };
  return said === "mend-screen degraded xfwm4" || said === "mend-screen degraded openbox"
    ? { _tag: "Degraded", reason: "client-failed" }
    : null;
};

/** A recording owns one listener; a watchdog also bounds an encoder whose open answer was lost. */
export const screenRegionArgv = (
  display: DisplayNumber,
  dir: string,
  region: ProofRegion,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -eu
export DISPLAY="$1" XAUTHORITY="$2/auth"
(sleep 70; kill -TERM $$ 2>/dev/null) &
watchdog=$!
trap 'kill "$watchdog" 2>/dev/null || true' EXIT
ffmpeg -nostdin -loglevel error -fflags nobuffer -probesize 32 -analyzeduration 0 \\
  -f x11grab -draw_mouse 1 -framerate 30 -video_size "$3" -i "$1+$4,$5" \\
  -c:v libx264 -threads 2 -preset ultrafast -tune zerolatency -profile:v baseline \\
  -level:v 3.1 -pix_fmt yuv420p -vf scale=out_color_matrix=bt709 -colorspace bt709 \\
  -color_primaries bt709 -color_trc bt709 -g 30 -keyint_min 30 -bf 0 \\
  -x264-params aud=1:repeat-headers=1 -t 65 -f h264 "tcp://127.0.0.1:$6?listen=1" &
encoder=$!
trap 'kill "$encoder" "$watchdog" 2>/dev/null || true' EXIT
trap 'exit 0' HUP INT TERM
wait "$encoder"`,
  "mend-proof-region",
  `:${display}`,
  dir,
  `${region.width}x${region.height}`,
  String(region.x),
  String(region.y),
  String(8300 + display),
];
