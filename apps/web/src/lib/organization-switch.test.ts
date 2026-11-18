import { describe, expect, it } from "vitest";

import {
  leaveSwitchedNote,
  type NoteStore,
  parseSwitchedNote,
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

const note = { to: "Acme Labs", from: { id: "org-northwind", name: "Northwind" } };

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

  it("is nothing when what was stored can't be read as a note", () => {
    expect(parseSwitchedNote("not json")).toBeNull();
    expect(parseSwitchedNote(JSON.stringify({ to: "Acme Labs" }))).toBeNull();
    expect(parseSwitchedNote(JSON.stringify({ to: 3, from: { id: "a", name: "b" } }))).toBeNull();
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
