// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Segment } from "#/components/kit/segment";
import { skillLibraryView } from "#/lib/ui-prefs";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function ViewSwitch() {
  const view = skillLibraryView.use();
  return (
    <>
      <Segment
        label="Show skills as"
        value={view}
        onChange={skillLibraryView.set}
        options={[
          { value: "cards", label: "Cards" },
          { value: "list", label: "List" },
        ]}
      />
      <p data-testid="view">{view}</p>
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("the skill library's view switch", () => {
  it("starts on Cards and keeps List for this browser", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<ViewSwitch />));
    expect(document.querySelector("[data-testid=view]")?.textContent).toBe("cards");

    const list = [...document.querySelectorAll("button")].find((b) => b.textContent === "List");
    act(() => list?.click());
    expect(document.querySelector("[data-testid=view]")?.textContent).toBe("list");
    expect(window.localStorage.getItem("mend-skill-library-view")).toBe('"list"');
    expect(list?.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });
});
