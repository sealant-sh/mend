// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { FixedPreviewRead } from "@/components/fixed-preview";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));

it("shows the fixed address, chosen target and status without target controls", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(() =>
      root.render(
        <FixedPreviewRead
          read={{
            configured: true,
            url: "https://mend.tail.ts.net:20001",
            fixed: { targetMode: "worktree" },
            target: { id: "wt", name: "oauth-fix", branch: "mend/oauth-fix" },
            status: ["web · observed ready"],
          }}
        />,
      ),
    );
    expect(host.textContent).toContain("https://mend.tail.ts.net:20001");
    expect(host.textContent).toContain("oauth-fix");
    expect(host.textContent).toContain("web · observed ready");
    expect(host.querySelector("button, select, input")).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
