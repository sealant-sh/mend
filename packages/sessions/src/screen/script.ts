import { SCREEN_LIMITS, type DisplayNumber, type ScreenDegraded } from "@mend/domain/workbench";

import { privateRuntimeOf } from "../harness-layout.ts";
import {
  CHROMIUM_WRAPPER_PATH,
  MEND_HELPER_PATH,
  SESSION_SOCKET_MOUNT_PATH,
} from "../session-socket.ts";

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
  sandbox=
  while sleep 0.5 && kill -0 $$ 2>/dev/null; do
    if kill -0 "$wm" 2>/dev/null; then
      [ -n "$said" ] || { said=ready; echo "mend-screen ready"; }
    elif [ "$said" != degraded ]; then
      said=degraded
      echo "mend-screen degraded openbox"
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
  return said.startsWith("mend-screen degraded ")
    ? { _tag: "Degraded", reason: "client-failed" }
    : null;
};
