// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "mend-composer-prefs";
const LAPTOP = { harness: "codex", byHarness: { codex: { model: "gpt-6.1-sol", effort: "high" } } };
const SAVED = { harness: "pi", byHarness: {} };

/** A tRPC client that records what it was asked and answers with the server's defaults. */
const fakeClient = (calls: Array<[string, unknown]>) => ({
  platform: {
    sessionDefaults: {
      query: async () => {
        calls.push(["sessionDefaults", null]);
        return SAVED;
      },
    },
    adoptSessionDefaults: {
      mutate: async (input: unknown) => {
        calls.push(["adoptSessionDefaults", input]);
        return SAVED;
      },
    },
  },
});

/** The modules as a fresh page load sees them, with this browser's stored blob. */
const load = async (stored: unknown) => {
  vi.resetModules();
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, JSON.stringify(stored));
  return import("./session-defaults.ts");
};

/** `readSessionDefaults` takes the real client; the fake answers the two calls it makes. */
const read = (module: Awaited<ReturnType<typeof load>>, calls: Array<[string, unknown]>) =>
  Reflect.apply(module.readSessionDefaults, undefined, [fakeClient(calls)]);

beforeEach(() => localStorage.clear());

describe("new-session defaults moving from the browser to the server", () => {
  it("hands this browser's own defaults over once, then forgets them and keeps the rest", async () => {
    const module = await load({
      lastProjectId: "p1",
      byProject: { p1: { harness: "claude", byHarness: {} } },
      defaults: LAPTOP,
    });
    const calls: Array<[string, unknown]> = [];
    expect(await read(module, calls)).toEqual(SAVED);
    expect(calls).toEqual([["adoptSessionDefaults", LAPTOP]]);
    const left = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(left.defaults).toBeUndefined();
    expect(left.lastProjectId).toBe("p1");
    expect(left.byProject.p1.harness).toBe("claude");

    // The next read asks the server only.
    await read(module, calls);
    expect(calls.at(-1)).toEqual(["sessionDefaults", null]);
  });

  it("only reads the server when this browser kept no defaults of its own", async () => {
    const module = await load({
      lastProjectId: null,
      byProject: {},
      defaults: { harness: null, byHarness: {} },
    });
    const calls: Array<[string, unknown]> = [];
    await read(module, calls);
    expect(calls).toEqual([["sessionDefaults", null]]);
  });

  it("keeps the browser's defaults while the hand-over fails, to try again", async () => {
    const module = await load({ lastProjectId: null, byProject: {}, defaults: LAPTOP });
    const failing = {
      platform: {
        sessionDefaults: { query: async () => SAVED },
        adoptSessionDefaults: {
          mutate: async () => {
            throw new Error("offline");
          },
        },
      },
    };
    await expect(Reflect.apply(module.readSessionDefaults, undefined, [failing])).rejects.toThrow(
      "offline",
    );
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").defaults).toEqual(LAPTOP);
  });
});
