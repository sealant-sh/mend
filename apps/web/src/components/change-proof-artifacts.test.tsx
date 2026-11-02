// @vitest-environment jsdom
import { proofArtifactView } from "@mend/api-contracts";
import {
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { ProofArtifact, type ProofCapture } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { serialize } from "superjson";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TRPCProvider } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";
import type { AppRouter } from "#/server/routers/index";

import { ChangeProofArtifacts } from "./change-proof-artifacts";

const screenId = ScreenId.make("screen-1");
const media = { blobKey: "blob", mimeType: "image/png", bytes: 100, sha256: "a" } as const;
const screenshot: ProofCapture = { _tag: "Screenshot", moment: { screenId, seq: 12 }, media };
const video: ProofCapture = {
  _tag: "Video",
  span: { screenId, fromSeq: 12, toSeq: 20 },
  media: { ...media, mimeType: "video/mp4" },
  durationMs: 1_000,
  ending: "stopped",
};
const artifact = (id: string, capture: ProofCapture, removed = false) =>
  proofArtifactView(
    new ProofArtifact({
      id: ProofArtifactId.make(id),
      changeId: ChangeId.make("change-1"),
      worktreeId: WorktreeId.make("worktree-1"),
      projectId: ProjectId.make("project-1"),
      sessionId: removed ? null : SessionId.make("session-1"),
      turnId: null,
      title: id,
      caption: "The completed task is visible.",
      source: {
        _tag: "Checkpoint",
        checkpointId: CheckpointId.make("checkpoint-2"),
        ordinal: 2,
        commit: Sha.make("a".repeat(40)),
      },
      capture,
      launch: "pnpm dev --port 3000",
      differences: "Seeded test account",
      observedFrom: new Date("2026-11-02T14:02:00Z"),
      observedTo: null,
      createdAt: new Date("2026-11-02T14:02:00Z"),
    }),
  );
let listed: ReturnType<typeof artifact>[];
let refused: boolean;
let host: HTMLDivElement;
let root: Root;
let cache: QueryClient;
const sources: EventTarget[] = [];
const requests: URL[] = [];
class EventSourceHarness extends EventTarget {
  static readonly CLOSED = 2;
  readonly readyState = 1;
  constructor(_url: string) {
    super();
    sources.push(this);
  }
  close() {}
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const panel = () => {
  useWorkbenchEvents();
  return <ChangeProofArtifacts changeId="change-1" />;
};
async function show() {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "https://mend.test/trpc",
        transformer: superjson,
        fetch: async (input) => {
          requests.push(new URL(String(input)));
          return refused
            ? Response.json(
                {
                  error: serialize({
                    message: "Not found",
                    code: -32004,
                    data: { code: "NOT_FOUND", httpStatus: 404 },
                  }),
                },
                { status: 404 },
              )
            : Response.json({ result: { data: serialize(structuredClone(listed)) } });
        },
      }),
    ],
  });
  const route = createRootRoute({ component: panel });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <TRPCProvider trpcClient={client} queryClient={cache}>
          <RouterProvider router={router} />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
}
const click = (label: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (button === undefined) throw new Error(`No button: ${label}`);
  act(() => button.click());
};
const dialog = () => {
  const element = document.querySelector('[role="dialog"]');
  if (element === null) throw new Error("No dialog");
  return element;
};
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(window, "EventSource", EventSourceHarness);
  vi.useFakeTimers();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  refused = false;
  listed = [];
  requests.length = 0;
});
afterEach(async () => {
  act(() => root.unmount());
  cache.clear();
  host.remove();
  await act(() => vi.advanceTimersByTimeAsync(1_100));
  vi.useRealTimers();
});
it("keeps every label visible and opens the screenshot with provenance", async () => {
  const item = artifact("Board", screenshot);
  listed = [item, artifact("Flow", video)];
  await show();
  for (const view of listed) expect(host.textContent).toContain(view.label);
  expect(requests[0]?.pathname).toContain("changes.proofArtifacts");
  expect(requests[0]?.searchParams.get("input")).toContain('"changeId":"change-1"');
  expect(host.querySelector("img")?.getAttribute("src")).toBe(item.mediaPath);
  click(item.label);
  await settle();
  expect(dialog().querySelector("img")?.getAttribute("src")).toBe(item.mediaPath);
  expect(dialog().textContent).toContain(item.artifact.caption);
  expect(dialog().querySelector("a")?.getAttribute("href")).toBe("/sessions/session-1");
  expect(dialog().textContent).toContain("launch");
  expect(dialog().textContent).toContain(item.artifact.launch);
  expect(dialog().textContent).toContain("differences");
  expect(dialog().textContent).toContain(item.artifact.differences);
  expect(dialog().textContent).toContain("screen log · seq 12");
  expect(
    [...dialog().querySelectorAll("a")].some((link) => link.textContent?.includes("screen log")),
  ).toBe(false);
});
it("opens a playable video and a not-captured item", async () => {
  const item = artifact("Flow", video);
  const missing = artifact(
    "Sign in",
    { _tag: "NotCaptured", kind: "screenshot", reason: "Missing test account" },
    true,
  );
  listed = [item, missing];
  await show();
  expect(host.querySelector("video")?.getAttribute("src")).toBe(`${item.mediaPath}#t=0.001`);
  click(item.label);
  await settle();
  expect(dialog().querySelector("video")?.controls).toBe(true);
  expect(dialog().querySelector("video")?.preload).toBe("metadata");
  expect(dialog().textContent).toContain("screen log · seq 12–20");
  click("Close");
  await settle();
  click(missing.label);
  await settle();
  expect(dialog().textContent).toContain("Not captured · Missing test account");
  expect(dialog().textContent).toContain("Session removed");
  expect(dialog().querySelector("img, video")).toBeNull();
});
it("renders nothing when empty and lets the reader retry a failed list", async () => {
  await show();
  expect(host.textContent).toBe("");
  refused = true;
  await act(() => cache.invalidateQueries());
  await settle();
  expect(host.textContent).toContain("The proof artifacts could not be read.");
  refused = false;
  listed = [artifact("Board", screenshot)];
  click("Try again");
  await settle();
  expect(host.textContent).toContain(listed[0]?.label);
});
it("refreshes after a capture arrives and updates an open recording when it settles", async () => {
  await show();
  listed = [artifact("Flow", { _tag: "Recording", screenId, fromSeq: 12 })];
  act(() =>
    sources.at(-1)?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "session-change", changeId: "change-1" }),
      }),
    ),
  );
  await settle();
  const recording = listed[0];
  if (recording === undefined) throw new Error("No recording");
  click(recording.label);
  await settle();
  expect(dialog().textContent).toContain("Recording…");
  listed = [artifact("Flow", video)];
  act(() =>
    sources.at(-1)?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "session-change", changeId: "change-1" }),
      }),
    ),
  );
  await settle();
  expect(dialog().querySelector("video")?.controls).toBe(true);
  expect(dialog().textContent).not.toContain("Recording…");
});
