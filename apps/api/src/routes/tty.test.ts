import { describe, expect, it } from "vitest";

import { ttyInputOf } from "./tty.ts";

/** docs/adr/0013, "Terminal sessions: only the owner types": every steerer reads, the owner types. */
describe("terminal input", () => {
  const keys = new Uint8Array([0x6c, 0x73, 0x0d]);
  const resize = JSON.stringify({ t: "resize", cols: 120, rows: 40 });
  const text = JSON.stringify({ t: "input", data: "ls\r" });

  it("the owner's keys, text input and resizes reach the PTY", () => {
    expect([ttyInputOf(keys, true), ttyInputOf(text, true), ttyInputOf(resize, true)]).toEqual([
      { kind: "input", data: keys },
      { kind: "input", data: "ls\r" },
      { kind: "resize", cols: 120, rows: 40 },
    ]);
  });

  it("anyone else's frames are dropped, resizes included", () => {
    expect([ttyInputOf(keys, false), ttyInputOf(text, false), ttyInputOf(resize, false)]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("unknown and malformed text frames reach nothing", () => {
    expect([
      ttyInputOf("not json", true),
      ttyInputOf(JSON.stringify({ t: "paste", data: "x" }), true),
      ttyInputOf(JSON.stringify({ t: "resize", cols: "120", rows: 40 }), true),
      ttyInputOf(JSON.stringify(null), true),
    ]).toEqual([null, null, null, null]);
  });
});
