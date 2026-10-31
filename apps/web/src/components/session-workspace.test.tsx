// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { SessionWorkspace, sessionWorkspaceSearch } from "./session-workspace";

// A real router exercises URL state, reloads, and the same panel boundary as the session route.
async function renderWorkspace({ screen = true, url = "/sessions/one" } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const base = createRootRoute({ component: Outlet });
  const session = createRoute({
    getParentRoute: () => base,
    path: "/sessions/$sessionId",
    validateSearch: sessionWorkspaceSearch,
    component: function Page() {
      const { view } = session.useSearch();
      const { sessionId } = session.useParams();
      const navigate = useNavigate();
      return (
        <SessionWorkspace
          view={view}
          onViewChange={(next) =>
            void navigate({
              to: "/sessions/$sessionId",
              params: { sessionId },
              search: next === "desktop" ? { view: "desktop" } : {},
              replace: true,
            })
          }
          terminal={<input aria-label="Terminal content" defaultValue="working" />}
          screen={screen ? <div>Screen content</div> : null}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: base.addChildren([session]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  return {
    host,
    router,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("session workspace tabs", () => {
  it("shows Desktop only when the session has a screen, even for a saved desktop URL", async () => {
    const page = await renderWorkspace({ screen: false, url: "/sessions/one?view=desktop" });
    try {
      expect(page.host.querySelector('[role="tablist"]')).toBeNull();
      expect(page.host.querySelector('[aria-label="Terminal content"]')).not.toBeNull();
      expect(page.host.textContent).not.toContain("Desktop");
    } finally {
      await page.close();
    }
  });

  it("selects Terminal by default, remembers Desktop in the URL, and preserves the terminal", async () => {
    const page = await renderWorkspace();
    try {
      const tabs = page.host.querySelectorAll('[role="tab"]');
      const terminal = tabs[0];
      const desktop = tabs[1];
      if (!(terminal instanceof HTMLButtonElement) || !(desktop instanceof HTMLButtonElement))
        throw new Error("Missing tabs");
      expect(terminal.textContent).toBe("Terminal");
      expect(desktop.textContent).toBe("Desktop");
      expect(terminal.getAttribute("aria-selected")).toBe("true");
      const input = page.host.querySelector("input");
      await act(async () => desktop.click());
      expect(page.router.state.location.search).toEqual({ view: "desktop" });
      expect(desktop.getAttribute("aria-selected")).toBe("true");
      expect(page.host.querySelector("input")).toBe(input);
      await act(async () => terminal.click());
      expect(page.router.state.location.search).toEqual({});
      expect(terminal.getAttribute("aria-selected")).toBe("true");
    } finally {
      await page.close();
    }
  });

  it("restores Desktop directly from a session URL", async () => {
    const page = await renderWorkspace({ url: "/sessions/one?view=desktop" });
    try {
      expect(page.host.querySelector('[aria-selected="true"]')?.textContent).toBe("Desktop");
      expect(page.host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe(
        "Screen content",
      );
    } finally {
      await page.close();
    }
  });
});
