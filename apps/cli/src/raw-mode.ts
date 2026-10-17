/** What leaving raw mode needs of stdin: node's tty.ReadStream reports a refused change as `error`. */
export interface RawModeTerminal {
  setRawMode(mode: boolean): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * How a terminal that is gone refuses a termios change or a write: EIO on Linux
 * (`hung_up_tty_ioctl`), ENOTTY or EBADF on macOS once `revoke()` reclaimed the vnode, ENXIO on
 * FreeBSD (`tty_ioctl`).
 */
const TERMINAL_GONE = new Set(["EIO", "ENOTTY", "ENXIO", "EBADF"]);

/** Whether an errno says the terminal behind the descriptor is gone. */
export const isTerminalGone = (code: string | undefined): boolean =>
  code !== undefined && TERMINAL_GONE.has(code);

/**
 * Leave raw mode at the end of an attach. A terminal that already went away refuses the change
 * when its SIGHUP is handled before its EOF reaches stdin: tmux kill-session signals the pane first
 * and closes its pty after, and a closed window's kernel order is a race the attach loses at times.
 * Node reports the refusal as an `error` on stdin, which has no listener, so the emit would throw
 * out of the attach's cleanup before its outcome is acted on, a foreground session's stop among
 * them (mend#1048). Nothing is left to restore on a terminal that is gone, so its refusal is
 * nothing. Any other refusal is returned, never thrown: the caller finishes the attach first and
 * reports it after.
 */
export const leaveRawMode = (stdin: RawModeTerminal): Error | null => {
  const refusals: Array<Error> = [];
  const keep = (error: Error): void => {
    refusals.push(error);
  };
  stdin.on("error", keep);
  try {
    stdin.setRawMode(false);
  } finally {
    stdin.off("error", keep);
  }
  const refusal = refusals[0];
  if (refusal === undefined) return null;
  const code = "code" in refusal && typeof refusal.code === "string" ? refusal.code : undefined;
  return isTerminalGone(code) ? null : refusal;
};
