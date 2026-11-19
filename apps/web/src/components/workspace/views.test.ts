import { describe, expect, it } from "vitest";

import { isWorkspaceViewId, WORKSPACE_VIEW_IDS } from "./view-ids.ts";
import { WORKSPACE_VIEWS, workspaceView } from "./views.tsx";

describe("the workspace views", () => {
  it("are the ids a view's address is checked against, in the same order", () => {
    // The route's `beforeLoad` reads only `view-ids.ts`, so a view missing there has no address,
    // and an id with no entry would load a page with no tab.
    expect(WORKSPACE_VIEWS.map((view) => view.id)).toEqual([...WORKSPACE_VIEW_IDS]);
  });

  it("answer a view's name and nothing else", () => {
    expect(isWorkspaceViewId("terminal")).toBe(true);
    expect(isWorkspaceViewId("desktop")).toBe(false);
    expect(workspaceView("screen")?.name).toBe("Screen");
    expect(workspaceView("desktop")).toBeUndefined();
  });
});
