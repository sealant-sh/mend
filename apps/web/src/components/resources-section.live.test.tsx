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
  return {
    control: vi.fn(),
    choose: vi.fn(),
    add: vi.fn(),
    page,
    worktrees: {
      current: [
        { id: "wt_b", name: "worktree-B" },
        { id: "wt_a", name: "worktree-A" },
      ],
    },
  };
});

vi.mock("#/lib/trpc", () => ({
  useTRPC: () => ({
    worktrees: {
      list: {
        queryOptions: () => ({
          queryKey: ["worktrees"],
          queryFn: async () => ({
            worktrees: boundary.worktrees.current,
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
  boundary.add.mockReset();
  boundary.worktrees.current = [
    { id: "wt_b", name: "worktree-B" },
    { id: "wt_a", name: "worktree-A" },
  ];
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

describe("Add resource", () => {
  it("asks for a worktree in the API's activity order and writes without starting", async () => {
    boundary.page.current = page();
    boundary.add.mockResolvedValue({
      ok: true,
      result: {
        kind: "written",
        path: ".mend/mend.toml",
        worktree: "worktree-B",
        table: "",
        statusLine:
          "@db · added to .mend/mend.toml in worktree-B · start it: mend resource start db --project or --worktree",
      },
    });
    const view = await mount();
    await act(async () => view.buttonNamed("Add resource")?.click());
    const select = view.host.querySelector('select[aria-label="Add resource worktree"]');
    expect(
      [...view.host.querySelectorAll('select[aria-label="Add resource worktree"] option')].map(
        (option) => option.textContent,
      ),
    ).toEqual(["worktree-B", "worktree-A"]);
    expect(select?.getAttribute("disabled")).toBeNull();
    await act(async () => {
      view.host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(boundary.add).toHaveBeenCalledWith("project_probe", {
      worktreeId: "wt_b",
      definition: { name: "db", preset: "postgres", version: "17" },
    });
    expect(view.host.textContent).toContain("added to .mend/mend.toml in worktree-B");
    expect(boundary.control).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("writes an image declaration with named TCP and UDP ports", async () => {
    boundary.page.current = page();
    boundary.add.mockResolvedValue({
      ok: true,
      result: {
        kind: "declared",
        path: ".mend/mend.toml",
        table: "",
        statusLine: "@dns · already declared in .mend/mend.toml",
      },
    });
    const view = await mount();
    await act(async () => view.buttonNamed("Add resource")?.click());
    await act(async () => {
      const select = view.host.querySelector<HTMLSelectElement>(
        'select[aria-label="Resource preset"]',
      );
      if (select === null) throw new Error("missing preset");
      select.value = "image";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const [label, value] of [
      ["Resource name", "dns"],
      ["Resource image", "coredns/coredns:1.12"],
      ["Resource ports", "dns=53/udp health=8080"],
    ]) {
      await act(async () => {
        const input = view.host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
        if (input === null) throw new Error(`missing ${label}`);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      view.host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(boundary.add).toHaveBeenCalledWith("project_probe", {
      worktreeId: "wt_b",
      definition: expect.objectContaining({
        name: "dns",
        image: "coredns/coredns:1.12",
        ports: [
          { name: "dns", port: 53, protocol: "udp" },
          { name: "health", port: 8080, protocol: "tcp" },
        ],
      }),
    });
    await view.unmount();
  });
  it.each([true, false])(
    "shows the table to copy when no worktree or unreachable (%s)",
    async (noWorktree) => {
      boundary.page.current = page();
      if (noWorktree) boundary.worktrees.current = [];
      const table = '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n';
      boundary.add.mockResolvedValue({
        ok: true,
        result: {
          kind: "unreachable",
          reason: "offline",
          table,
          statusLine: "@db · offline · add this table to .mend/mend.toml yourself:",
        },
      });
      const view = await mount();
      await act(async () => view.buttonNamed("Add resource")?.click());
      if (noWorktree) expect(view.host.textContent).toContain("Show table to copy");
      await act(async () => {
        view.host
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await settle();
      expect(boundary.add.mock.calls[0]?.[1].worktreeId).toBe(noWorktree ? null : "wt_b");
      expect(view.host.querySelector("pre")?.textContent).toBe(table);
      await view.unmount();
    },
  );
});

it("stops a remembered worktree instance at its own worktree after its table was removed", async () => {
  boundary.page.current = page({
    settings: [
      { ...db, level: "worktree", worktreeId: WorktreeId.make("wt_b"), instance: "running" },
    ],
  });
  boundary.control.mockResolvedValue({
    ok: true,
    result: { instance: "stopped", statusLine: "@db · stopped", message: null },
  });
  const view = await mount();
  await reads(view.host)("wt_a");
  await act(async () => view.buttonNamed("stop")?.click());
  await settle();
  expect(boundary.control).toHaveBeenCalledWith(
    "project_probe",
    expect.objectContaining({ worktreeId: "wt_b" }),
    "wt_b",
    "stop",
    "worktree",
    false,
  );
  await view.unmount();
});

it("keeps Stop and Remove available when a project has no worktrees", async () => {
  boundary.worktrees.current = [];
  boundary.page.current = page({ settings: [{ ...db, instance: "running", canRemove: true }] });
  boundary.control.mockResolvedValue({
    ok: true,
    result: { instance: "stopped", statusLine: "@db · stopped", message: null },
  });
  const view = await mount();
  expect(view.buttonNamed("stop")?.disabled).toBe(false);
  expect(view.buttonNamed("remove project")?.disabled).toBe(false);
  await act(async () => view.buttonNamed("stop")?.click());
  await settle();
  expect(boundary.control).toHaveBeenCalledWith(
    "project_probe",
    expect.anything(),
    null,
    "stop",
    "project",
    false,
  );
  await view.unmount();
});
