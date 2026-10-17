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
    leaveRawMode(stdin);
    expect(stdin.raw).toBe(false);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("returns when the terminal is gone (EIO), so the attach's outcome is still acted on", () => {
    const stdin = new FakeTerminal(errno("EIO"));
    expect(() => leaveRawMode(stdin)).not.toThrow();
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("does not swallow any other refusal", () => {
    const stdin = new FakeTerminal(errno("EBADF"));
    expect(() => leaveRawMode(stdin)).toThrow("setRawMode EBADF");
    expect(stdin.listenerCount("error")).toBe(0);
  });
});
