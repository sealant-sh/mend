import { spawn } from "node:child_process";

/** Open a Mend web surface without keeping the terminal process alive. */
export const openUrl = (target: string): void => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
};

/**
 * Whether a stream is a terminal, as a real boolean. Node types `isTTY` as `boolean`, but a stream
 * that is not a terminal leaves it undefined, so a value read straight off it can be undefined.
 */
export const isTerminal = (stream: { readonly isTTY?: boolean }): boolean => stream.isTTY === true;
