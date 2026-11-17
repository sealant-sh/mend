// @vitest-environment jsdom
import type { ProjectPreviewView } from "@mend/api-contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { ProjectPreviewCard } from "./fixed-preview.tsx";

it("shows the exact registered address and switches only after Use target", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const choices: Array<unknown> = [];
  let starts = 0;
  const read: ProjectPreviewView = {
    configured: true,
    fixed: null,
    url: "https://fixed.example.test",
    target: null,
    status: ["Not started"],
    open: null,
    canManage: true,
  };
  try {
    await act(async () => {
      root.render(
        <ProjectPreviewCard
          read={read}
          worktrees={[{ id: "wt", name: "oauth-fix", branch: "mend/oauth-fix" }]}
          busy={false}
          error={null}
          onUse={(target) => choices.push(target)}
          onStart={() => {
            starts += 1;
          }}
        />,
      );
    });
    expect(host.textContent).toContain("https://fixed.example.test");
    const select = host.querySelector("select");
    if (select === null) throw new Error("missing target picker");
    select.value = "wt";
    await act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(choices).toEqual([]);
    const form = host.querySelector("form");
    if (form === null) throw new Error("missing target form");
    await act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(choices).toEqual([{ _tag: "Worktree", worktreeId: "wt" }]);
    const start = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Start",
    );
    await act(async () => {
      start?.click();
    });
    expect(starts).toBe(1);
    await act(async () => {
      root.render(
        <ProjectPreviewCard
          read={{ ...read, canManage: false }}
          worktrees={[]}
          busy={false}
          error={null}
          onUse={(target) => choices.push(target)}
          onStart={() => {
            starts += 1;
          }}
        />,
      );
    });
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("Not started");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
