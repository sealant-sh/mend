import { describe, expect, it } from "vitest";

import { anchorTarget } from "./anchors";

describe("anchorTarget", () => {
  it("sends every old Configuration anchor to the tab that holds it now", () => {
    expect(anchorTarget("git")).toEqual({ section: "git" });
    expect(anchorTarget("#dotfiles")).toEqual({ section: "workspace" });
    expect(anchorTarget("hot-sessions")).toEqual({ section: "workspace" });
    expect(anchorTarget("install-command")).toEqual({ section: "workspace" });
    expect(anchorTarget("cluster-bindings")).toEqual({ section: "secrets" });
    expect(anchorTarget("mounts")).toEqual({ section: "folders" });
    expect(anchorTarget("skills")).toEqual({ tab: "skills" });
  });

  it("opens General for no anchor or one the page never had", () => {
    expect(anchorTarget("")).toEqual({ section: "general" });
    expect(anchorTarget("nothing-here")).toEqual({ section: "general" });
  });
});
