import { describe, expect, it } from "vitest";

import { splitHeaderActions } from "./header-actions";

const action = (key: string, menuOnly = false) => ({ key, menuOnly });
const keys = (list: ReadonlyArray<{ readonly key: string }>) => list.map((entry) => entry.key);

describe("splitHeaderActions", () => {
  it("never shows a menu-only action as a button, however much room there is", () => {
    const { shown, rest } = splitHeaderActions(
      [action("diff"), action("shell"), action("stop", true)],
      5,
    );
    expect(keys(shown)).toEqual(["diff", "shell"]);
    expect(keys(rest)).toEqual(["stop"]);
  });

  it("still shows one more button rather than a menu that would hold only it", () => {
    const { shown, rest } = splitHeaderActions(
      [action("diff"), action("shell"), action("rename")],
      2,
    );
    expect(keys(shown)).toEqual(["diff", "shell", "rename"]);
    expect(rest).toEqual([]);
  });

  it("puts the overflow before the menu-only actions in the menu", () => {
    const { shown, rest } = splitHeaderActions(
      [action("stop", true), action("diff"), action("shell"), action("rename")],
      2,
    );
    expect(keys(shown)).toEqual(["diff", "shell"]);
    expect(keys(rest)).toEqual(["rename", "stop"]);
  });
});
