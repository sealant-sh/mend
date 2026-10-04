import { describe, expect, it } from "vitest";

import { ownerNameOf, watchesTerminal, watchKey, watchNotice } from "./attach-watch.ts";

/** docs/adr/0013, "Terminal sessions: only the owner types": the CLI side of a read-only attach. */
describe("attaching to someone else's terminal", () => {
  it("reads only when the server says this caller does not type", () => {
    expect(watchesTerminal({ session: {}, control: { terminalInput: false } })).toBe(true);
    expect(watchesTerminal({ session: {}, control: { terminalInput: true } })).toBe(false);
    // Older servers say nothing and accept every steerer's keys.
    expect(watchesTerminal({ session: {}, control: {} })).toBe(false);
    expect(watchesTerminal({ session: {} })).toBe(false);
    expect(watchesTerminal(null)).toBe(false);
  });

  it("names the owner from the roster, or says its owner", () => {
    const members = [{ userId: "alice", name: "Alice" }];
    expect(watchNotice(ownerNameOf("alice", members))).toBe(
      "This session runs in a terminal. Only Alice types here; they can continue it as a conversation.",
    );
    expect(ownerNameOf("carol", members)).toBe("its owner");
    expect(ownerNameOf(null, members)).toBe("its owner");
  });

  it("Ctrl+] and Ctrl+C detach, in both encodings; every other key goes nowhere", () => {
    expect(watchKey(Buffer.from([0x1d]), true)).toBe("detach");
    expect(watchKey(Buffer.from("\u001b[93;5u"), true)).toBe("detach");
    expect(watchKey(Buffer.from([0x03]), true)).toBe("detach");
    expect(watchKey(Buffer.from("\u001b[99;5u"), true)).toBe("detach");
    expect(watchKey(Buffer.from([0x1d]), false)).toBe(null);
    expect(watchKey(Buffer.from("ls\r"), true)).toBe(null);
  });
});
