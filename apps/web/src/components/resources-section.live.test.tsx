// @vitest-environment jsdom
import { ResourceDefinitionId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResourcesPageView } from "#/lib/resources";

const boundary = vi.hoisted(() => {
  const page: { current: unknown } = { current: null };
  return { control: vi.fn(), choose: vi.fn(), page };
});

vi.mock("#/lib/trpc", () => ({
  useTRPC: () => ({
    worktrees: {
      list: {
        queryOptions: () => ({
          queryKey: ["worktrees"],
          queryFn: async () => ({
            worktrees: [
              { id: "wt_a", name: "worktree-A" },
              { id: "wt_b", name: "worktree-B" },
            ],
          }),
        }),
      },
    },
    resources: {
      list: {
        queryOptions: (input: { readonly worktreeId: string | null }) => ({
          queryKey: ["resources", input.worktreeId],
          queryFn: async () => boundary.page.current,
        }),
      },
      pathFilter: () => ({ queryKey: ["resources"] }),
    },
  }),
}));
vi.mock("#/lib/resources", async (original) => ({
  ...(await original<typeof import("#/lib/resources")>()),
  controlResource: boundary.control,
  chooseResource: boundary.choose,
}));

const { ResourcesSection } = await import("./resources-section.tsx");

const page = (overrides: Partial<ResourcesPageView> = {}): ResourcesPageView => ({
  settings: [],
  file: { kind: "not-selected" },
  ...overrides,
});

const db = {
  id: ResourceDefinitionId.make("rdef_db"),
  digest: ResourceSpecDigest.make("c".repeat(64)),
  spec: presetDefinition({
    name: ResourceName.make("db"),
    preset: "postgres",
    version: PresetVersion.make("17"),
  }),
  image: `postgres:17@sha256:${"e".repeat(64)}`,
  addedBy: "manager",
  level: "project" as const,
  worktreeId: null,
  choice: "project" as const,
  canRemove: false,
  canChoose: true,
  canLoadOwn: true,
  instance: "not-started" as const,
  statusLine: "@db · postgres 17 · project · added by Manager · shared database · not started",
};

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

/** The card mounted on its own query cache; `unmount` takes it down. */
const mount = async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const show = (projectId: string) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ResourcesSection projectId={projectId} />
        </QueryClientProvider>,
      ),
    );
  await show("project_probe");
  await settle();
  const buttonNamed = (text: string) =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === text);
  return {
    host,
    buttonNamed,
    /** The same card, now on another project's setup, as a route change gives it. */
    showProject: async (projectId: string) => {
      await show(projectId);
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
};

afterEach(() => {
  boundary.control.mockReset();
  boundary.choose.mockReset();
});

/** The worktree select, and a switch of the read to `id` ("" reads no worktree). */
const reads = (host: HTMLElement) => {
  const select = host.querySelector("select");
  if (select === null) throw new Error("no worktree select");
  return async (id: string) => {
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
};

describe("the Resources card's answers", () => {
  it.each([
    ["worktree-B", "wt_b"],
    ["no worktree", ""],
  ])("keeps a late start refusal from worktree-A out of %s", async (_, target) => {
    boundary.page.current = page({ settings: [db] });
    const pending: Array<(value: unknown) => void> = [];
    boundary.control.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const card = await mount();
    try {
      const switchTo = reads(card.host);
      await switchTo("wt_a");
      await act(async () => card.buttonNamed("start project")?.click());
      expect(boundary.control).toHaveBeenCalledOnce();
      await switchTo(target);
      await act(async () => {
        for (const finish of pending)
          finish({ ok: false, kind: "rejected", message: "refused on the old read", refusals: [] });
      });
      await settle();
      expect(card.host.textContent).not.toContain("refused on the old read");
    } finally {
      await card.unmount();
    }
  });

  it("does not carry answers into another project's card", async () => {
    boundary.page.current = page({ settings: [db] });
    let finish: ((value: unknown) => void) | undefined;
    boundary.control.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const card = await mount();
    try {
      await reads(card.host)("wt_a");
      await act(async () => card.buttonNamed("start worktree")?.click());
      await card.showProject("another-project");
      await act(async () =>
        finish?.({ ok: false, kind: "rejected", message: "old project refusal", refusals: [] }),
      );
      await settle();
      expect(card.host.textContent).not.toContain("old project refusal");
    } finally {
      await card.unmount();
    }
  });
});
