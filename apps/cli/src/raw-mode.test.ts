import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { leaveRawMode } from "./raw-mode.ts";

/** stdin as node's tty.ReadStream behaves: a refused tcsetattr is an `error` event, never a throw. */
class FakeTerminal extends EventEmitter {
  raw = true;
  constructor(private readonly refusal: NodeJS.ErrnoException | null) {
    super();
  }
  setRawMode(mode: boolean): this {
    if (this.refusal !== null) {
      this.emit("error", this.refusal);
      return this;
    }
    this.raw = mode;
    return this;
  }
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`setRawMode ${code}`), { code, syscall: "setRawMode" });

describe("leaveRawMode", () => {
  it("leaves raw mode on a live terminal and listens to nothing afterwards", () => {
    const stdin = new FakeTerminal(null);
    expect(leaveRawMode(stdin)).toBeNull();
    expect(stdin.raw).toBe(false);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it.each(["EIO", "ENOTTY", "ENXIO", "EBADF"])(
    "a terminal that is gone (%s) refuses nothing, so the attach's outcome is still acted on",
    (code) => {
      const stdin = new FakeTerminal(errno(code));
      expect(leaveRawMode(stdin)).toBeNull();
      expect(stdin.listenerCount("error")).toBe(0);
    },
  );

  it("returns any other refusal instead of throwing it out of the cleanup", () => {
    const stdin = new FakeTerminal(errno("EPERM"));
    const refusal = leaveRawMode(stdin);
    expect(refusal?.message).toBe("setRawMode EPERM");
    expect(stdin.listenerCount("error")).toBe(0);
  });
});
