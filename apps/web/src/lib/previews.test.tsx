// @vitest-environment jsdom
import { PreviewId, PreviewLabel, ProjectId, WorktreeId } from "@mend/domain";
import {
  PREVIEW_POLL_CAP_MS,
  PREVIEW_POLL_MS,
  PREVIEW_POLL_STALL_MS,
  type PreviewStatus,
  previewStatusLine,
} from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppRouter } from "../server/routers/index.ts";
import type { WorktreePreviewDto, WorktreePreviewsDto } from "./api.ts";
import { useWorktreePreviews } from "./previews.ts";
import { TRPCProvider, trpcLinks } from "./trpc.ts";

const WORKTREE = WorktreeId.make("worktree-1");
const OTHER = WorktreeId.make("worktree-2");

const shown = (
  name: string,
  facts: ReadonlyArray<PreviewStatus>,
  now = new Date(),
): WorktreePreviewDto => ({
  preview: {
    id: PreviewId.make(`pv-${name}`),
    projectId: ProjectId.make("project-1"),
    worktreeId: WORKTREE,
    serviceName: name,
    label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    state: "kept",
  },
  binding: { _tag: "Unbound", reason: "no-live-attempt" },
  status: facts.map((status) => previewStatusLine(status, { now })),
  facts,
  open: null,
  boundTo: null,
});

const said = (
  starting: boolean,
  ...previews: ReadonlyArray<WorktreePreviewDto>
): WorktreePreviewsDto => ({ previews, unprepared: null, starting, routing: null });

const setupFact: PreviewStatus = { _tag: "Starting", service: "web", phase: "setup" };
const observed = (service: string, at: Date, reachable = true): PreviewStatus => ({
  _tag: "Observed",
  service,
  reachable,
  httpStatus: reachable ? 200 : null,
  observedAt: at,
});

const setup = () => said(true, shown("web", [setupFact]));
const service = () =>
  said(true, shown("web", [{ _tag: "Starting", service: "web", phase: "service" }]));
const settled = () => said(false, shown("web", [observed("web", new Date())]));

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.useRealTimers();
});

function Probe({ id }: { readonly id: WorktreeId }) {
  const read = useWorktreePreviews(id).data;
  return <p>{read?.previews[0]?.status[0]}</p>;
}

const mount = (answer: (id: string) => WorktreePreviewsDto, worktreeId = WORKTREE) => {
  const asked: Array<string> = [];
  // The client sends queries as POST (`methodOverride` in trpcLinks), so the input is in the body.
  const fetch = (_url: URL | RequestInfo, init?: { readonly body?: unknown }) => {
    const id = /"id":"([^"]+)"/.exec(typeof init?.body === "string" ? init.body : "")?.[1] ?? "";
    asked.push(id);
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: serialize(answer(id)) } }]), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const client = createTRPCClient<AppRouter>({ links: trpcLinks("http://web.test/trpc", fetch) });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  const show = (id: WorktreeId) =>
    act(() =>
      mounted.render(
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={client} queryClient={queryClient}>
            <Probe id={id} />
          </TRPCProvider>
        </QueryClientProvider>,
      ),
    );
  show(worktreeId);
  return { asked, show, text: () => host?.textContent };
};

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("the Services card's previews read", () => {
  it("is fetched again while a preview starts, and no more once it settles", async () => {
    vi.useFakeTimers();
    let answer = setup;
    const page = mount(() => answer());
    await wait(10);
    expect(page.asked).toHaveLength(1);
    expect(page.text()).toBe("preview · web · starting · setup");

    answer = service;
    await wait(PREVIEW_POLL_MS);
    expect(page.asked).toHaveLength(2);
    expect(page.text()).toBe("preview · web · starting · web");

    answer = settled;
    await wait(PREVIEW_POLL_MS);
    expect(page.asked).toHaveLength(3);
    expect(page.text()).toBe("preview · web · answered HTTP 200 · observed 0 s ago");

    await wait(PREVIEW_POLL_MS * 10);
    expect(page.asked).toHaveLength(3);
  });

  it("stops at the stall limit though a bound preview's observation keeps ageing", async () => {
    vi.useFakeTimers();
    const observedAt = new Date();
    const page = mount(() =>
      said(true, shown("docs", [observed("docs", observedAt)]), shown("web", [setupFact])),
    );
    await wait(PREVIEW_POLL_STALL_MS + PREVIEW_POLL_MS);
    const stalled = page.asked.length;
    await wait(PREVIEW_POLL_MS * 10);
    expect(page.asked).toHaveLength(stalled);
  });

  it("stops at the cap for a start that never settles, however the worktree's other facts move", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const page = mount(() => {
      reads += 1;
      return said(
        true,
        shown("docs", [observed("docs", new Date(), reads % 2 === 0)]),
        shown("web", [setupFact]),
      );
    });
    await wait(PREVIEW_POLL_CAP_MS - PREVIEW_POLL_MS);
    const before = page.asked.length;
    await wait(PREVIEW_POLL_MS);
    expect(page.asked.length).toBeGreaterThan(before);
    await wait(PREVIEW_POLL_MS * 2);
    const capped = page.asked.length;
    await wait(PREVIEW_POLL_MS * 10);
    expect(page.asked).toHaveLength(capped);
  });

  it("gives each worktree its own polling, though their starts say the same", async () => {
    vi.useFakeTimers();
    const page = mount(() => setup(), OTHER);
    await wait(10);
    page.show(WORKTREE);
    await wait(PREVIEW_POLL_STALL_MS + PREVIEW_POLL_MS);
    const stalled = page.asked.length;
    await wait(PREVIEW_POLL_MS * 3);
    expect(page.asked).toHaveLength(stalled);

    page.show(OTHER);
    await wait(10);
    const switched = page.asked.length;
    await wait(PREVIEW_POLL_MS * 3);
    expect(page.asked.slice(switched)).toEqual([OTHER, OTHER, OTHER]);
  });
});
