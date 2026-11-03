// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  composerHarness,
  setComposerHarness,
  setComposerHarnessPrefs,
  stickyHarnessPrefs,
  useComposerPrefs,
  type ComposerDefaults,
} from "./composer-prefs.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** What a component reading the store sees right now. */
const snapshot = (): ReturnType<typeof useComposerPrefs> => {
  const seen: Array<ReturnType<typeof useComposerPrefs>> = [];
  function Reader() {
    seen.push(useComposerPrefs());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Reader)));
  act(() => root.unmount());
  const last = seen.at(-1);
  if (last === undefined) throw new Error("nothing read");
  return last;
};

/** The person's defaults as the server keeps them (Settings → Sessions → New sessions). */
const DEFAULTS: ComposerDefaults = {
  harness: "codex",
  byHarness: { codex: { model: "gpt-6.1-sol", effort: "high" } },
};

describe("composer defaults from Settings → Sessions", () => {
  it("start a project with no sticky choice on the default harness, model and effort", () => {
    const prefs = snapshot();
    expect(composerHarness(prefs, DEFAULTS, "fresh-project")).toBe("codex");
    expect(stickyHarnessPrefs(prefs, DEFAULTS, "fresh-project", "codex")).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      permission: null,
      speed: null,
    });
  });

  it("give way to what was chosen on the project itself", () => {
    setComposerHarness("chosen-project", "claude");
    setComposerHarnessPrefs("chosen-project", "claude", { effort: "low" }, DEFAULTS);
    const prefs = snapshot();
    expect(composerHarness(prefs, DEFAULTS, "chosen-project")).toBe("claude");
    expect(stickyHarnessPrefs(prefs, DEFAULTS, "chosen-project", "claude").effort).toBe("low");
  });

  it("keep the default model and effort when the first change on a project is another field", () => {
    setComposerHarnessPrefs("first-change", "codex", { permission: "ask" }, DEFAULTS);
    expect(stickyHarnessPrefs(snapshot(), DEFAULTS, "first-change", "codex")).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      permission: "ask",
      speed: null,
    });
  });

  it("keep an explicit choice of the harness default apart from an untouched field", () => {
    setComposerHarnessPrefs("explicit-default", "codex", { effort: null }, DEFAULTS);
    const prefs = stickyHarnessPrefs(snapshot(), DEFAULTS, "explicit-default", "codex");
    expect(prefs.effort).toBeNull();
    expect(prefs.model).toBe("gpt-6.1-sol");
  });
});
