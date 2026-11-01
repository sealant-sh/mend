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

import type { ResourceSettingView } from "#/lib/resources";

const boundary = vi.hoisted(() => {
  const settings: { current: ReadonlyArray<unknown> } = { current: [] };
  return { choose: vi.fn(), settings };
});

vi.mock("#/lib/trpc", () => ({
  useTRPC: () => ({
    resources: {
      list: {
        queryOptions: (input: { readonly worktreeId: string | null }) => ({
          queryKey: ["resources", input.worktreeId],
          queryFn: async () => ({ settings: boundary.settings.current, file: { kind: "read" } }),
        }),
      },
    },
  }),
}));
vi.mock("#/lib/resources", async (original) => ({
  ...(await original<typeof import("#/lib/resources")>()),
  chooseResource: boundary.choose,
}));

const { ComposerResources } = await import("./composer-resources.tsx");

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
const preset = (name: string, kind: "postgres" | "redis", scope: "project" | "worktree") =>
  presetDefinition({
    name: ResourceName.make(name),
    preset: kind,
    version: PresetVersion.make(kind === "postgres" ? "17" : "8"),
    scope,
  });
const entry = (
  name: string,
  kind: "postgres" | "redis",
  overrides: Partial<ResourceSettingView> = {},
): ResourceSettingView => ({
  id: ResourceDefinitionId.make(`rdef_${name}`),
  digest: ResourceSpecDigest.make("c".repeat(64)),
  spec: preset(name, kind, "project"),
  image: `${kind}@sha256:${"e".repeat(64)}`,
  addedBy: "maria",
  choice: null,
  canRemove: false,
  canChoose: true,
  canLoadOwn: true,
  instance: "running",
  statusLine: `@${name} · running`,
  ...overrides,
});

const mount = async (readOnly = false) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ComposerResources
          projectId="project_probe"
          worktreeId={WorktreeId.make("wt_a")}
          readOnly={readOnly}
        />
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

afterEach(() => {
  boundary.choose.mockReset();
  boundary.settings.current = [];
});

describe("the composer's resource line", () => {
  it("says what the worktree uses of each project resource, defaults included, on one line", async () => {
    boundary.settings.current = [
      entry("db", "postgres"),
      entry("cache", "redis", { choice: "off" }),
      { ...entry("mail", "postgres"), spec: preset("mail", "postgres", "worktree") },
    ];
    const line = await mount();
    try {
      expect(line.host.textContent).toBe("Resources @db own · @cache off change");
    } finally {
      await line.unmount();
    }
  });

  it("opens the choices on change and stores the one picked", async () => {
    boundary.settings.current = [entry("db", "postgres")];
    boundary.choose.mockResolvedValue({
      ok: true,
      result: { definitionId: "rdef_db", mode: "shared", statusLine: "@db · shared" },
    });
    const line = await mount();
    try {
      await act(async () => line.buttonNamed("change")?.click());
      expect(
        [...line.host.querySelectorAll('[role="group"] button')].map((each) => each.textContent),
      ).toEqual(["shared", "own", "off"]);
      await act(async () => line.buttonNamed("shared")?.click());
      await settle();
      expect(boundary.choose).toHaveBeenCalledWith("project_probe", "wt_a", "rdef_db", "shared");
    } finally {
      await line.unmount();
    }
  });

  it("offers no change to a reader who may not choose, nor in a menu, and says nothing with nothing to choose", async () => {
    boundary.settings.current = [entry("db", "postgres", { canChoose: false })];
    const reader = await mount();
    expect(reader.buttonNamed("change")).toBeUndefined();
    await reader.unmount();
    boundary.settings.current = [entry("db", "postgres")];
    const menu = await mount(true);
    expect(menu.buttonNamed("change")).toBeUndefined();
    expect(menu.host.textContent).toBe("Resources @db own");
    await menu.unmount();
    boundary.settings.current = [];
    const empty = await mount();
    expect(empty.host.textContent).toBe("");
    await empty.unmount();
  });
});
