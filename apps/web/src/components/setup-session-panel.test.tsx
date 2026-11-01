// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectNavigation } from "#/components/project-navigation";
import { AdoptPanel } from "#/components/projects-index/adopt-panel";
import { SetupSessionPanel } from "#/components/setup-session-panel";
import { TRPCProvider, trpcClient } from "#/lib/trpc";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});

const mount = async (adoption = false, connected = true) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const writes: Array<{ path: string; body: unknown }> = [];
  let closed = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const paths = url.pathname.split("/trpc/")[1]?.split(",") ?? [];
    const body: unknown = JSON.parse(String(init?.body));
    const replies = paths.map((path) => {
      if (["projects.adopt", "sessions.create", "sessions.launch"].includes(path))
        writes.push({ path, body });
      const data =
        path === "platform.sealantIdentity"
          ? {
              accounts: [
                { provider: "claude", status: "invalid" },
                { provider: "github", status: "active" },
                { provider: "codex", status: connected ? "active" : "invalid" },
              ],
            }
          : path === "git.access"
            ? { mode: "mend-key", key: { exists: false } }
            : path === "organization.current"
              ? { organization: { name: "Team" } }
              : path === "projects.adopt"
                ? { id: "project-adopted" }
                : { id: "session-created" };
      return { result: { data: serialize(data) } };
    });
    return Response.json(replies);
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base = createRootRoute({ component: Outlet });
  const entry = createRoute({
    getParentRoute: () => base,
    path: "/",
    component: () =>
      adoption ? (
        <AdoptPanel onAdopted={() => closed++} />
      ) : (
        <>
          <ProjectNavigation projectId="project-adopted" />
          <SetupSessionPanel projectId="project-adopted" onClose={() => closed++} />
        </>
      ),
  });
  const session = createRoute({
    getParentRoute: () => base,
    path: "/sessions/$sessionId",
    component: () => <p>Session opened</p>,
  });
  const router = createRouter({
    routeTree: base.addChildren([entry, session]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    Wrap: ({ children }) => (
      <QueryClientProvider client={client}>
        <TRPCProvider trpcClient={trpcClient} queryClient={client}>
          {children}
        </TRPCProvider>
      </QueryClientProvider>
    ),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
    if (button === undefined) throw new Error(`No button ${text}`);
    await act(async () => button.click());
  };
  return { host, writes, click, router, closed: () => closed };
};

describe("Setup consent", () => {
  it("offers only connected promptable agents and sends purpose only after yes", async () => {
    const page = await mount();
    await vi.waitFor(() => expect(page.host.textContent).toContain("codex"));
    expect(page.host.textContent).not.toContain("claude");
    expect(page.host.textContent).not.toContain("github");
    expect(page.writes).toEqual([]);
    expect(page.host.textContent).toContain("It uses your own agent login.");
    await page.click("Set up this project");
    await vi.waitFor(() => expect(page.writes).toHaveLength(2));
    expect(page.writes).toEqual([
      {
        path: "sessions.create",
        body: {
          0: {
            json: {
              projectId: "project-adopted",
              session: {
                harness: "codex",
                label: null,
                name: null,
                base: null,
                autoLand: false,
                purpose: "setup",
              },
            },
          },
        },
      },
      { path: "sessions.launch", body: { 0: { json: { id: "session-created", request: {} } } } },
    ]);
    expect(page.router.state.location.pathname).toBe("/sessions/session-created");
  });

  it.each(["Not now", "dismiss"])("%s creates nothing from the later action", async (choice) => {
    const page = await mount();
    if (choice === "Not now") {
      await page.click(choice);
      expect(page.closed()).toBe(1);
    } else
      await act(async () =>
        page.router.navigate({ to: "/sessions/$sessionId", params: { sessionId: "already-open" } }),
      );
    expect(page.writes).toEqual([]);
  });

  it("explains how to connect an agent and disables setup when none are connected", async () => {
    const page = await mount(false, false);
    await vi.waitFor(() => expect(page.host.textContent).toContain("Connect Claude or Codex"));
    const start = [...page.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Set up this project",
    );
    expect(start?.disabled).toBe(true);
    expect(page.writes).toEqual([]);
  });

  it("renames the tab and its URL to Configuration", async () => {
    const page = await mount();
    const configuration = [...page.host.querySelectorAll("a")].find(
      (link) => link.textContent === "Configuration",
    );
    expect(configuration?.getAttribute("href")).toBe("/projects/project-adopted/configuration");
    expect(page.host.textContent).not.toContain("WorktreesSetup");
  });

  it.each(["Set up this project", "Not now", "dismiss"])(
    "adoption stays complete; %s controls whether setup starts",
    async (choice) => {
      const page = await mount(true);
      const source = page.host.querySelector('input[aria-label="Repository Git URL"]');
      if (!(source instanceof HTMLInputElement)) throw new Error("No repository field");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          source,
          "https://github.com/team/repo.git",
        );
        source.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click("Adopt");
      await vi.waitFor(() => expect(page.host.textContent).toContain("A setup session studies"));
      expect(page.closed()).toBe(0);
      expect(page.writes.map((entry) => entry.path)).toEqual(["projects.adopt"]);
      await vi.waitFor(() => expect(page.host.textContent).toContain("codex"));
      if (choice === "dismiss")
        await act(async () =>
          page.router.navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: "already-open" },
          }),
        );
      else await page.click(choice);
      if (choice === "Set up this project") {
        await vi.waitFor(() => expect(page.writes).toHaveLength(3));
        expect(page.writes[1]?.body).toEqual({
          0: {
            json: {
              projectId: "project-adopted",
              session: {
                harness: "codex",
                label: null,
                name: null,
                base: null,
                autoLand: false,
                purpose: "setup",
              },
            },
          },
        });
        expect(page.router.state.location.pathname).toBe("/sessions/session-created");
      } else {
        expect(page.writes.map((entry) => entry.path)).toEqual(["projects.adopt"]);
        expect(page.closed()).toBe(choice === "Not now" ? 1 : 0);
      }
    },
  );
});
