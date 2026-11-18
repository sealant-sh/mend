import { describe, expect, it } from "vitest";

import {
  leaveSwitchedNote,
  type NoteStore,
  parseSwitchedNote,
  type SwitchedNote,
  takeSwitchedNote,
} from "./organization-switch.ts";

const memoryStore = (): NoteStore & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
};

const note: SwitchedNote = {
  kind: "switched",
  to: "Acme Labs",
  from: { id: "org-northwind", name: "Northwind" },
};

describe("the note a switch leaves for the page it loads", () => {
  it("is read back once, then gone", () => {
    const store = memoryStore();
    leaveSwitchedNote(note, store);
    expect(takeSwitchedNote(store)).toEqual(note);
    expect(takeSwitchedNote(store)).toBeNull();
  });

  it("is nothing when the page loads without a switch", () => {
    expect(takeSwitchedNote(memoryStore())).toBeNull();
  });

  it("reads back a create and a leave, the leave without a destination when none was read", () => {
    const created: SwitchedNote = { kind: "created", name: "Difference Engine" };
    const left: SwitchedNote = { kind: "left", left: "Northwind", now: null };
    expect(parseSwitchedNote(JSON.stringify(created))).toEqual(created);
    expect(parseSwitchedNote(JSON.stringify(left))).toEqual(left);
  });

  it("is nothing when what was stored can't be read as a note", () => {
    expect(parseSwitchedNote("not json")).toBeNull();
    expect(parseSwitchedNote(JSON.stringify({ kind: "switched", to: "Acme Labs" }))).toBeNull();
    expect(
      parseSwitchedNote(JSON.stringify({ kind: "switched", to: 3, from: { id: "a", name: "b" } })),
    ).toBeNull();
    expect(
      parseSwitchedNote(JSON.stringify({ kind: "left", left: "Northwind", now: 3 })),
    ).toBeNull();
    expect(parseSwitchedNote(JSON.stringify({ kind: "renamed", name: "x" }))).toBeNull();
  });

  it("leaves the switch quiet when the browser refuses storage", () => {
    const refusing: NoteStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => leaveSwitchedNote(note, refusing)).not.toThrow();
    expect(takeSwitchedNote(refusing)).toBeNull();
    expect(takeSwitchedNote(null)).toBeNull();
  });
});
