// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { focusFirstControl, SaveBar } from "./save-bar";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const draft = (dirty: boolean, said: string | null) => (
  <RouterContextProvider router={router}>
    <div id="fields">
      <input aria-label="Repository" />
    </div>
    <SaveBar
      dirty={dirty}
      summary="1 unsaved change"
      saveLabel="Save workspace"
      pending={false}
      error={null}
      said={said}
      returnFocus={() => focusFirstControl(document.getElementById("fields"))}
      onDiscard={() => undefined}
      onSave={() => undefined}
    />
  </RouterContextProvider>
);

describe("the save bar going away", () => {
  it("hands the focus back to the draft and says what happened", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(draft(true, null)));
    const discard = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Discard",
    );
    discard?.focus();
    expect(document.activeElement).toBe(discard);

    await act(async () => {
      root?.render(draft(false, "Discarded"));
      await Promise.resolve();
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Repository");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Discarded");
  });

  it("keeps its status region mounted while the bar is shown, empty", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(draft(true, "Saved")));
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
