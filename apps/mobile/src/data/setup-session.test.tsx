// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdoptScreen from "@/app/adopt";
import ProjectScreen from "@/app/project/[id]";
import { clearConfig, saveConfig } from "@/data/pairing-config";
import { PairingBoundary } from "@/data/pairing-scope";
import { navigation, route } from "@/test/fake-router";

vi.mock("expo-router", async () => (await import("@/test/fake-router")).fakeExpoRouter);
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));
vi.mock("react-native-reanimated", async () => ({
  default: { View: (await import("react-native")).View },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withRepeat: (value: number) => value,
  withSequence: (value: number) => value,
  withTiming: (value: number) => value,
}));
vi.mock("lucide-react-native", () => ({
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  GitPullRequest: () => null,
  Pencil: () => null,
  Trash2: () => null,
  GitMerge: () => null,
  GitPullRequestClosed: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

const project = { id: "project-adopted", name: "repo", defaultBranch: "main", adoptedSha: null };
const writes: Array<{ path: string; body: unknown }> = [];
let root: Root;
let host: HTMLDivElement;
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const press = async (label: string) => {
  const buttons = [...host.querySelectorAll<HTMLElement>('[role="button"]')];
  const button = buttons.findLast((node) => node.textContent === label);
  if (button === undefined) throw new Error(`No ${label} button: ${host.textContent}`);
  await act(async () => button.click());
  await settle();
};
const type = async (placeholder: string, value: string) => {
  const input = host.querySelector(`input[placeholder="${placeholder}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input ${placeholder}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  writes.length = 0;
  navigation.replaced = [];
  route.params = { id: project.id };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(path === "/api/projects" ? project : { id: "setup-created" });
    }
    if (path === `/api/projects/${project.id}`)
      return Response.json({ project, sessions: [], worktrees: [], annotations: [] });
    if (path === "/api/harnesses/models") return Response.json([]);
    if (path === "/api/gh/status") return Response.json({ available: false, authenticated: false });
    return Response.json({});
  });
  await clearConfig();
  await saveConfig({
    url: "https://setup.example",
    token: "test-token",
    deviceName: null,
    pairedAt: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const offer = async (from: "adoption" | "project") => {
  await act(async () =>
    root.render(
      <PairingBoundary>
        {from === "adoption" ? <AdoptScreen /> : <ProjectScreen />}
      </PairingBoundary>,
    ),
  );
  await settle();
  if (from === "adoption") {
    await type("https://github.com/owner/repo.git", "https://github.com/team/repo.git");
    await press("Adopt");
    expect(writes.map((request) => request.path)).toEqual(["/api/projects"]);
  } else await press("Set up this project");
  expect(host.textContent).toContain("It uses your own agent login.");
};

describe.each(["adoption", "project"] satisfies Array<"adoption" | "project">)(
  "setup from %s",
  (from) => {
    it("yes starts a setup conversation with the chosen agent", async () => {
      await offer(from);
      await press("claude");
      await press("Set up this project");
      expect(writes.filter((request) => request.path !== "/api/projects")).toEqual([
        {
          path: `/api/projects/${project.id}/sessions`,
          body: {
            harness: "claude",
            purpose: "setup",
            mode: "protocol",
            label: null,
            name: null,
            base: null,
          },
        },
        { path: "/api/sessions/setup-created/launch", body: { mode: "protocol" } },
      ]);
      expect(navigation.replaced).toEqual([
        { pathname: "/session/[id]", params: { id: "setup-created", mode: "protocol" } },
      ]);
    });

    it("Not now starts nothing", async () => {
      await offer(from);
      await press("Not now");
      expect(writes.filter((request) => request.path !== "/api/projects")).toEqual([]);
      expect(navigation.replaced).toEqual([]);
    });

    it("leaving the offer starts nothing", async () => {
      await offer(from);
      await act(async () => root.render(null));
      expect(writes.filter((request) => request.path !== "/api/projects")).toEqual([]);
      expect(navigation.replaced).toEqual([]);
    });
  },
);
