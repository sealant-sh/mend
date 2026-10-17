/** What leaving raw mode needs of stdin: node's tty.ReadStream reports a refused change as `error`. */
export interface RawModeTerminal {
  setRawMode(mode: boolean): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** EIO is the terminal that is gone; anything else is rethrown, as an unlistened `error` would be. */
const closedTerminal = (error: Error): void => {
  if (!("code" in error) || error.code !== "EIO") throw error;
};

/**
 * Leave raw mode at the end of an attach. A terminal that already went away refuses the change
 * with EIO when its SIGHUP is handled before its EOF reaches stdin: tmux kill-session signals the
 * pane first and closes its pty after, and a closed window's kernel order is a race the attach
 * loses at times. Node reports the refusal as an `error` on stdin, which has no listener, so the
 * emit would throw out of the attach's cleanup before its outcome is acted on, a foreground
 * session's stop among them (mend#1048). Nothing is left to restore on a terminal that is gone.
 * Any other error is not swallowed.
 */
export const leaveRawMode = (stdin: RawModeTerminal): void => {
  stdin.on("error", closedTerminal);
  try {
    stdin.setRawMode(false);
  } finally {
    stdin.off("error", closedTerminal);
  }
};
