// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  composerHarness,
  setComposerDefaultHarness,
  setComposerDefaultPrefs,
  setComposerHarness,
  setComposerHarnessPrefs,
  stickyHarnessPrefs,
  useComposerPrefs,
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

describe("composer defaults from Settings → Sessions", () => {
  it("start a project with no sticky choice on the default harness, model and effort", () => {
    setComposerDefaultHarness("codex");
    setComposerDefaultPrefs("codex", { model: "gpt-6.1-sol" });
    setComposerDefaultPrefs("codex", { effort: "high" });
    const prefs = snapshot();
    expect(composerHarness(prefs, "fresh-project")).toBe("codex");
    expect(stickyHarnessPrefs(prefs, "fresh-project", "codex")).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      permission: null,
      speed: null,
    });
  });

  it("give way to what was chosen on the project itself", () => {
    setComposerHarness("chosen-project", "claude");
    setComposerHarnessPrefs("chosen-project", "claude", { effort: "low" });
    const prefs = snapshot();
    expect(composerHarness(prefs, "chosen-project")).toBe("claude");
    expect(stickyHarnessPrefs(prefs, "chosen-project", "claude").effort).toBe("low");
  });
});
