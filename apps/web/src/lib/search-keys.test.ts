// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { type KeyPress, opensSearch, OWN_SHORTCUTS } from "./search-keys.ts";

const press = (keys: Partial<KeyPress>): KeyPress => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: document.body,
  ...keys,
});

describe("opensSearch", () => {
  it("is ⌘K on a Mac and Ctrl K elsewhere", () => {
    expect(opensSearch(press({ metaKey: true }), true)).toBe(true);
    expect(opensSearch(press({ ctrlKey: true, key: "K" }), false)).toBe(true);
    // On a Mac, Ctrl K deletes to the end of a text field's line.
    expect(opensSearch(press({ ctrlKey: true }), true)).toBe(false);
    expect(opensSearch(press({ metaKey: true }), false)).toBe(false);
    expect(opensSearch(press({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(opensSearch(press({ metaKey: true, key: "j" }), true)).toBe(false);
  });

  it("opens from a text field, as from the home composer", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    expect(opensSearch(press({ metaKey: true, target: field }), true)).toBe(true);
    field.remove();
  });

  it("leaves the keys to a part of the page that keeps them, such as a terminal", () => {
    const terminal = document.createElement("div");
    terminal.setAttribute(OWN_SHORTCUTS, "");
    const input = document.createElement("textarea");
    terminal.append(input);
    document.body.append(terminal);
    expect(opensSearch(press({ ctrlKey: true, target: input }), false)).toBe(false);
    expect(opensSearch(press({ ctrlKey: true, defaultPrevented: true }), false)).toBe(false);
    terminal.remove();
  });
});
