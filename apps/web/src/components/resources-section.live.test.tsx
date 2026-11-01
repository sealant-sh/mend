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
  return { add: vi.fn(), choose: vi.fn(), page };
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
  addResource: boundary.add,
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
    scope: "project",
  }),
  image: `postgres:17@sha256:${"e".repeat(64)}`,
  addedBy: "manager",
  choice: "shared" as const,
  canRemove: false,
  canChoose: true,
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

const type = async (field: Element | null, value: string) => {
  if (!(field instanceof HTMLInputElement)) throw new Error("no such input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(() => {
  boundary.add.mockReset();
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
  ])(
    "keeps a refusal of an add made on worktree-A out of the form once the read is %s",
    async (_, target) => {
      boundary.page.current = page();
      const pending: Array<(value: unknown) => void> = [];
      boundary.add.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      const card = await mount();
      try {
        const switchTo = reads(card.host);
        await switchTo("wt_a");
        await act(async () => card.buttonNamed("+ add a resource…")?.click());
        await type(card.host.querySelector('[aria-label="Name"]'), "db");
        await type(card.host.querySelector('[aria-label="Version"]'), "17");
        await act(async () =>
          card.host
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(boundary.add).toHaveBeenCalledOnce();
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
    boundary.add.mockResolvedValue({
      ok: false,
      kind: "rejected",
      refusals: [{ key: "version", message: "is not a major version" }],
      message: "@db · version is not a major version",
    });
    const card = await mount();
    try {
      const switchTo = reads(card.host);
      await switchTo("wt_a");
      await act(async () => card.buttonNamed("+ add a resource…")?.click());
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

  it("never lands the answer to a mend.toml table added on worktree-A under worktree-B", async () => {
    boundary.page.current = page({
      file: {
        kind: "read",
        worktreeId: WorktreeId.make("wt_a"),
        observed: "observed on the worktree",
        tables: [
          {
            digest: db.digest,
            spec: db.spec,
            add: { kind: "ready" },
            statusLine: "@db · postgres 17 · project · in mend.toml · not in settings",
          },
        ],
        refused: [],
        ignored: [],
      },
    });
    const pending: Array<(value: unknown) => void> = [];
    boundary.add.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const card = await mount();
    try {
      const switchTo = reads(card.host);
      await switchTo("wt_a");
      await act(async () => card.buttonNamed("add to settings")?.click());
      expect(boundary.add).toHaveBeenCalledWith(
        "project_probe",
        { kind: "definition", spec: db.spec },
        "wt_a",
      );
      await switchTo("wt_b");
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

  it("shows an add that failed in transit in the form, which keeps the draft for a retry", async () => {
    boundary.page.current = page();
    boundary.add.mockRejectedValue(new Error("probe: connection interrupted"));
    const card = await mount();
    try {
      await act(async () => card.buttonNamed("+ add a resource…")?.click());
      await type(card.host.querySelector('[aria-label="Name"]'), "db");
      await type(card.host.querySelector('[aria-label="Version"]'), "17");
      const form = card.host.querySelector("form");
      await act(async () =>
        form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settle();
      expect(boundary.add).toHaveBeenCalledOnce();
      const shown = card.host.querySelector("form");
      expect(shown?.textContent).toContain("probe: connection interrupted");
      expect(shown?.querySelector<HTMLInputElement>('[aria-label="Name"]')?.value).toBe("db");
    } finally {
      await card.unmount();
    }
  });

  it("never shows an answer to an act on one worktree under another", async () => {
    boundary.page.current = page({ settings: [db] });
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
  it("drops a delivered refusal when the setup moves to another project", async () => {
    boundary.page.current = page();
    boundary.add.mockResolvedValue({
      ok: false,
      kind: "rejected",
      refusals: [{ key: "version", message: "is not a major version" }],
      message: "@db · version is not a major version",
    });
    const card = await mount();
    try {
      await act(async () => card.buttonNamed("+ add a resource…")?.click());
      await type(card.host.querySelector('[aria-label="Name"]'), "db");
      await type(card.host.querySelector('[aria-label="Version"]'), "latest");
      await act(async () =>
        card.host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settle();
      expect(card.host.textContent).toContain("version is not a major version");
      await card.showProject("project_other");
      expect(card.host.textContent).not.toContain("is not a major version");
    } finally {
      await card.unmount();
    }
  });

  it("locks the draft while its add is in flight, so nothing typed can be dropped", async () => {
    boundary.page.current = page();
    const pending: Array<(value: unknown) => void> = [];
    boundary.add.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const card = await mount();
    try {
      await act(async () => card.buttonNamed("+ add a resource…")?.click());
      await type(card.host.querySelector('[aria-label="Name"]'), "first");
      await type(card.host.querySelector('[aria-label="Version"]'), "17");
      await act(async () =>
        card.host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(boundary.add).toHaveBeenCalledOnce();
      const controls = [
        ...(card.host.querySelector("form")?.querySelectorAll("input, textarea, button") ?? []),
      ];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.filter((control) => !control.matches(":disabled"))).toEqual([]);
      await act(async () =>
        pending[0]?.({ ok: true, result: { definition: db, resolvedBy: null } }),
      );
      await settle();
      expect(card.host.querySelector("form")).toBeNull();
    } finally {
      await card.unmount();
    }
  });
});
