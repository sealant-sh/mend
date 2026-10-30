// @vitest-environment jsdom
import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
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
  return { propose: vi.fn(), choose: vi.fn(), approve: vi.fn(), page };
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
  proposeResource: boundary.propose,
  chooseResource: boundary.choose,
  approveResource: boundary.approve,
}));

const { ResourcesSection } = await import("./resources-section.tsx");

const page = (overrides: Partial<ResourcesPageView> = {}): ResourcesPageView => ({
  settings: [],
  proposals: [],
  file: { kind: "not-selected" },
  canPropose: true,
  ...overrides,
});

const db = {
  id: ResourceDefinitionId.make("rdef_db"),
  digest: ResourceSpecDigest.make("c".repeat(64)),
  spec: presetDefinition({
    name: ResourceName.make("db"),
    preset: "postgres",
    version: PresetVersion.make("17"),
    scope: "project",
  }),
  approvals: { project: { by: "manager" }, worktree: null },
  approve: { project: { kind: "approved" as const }, worktree: null },
  choice: "shared" as const,
  canRemove: false,
  canChoose: true,
  statusLine: "@db · postgres 17 · project · approved by Manager · shared database · not started",
};

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

/** The card mounted on its own query cache; `unmount` takes it down. */
const mount = async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ResourcesSection projectId="project_probe" />
      </QueryClientProvider>,
    ),
  );
  await settle();
  const buttonNamed = (text: string) =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === text);
  return {
    host,
    buttonNamed,
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
};

const type = async (field: Element | null, value: string) => {
  if (!(field instanceof HTMLInputElement)) throw new Error("no such input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(() => {
  boundary.propose.mockReset();
  boundary.choose.mockReset();
  boundary.approve.mockReset();
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
  ])(
    "keeps a refusal of a proposal made on worktree-A out of the form once the read is %s",
    async (_, target) => {
      boundary.page.current = page();
      const pending: Array<(value: unknown) => void> = [];
      boundary.propose.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      const card = await mount();
      try {
        const switchTo = reads(card.host);
        await switchTo("wt_a");
        await act(async () => card.buttonNamed("+ propose a resource…")?.click());
        await type(card.host.querySelector('[aria-label="Name"]'), "db");
        await type(card.host.querySelector('[aria-label="Version"]'), "17");
        await act(async () =>
          card.host
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(boundary.propose).toHaveBeenCalledOnce();
        await switchTo(target);
        await act(async () => {
          for (const finish of pending) {
            finish({
              ok: false,
              kind: "rejected",
              refusals: [{ key: "version", message: "refused on the old read" }],
              message: "@db · version refused on the old read",
            });
          }
        });
        await settle();
        expect(card.host.textContent).not.toContain("refused on the old read");
        // The draft is the person's, whichever read is on screen.
        expect(card.host.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("db");
      } finally {
        await card.unmount();
      }
    },
  );

  it("clears a delivered form refusal when the read changes, and keeps the draft", async () => {
    boundary.page.current = page();
    boundary.propose.mockResolvedValue({
      ok: false,
      kind: "rejected",
      refusals: [{ key: "version", message: "is not a major version" }],
      message: "@db · version is not a major version",
    });
    const card = await mount();
    try {
      const switchTo = reads(card.host);
      await switchTo("wt_a");
      await act(async () => card.buttonNamed("+ propose a resource…")?.click());
      await type(card.host.querySelector('[aria-label="Name"]'), "db");
      await type(card.host.querySelector('[aria-label="Version"]'), "latest");
      await act(async () =>
        card.host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settle();
      expect(card.host.textContent).toContain("version is not a major version");
      await switchTo("wt_b");
      expect(card.host.textContent).not.toContain("is not a major version");
      expect(card.host.querySelector<HTMLInputElement>('[aria-label="Version"]')?.value).toBe(
        "latest",
      );
    } finally {
      await card.unmount();
    }
  });

  it("leaves a review opened on worktree-B open when an approval sent on worktree-A answers", async () => {
    const offered = (id: ResourceDefinitionId) => ({
      project: {
        kind: "ready" as const,
        request: { source: { kind: "settings" as const, id, digest: db.digest }, worktreeId: null },
      },
      worktree: null,
    });
    const cache = ResourceDefinitionId.make("rdef_cache");
    boundary.page.current = page({
      settings: [
        { ...db, approvals: { project: null, worktree: null }, approve: offered(db.id) },
        {
          ...db,
          id: cache,
          spec: { ...db.spec, name: ResourceName.make("cache") },
          approvals: { project: null, worktree: null },
          approve: offered(cache),
          statusLine: "@cache · waiting for approval",
        },
      ],
    });
    const pending: Array<(value: unknown) => void> = [];
    boundary.approve.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const card = await mount();
    const approveButtons = () =>
      [...card.host.querySelectorAll("button")].filter(
        (button) => button.textContent === "approve for the project…",
      );
    try {
      const switchTo = reads(card.host);
      await switchTo("wt_a");
      await act(async () => approveButtons()[0]?.click());
      await act(async () => card.buttonNamed("approve")?.click());
      expect(boundary.approve).toHaveBeenCalledOnce();
      await switchTo("wt_b");
      await act(async () => approveButtons()[1]?.click());
      expect(card.host.textContent).toContain("Approve exactly this definition");
      await act(async () => {
        for (const finish of pending) {
          finish({ ok: false, kind: "stale", message: "@db · changed (the answer for A)" });
        }
      });
      await settle();
      expect(card.host.textContent).toContain("Approve exactly this definition");
      expect(card.host.textContent).not.toContain("the answer for A");
    } finally {
      await card.unmount();
    }
  });

  it("shows a proposal that failed in transit in the form, which keeps the draft for a retry", async () => {
    boundary.page.current = page();
    boundary.propose.mockRejectedValue(new Error("probe: connection interrupted"));
    const card = await mount();
    try {
      await act(async () => card.buttonNamed("+ propose a resource…")?.click());
      await type(card.host.querySelector('[aria-label="Name"]'), "db");
      await type(card.host.querySelector('[aria-label="Version"]'), "17");
      const form = card.host.querySelector("form");
      await act(async () =>
        form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settle();
      expect(boundary.propose).toHaveBeenCalledOnce();
      const shown = card.host.querySelector("form");
      expect(shown?.textContent).toContain("probe: connection interrupted");
      expect(shown?.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("db");
    } finally {
      await card.unmount();
    }
  });

  it("never shows an answer to an act on one worktree under another", async () => {
    boundary.page.current = page({ settings: [db], canPropose: false });
    const pending: Array<(value: unknown) => void> = [];
    boundary.choose.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const card = await mount();
    try {
      const select = card.host.querySelector("select");
      if (select === null) throw new Error("no worktree select");
      const switchTo = async (id: WorktreeId) => {
        await act(async () => {
          select.value = id;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await settle();
      };
      await switchTo(WorktreeId.make("wt_a"));
      await act(async () => card.buttonNamed("own")?.click());
      expect(boundary.choose).toHaveBeenCalledOnce();
      await switchTo(WorktreeId.make("wt_b"));
      expect(card.host.textContent).toContain("worktree-B uses shared.");
      await act(async () => {
        for (const finish of pending) {
          finish({ ok: false, kind: "rejected", message: "@db · refused (the answer for A)" });
        }
      });
      await settle();
      expect(card.host.textContent).not.toContain("the answer for A");
    } finally {
      await card.unmount();
    }
  });
});
