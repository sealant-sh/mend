// @vitest-environment jsdom
import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  type PreviewStatus,
  previewStatusLine,
  Service,
  ServiceEndpoint,
  ServiceForward,
  ServiceObservation,
  ServiceRecipe,
  ServiceView,
  SessionProcess,
} from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceRecipeDto, WorktreePreviewDto, WorktreePreviewsDto } from "#/lib/api";
import { makeTrpcProxy, TRPCProvider, trpcClient, trpcLinks } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import type { AppRouter } from "../server/routers/index.ts";
import { ServicesCard } from "./services-card.tsx";

const SESSION = SessionId.make("session-1");
const SIBLING = SessionId.make("session-2");
const WORKTREE = WorktreeId.make("worktree-1");
const at = new Date("2026-10-30T09:00:00.000Z");

const service = (
  name: string,
  options: {
    readonly sessionId?: SessionId;
    readonly scheme?: "http" | "https";
    readonly adopted?: boolean;
    readonly ended?: boolean;
    readonly explicit?: boolean;
  } = {},
): ServiceView => {
  const { sessionId = SESSION, scheme = "http", adopted = false, ended = false } = options;
  const serviceId = ServiceId.make(`service-${name}-${sessionId}`);
  const attemptId = SessionProcessId.make(`process-${name}-${sessionId}`);
  const forwardId = ServiceForwardId.make(`forward-${name}-${sessionId}`);
  return new ServiceView({
    service: new Service({
      id: serviceId,
      sessionId,
      name,
      declarationSource: options.explicit ? "explicit-run" : "recipe-file",
      workspacePort: 3000,
      transport: "tcp",
      browserScheme: scheme,
      bindAddresses: ["127.0.0.1"],
      preferredHostPort: null,
      currentAttemptId: attemptId,
      currentForwardId: forwardId,
      attemptHistoryComplete: true,
      forwardHistoryComplete: true,
      observationHistoryComplete: true,
      createdAt: at,
      updatedAt: at,
    }),
    attempts: [
      new SessionProcess({
        id: attemptId,
        sessionId,
        sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
        sealantSessionId: "pty-1",
        sealantRunId: null,
        launchCorrelationId: null,
        serviceId,
        attemptOrdinal: 1,
        kind: "service",
        harness: null,
        providerSessionId: null,
        protocolOptions: null,
        label: name,
        argv: adopted ? [] : ["pnpm", "dev"],
        status: ended ? "exited" : "running",
        exitCode: ended ? 0 : null,
        workspacePort: 3000,
        protocol: "tcp",
        hostPort: 41000,
        createdAt: at,
        exitedAt: ended ? at : null,
        updatedAt: at,
      }),
    ],
    currentForward: new ServiceForward({
      id: forwardId,
      serviceId,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
      preferredHostPort: null,
      hostPort: 41000,
      boundAddresses: ["127.0.0.1"],
      state: ended ? "closed" : "bound",
      error: null,
      supersedesForwardId: null,
      createdAt: at,
      boundAt: at,
      closedAt: ended ? at : null,
      updatedAt: at,
    }),
    previousForward: null,
    latestObservation: new ServiceObservation({
      id: ServiceObservationId.make(`observation-${name}`),
      serviceId,
      forwardId,
      state: "reachable",
      source: "probe",
      error: null,
      firstObservedAt: at,
      lastObservedAt: at,
    }),
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    endpoints: [
      new ServiceEndpoint({
        address: "127.0.0.1",
        authority: "127.0.0.1:41000",
        hostPort: 41000,
        transport: "tcp",
        scope: "loopback",
        browserUrl: `${scheme}://127.0.0.1:41000/`,
        mendAuthentication: "none",
      }),
    ],
    previousEndpoints: [],
  });
};

const OPENS_WEB = "/preview-auth?preview=pv-web&path=%2F";

const observedWeb = (observedAt: Date): PreviewStatus => ({
  _tag: "Observed",
  service: "web",
  reachable: true,
  httpStatus: 200,
  observedAt,
});

const preview = (
  name: string,
  facts: ReadonlyArray<PreviewStatus>,
  binding: { readonly bound: ServiceView } | { readonly unbound: string; readonly open: boolean },
  now = at,
): WorktreePreviewDto => ({
  preview: {
    id: PreviewId.make(`pv-${name}`),
    projectId: ProjectId.make("project-1"),
    worktreeId: WORKTREE,
    serviceName: name,
    label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    state: "kept",
  },
  binding:
    "bound" in binding
      ? {
          _tag: "Bound",
          serviceId: binding.bound.service.id,
          attemptId: SessionProcessId.make(`process-${name}`),
          host: "rewrite",
          dial: "session-bound",
        }
      : { _tag: "Unbound", reason: "no-live-attempt" },
  status: facts.map((status) => previewStatusLine(status, { now })),
  facts,
  open: "bound" in binding || binding.open ? `/preview-auth?preview=pv-${name}&path=%2F` : null,
  boundTo:
    "bound" in binding
      ? { serviceId: binding.bound.service.id, sessionId: binding.bound.service.sessionId }
      : null,
});

const read = (overrides: Partial<WorktreePreviewsDto>): WorktreePreviewsDto => ({
  previews: [],
  unprepared: null,
  starting: false,
  routing: null,
  ...overrides,
});

const recipe = (name: string): ServiceRecipeDto =>
  new ServiceRecipe({
    name,
    command: "pnpm dev",
    port: 3000,
    protocol: "tcp",
    browserScheme: "http",
    source: "file",
    shadowedBy: null,
  });

const servicesCard = (owner: boolean) => (
  <ServicesCard
    sessionId={SESSION}
    worktreeId={WORKTREE}
    sessionLive
    steer={owner}
    runs={owner}
    ownerName={null}
  />
);

const render = (input: {
  readonly services?: ReadonlyArray<ServiceView>;
  readonly previews?: WorktreePreviewsDto;
  readonly recipes?: ReadonlyArray<ServiceRecipeDto>;
  readonly owner?: boolean;
}) => {
  const queryClient = new QueryClient();
  const trpc = makeTrpcProxy(queryClient);
  if (input.services !== undefined) {
    queryClient.setQueryData(trpc.services.list.queryKey({ all: true }), input.services);
  }
  queryClient.setQueryData(trpc.sessions.recipes.queryKey({ id: SESSION }), input.recipes ?? []);
  if (input.previews !== undefined) {
    queryClient.setQueryData(trpc.worktrees.previews.queryKey({ id: WORKTREE }), input.previews);
  }
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {servicesCard(input.owner ?? false)}
      </TRPCProvider>
    </QueryClientProvider>,
  );
  return root;
};

const opens = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("a"))
    .filter((link) => link.textContent === "Open")
    .map((link) => ({ href: link.getAttribute("href"), target: link.getAttribute("target") }));

const lines = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("p")).map((paragraph) => paragraph.textContent);

const rows = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("section > div > div")).map((row) =>
    Array.from(row.querySelectorAll("p, a, button, [aria-disabled]"))
      .map((part) => part.textContent ?? "")
      .filter((text) => text !== ""),
  );

describe("the Services card's Open", () => {
  it("goes to the preview through /preview-auth when the read offers its link", () => {
    const web = service("web");
    const root = render({
      services: [web],
      previews: read({ previews: [preview("web", [observedWeb(at)], { bound: web })] }),
    });
    expect(opens(root)).toEqual([{ href: OPENS_WEB, target: "_blank" }]);
  });

  it("offers no Open for a stopped explicit run whose preview has no open target", () => {
    const before = service("before", { ended: true, explicit: true });
    const root = render({
      services: [before],
      previews: read({
        previews: [preview("before", [], { unbound: "no-live-attempt", open: false })],
      }),
    });
    expect(opens(root)).toEqual([]);
  });

  it("opens the Service's own address when the read offers no link, as with the gateway off", () => {
    const root = render({
      services: [service("web")],
      previews: read({
        previews: [preview("web", [], { unbound: "no-live-attempt", open: false })],
      }),
    });
    expect(opens(root)).toEqual([{ href: "http://127.0.0.1:41000/", target: "_blank" }]);
  });

  it("opens the Service's own address when the worktree keeps no preview of its name", () => {
    const root = render({
      services: [service("web")],
      previews: read({
        previews: [preview("docs", [], { unbound: "no-live-attempt", open: true })],
      }),
    });
    expect(opens(root)).toEqual([{ href: "http://127.0.0.1:41000/", target: "_blank" }]);
  });

  it("keeps the direct Open of an https Service and of a live adopted one, whose previews the gateway refuses", () => {
    const https = render({
      services: [service("web", { scheme: "https" })],
      previews: read({
        previews: [preview("web", [], { unbound: "https-unsupported", open: false })],
      }),
    });
    expect(opens(https)).toEqual([{ href: "https://127.0.0.1:41000/", target: "_blank" }]);
    const adopted = render({
      services: [service("web", { adopted: true })],
      previews: read({
        previews: [preview("web", [], { unbound: "no-recorded-command", open: false })],
      }),
    });
    expect(opens(adopted)).toEqual([{ href: "http://127.0.0.1:41000/", target: "_blank" }]);
  });

  it("never offers the Service's own address before the previews read answers", () => {
    const root = render({ services: [service("web")] });
    expect(opens(root)).toEqual([]);
    const waiting = root.querySelector("[aria-disabled='true']");
    expect(waiting?.textContent).toBe("Open");
    expect(waiting?.getAttribute("title")).toBe("Reading this worktree's previews");
  });
});

describe("whose preview a row shows", () => {
  // The ages these lines say are worded at the card's clock: pinned to when they were observed.
  beforeEach(() => {
    vi.useFakeTimers({ now: at.getTime() });
  });

  it("shows a sibling session's preview as its own, beside this session's recipe of the same name", () => {
    const sibling = service("web", { sessionId: SIBLING });
    const root = render({
      owner: true,
      services: [sibling],
      recipes: [recipe("web")],
      previews: read({ previews: [preview("web", [observedWeb(at)], { bound: sibling })] }),
    });
    expect(rows(root)).toEqual([
      ["web", "Run", "pnpm dev · :3000 · .mend/mend.toml"],
      [
        "web",
        "Open",
        "runs in another session of this worktree",
        "preview · web · answered HTTP 200 · observed 0 s ago",
      ],
    ]);
    expect(opens(root)).toEqual([{ href: OPENS_WEB, target: "_blank" }]);
  });

  it("shows a sibling session's preview as its own, beside this session's ended Service of the same name", () => {
    const sibling = service("web", { sessionId: SIBLING });
    const root = render({
      services: [service("web", { ended: true }), sibling],
      previews: read({ previews: [preview("web", [observedWeb(at)], { bound: sibling })] }),
    });
    expect(rows(root)).toEqual([
      ["web", ":3000 code 0"],
      [
        "web",
        "Open",
        "runs in another session of this worktree",
        "preview · web · answered HTTP 200 · observed 0 s ago",
      ],
    ]);
  });

  it("never says this session's own Service runs elsewhere when the read comes before the Services", () => {
    const own = service("web");
    const root = render({
      previews: read({ previews: [preview("web", [observedWeb(at)], { bound: own })] }),
    });
    expect(lines(root)).not.toContain("runs in another session of this worktree");
    expect(opens(root)).toEqual([{ href: OPENS_WEB, target: "_blank" }]);
  });
});

describe("the Services card's preview lines", () => {
  // The ages these lines say are worded at the card's clock: pinned to when they were observed.
  beforeEach(() => {
    vi.useFakeTimers({ now: at.getTime() });
  });

  it("shows each preview's status lines under its row, as previewStatusLine words them", () => {
    const web = service("web");
    const root = render({
      services: [web],
      previews: read({
        previews: [
          preview("web", [observedWeb(at), { _tag: "SetupInputsChanged" }], { bound: web }),
        ],
      }),
    });
    const said = lines(root);
    const row = said.indexOf("web");
    expect(said.slice(row + 1, row + 3)).toEqual([
      "preview · web · answered HTTP 200 · observed 0 s ago",
      "setup inputs changed · restart to apply",
    ]);
  });

  it("shows the worktree's unprepared line, and a start that has no Service row yet", () => {
    const root = render({
      services: [],
      previews: read({
        starting: true,
        previews: [
          preview("web", [{ _tag: "Starting", service: "web", phase: "setup" }], {
            unbound: "no-live-attempt",
            open: true,
          }),
        ],
        unprepared: "preview not prepared · change not captured",
      }),
    });
    expect(lines(root)).toEqual(
      expect.arrayContaining([
        "web",
        "preview · web · starting · setup",
        "preview not prepared · change not captured",
      ]),
    );
  });

  it("leaves out a preview that binds nothing and says nothing", () => {
    const root = render({
      services: [],
      previews: read({
        previews: [preview("old", [], { unbound: "no-live-attempt", open: true })],
      }),
    });
    expect(lines(root)).not.toContain("old");
    expect(opens(root)).toEqual([]);
  });
});

class FakeEventSource {
  static readonly opened: Array<FakeEventSource> = [];
  readonly readyState = 1;
  readonly listeners = new Map<string, Array<(event: { readonly data: string }) => void>>();
  constructor() {
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, listener: (event: { readonly data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {}
  say(event: object) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(event) });
    }
  }
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Answer = { readonly data: unknown } | { readonly error: string };

const mount = (answers: {
  services: ReadonlyArray<ServiceView>;
  previews: () => Answer;
  owner?: boolean;
}) => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const asked: Array<string> = [];
  const fetch = (url: URL | RequestInfo) => {
    const paths = new URL(String(url), "http://web.test").pathname.replace("/trpc/", "").split(",");
    asked.push(...paths);
    const body = paths.map((path): unknown => {
      const answer: Answer =
        path === "services.list"
          ? { data: answers.services }
          : path === "sessions.recipes"
            ? { data: [] }
            : answers.previews();
      return "data" in answer
        ? { result: { data: serialize(answer.data) } }
        : {
            error: serialize({
              message: answer.error,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
            }),
          };
    });
    const batched = new URL(String(url), "http://web.test").searchParams.has("batch");
    return Promise.resolve(
      new Response(JSON.stringify(batched ? body : body[0]), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({ links: trpcLinks("http://web.test/trpc", fetch) });
  function Page() {
    useWorkbenchEvents();
    return servicesCard(answers.owner ?? false);
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  act(() =>
    mounted.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Page />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  const page = host;
  return {
    page,
    previewReads: () => asked.filter((path) => path === "worktrees.previews").length,
    say: (event: object) => act(() => FakeEventSource.opened.at(-1)?.say(event)),
  };
};

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("the mounted Services card", () => {
  it("follows a preparation from nothing through setup to a refusal, told by worktree events alone", async () => {
    vi.useFakeTimers();
    let previews = read({
      previews: [preview("web", [], { unbound: "no-live-attempt", open: true })],
    });
    const mounted = mount({ services: [], previews: () => ({ data: previews }) });
    await wait(10);
    expect(lines(mounted.page)).toEqual([
      "Services",
      "none running · mend service run exposes one",
    ]);

    const moved = { type: "worktree", worktreeId: WORKTREE, projectId: "project-1" };
    previews = read({
      starting: true,
      previews: [
        preview("web", [{ _tag: "Starting", service: "web", phase: "setup" }], {
          unbound: "no-live-attempt",
          open: true,
        }),
      ],
    });
    mounted.say(moved);
    await wait(10);
    expect(lines(mounted.page)).toContain("preview · web · starting · setup");

    previews = read({
      previews: [
        preview(
          "web",
          [
            {
              _tag: "NotPrepared",
              service: "web",
              why: { _tag: "Refused", words: "setup failed" },
            },
          ],
          { unbound: "no-live-attempt", open: true },
        ),
      ],
    });
    mounted.say(moved);
    await wait(10);
    expect(lines(mounted.page)).toContain("preview not prepared · web · setup failed");
    expect(mounted.previewReads()).toBe(3);
  });

  it("ages an observation on screen without reading the previews again", async () => {
    vi.useFakeTimers({ now: at.getTime() + 4_000 });
    const web = service("web");
    const mounted = mount({
      services: [web],
      previews: () => ({
        data: read({
          previews: [preview("web", [observedWeb(at)], { bound: web }, new Date(Date.now()))],
        }),
      }),
    });
    await wait(10);
    expect(lines(mounted.page)).toContain("preview · web · answered HTTP 200 · observed 4 s ago");
    await wait(3_000);
    expect(lines(mounted.page)).toContain("preview · web · answered HTTP 200 · observed 7 s ago");
    expect(mounted.previewReads()).toBe(1);
  });

  it("holds Open back once a refresh of the previews fails, whatever an earlier read said", async () => {
    vi.useFakeTimers();
    let answer: Answer = { data: read({ previews: [] }) };
    const mounted = mount({ services: [service("web")], previews: () => answer });
    await wait(10);
    expect(
      opens(mounted.page),
      "the Service's own address, from a read that answered",
    ).toHaveLength(1);

    answer = { error: "no route" };
    mounted.say({ type: "worktree", worktreeId: WORKTREE, projectId: "project-1" });
    await wait(10);

    expect(mounted.previewReads()).toBe(2);
    expect(opens(mounted.page)).toEqual([]);
    expect(lines(mounted.page)).toContain("previews not read · no route");
  });

  it("holds Open back, and says why, while the previews read fails", async () => {
    vi.useFakeTimers();
    const mounted = mount({ services: [service("web")], previews: () => ({ error: "no route" }) });
    await wait(10);
    expect(opens(mounted.page)).toEqual([]);
    const waiting = mounted.page.querySelector("[aria-disabled='true']");
    expect(waiting?.getAttribute("title")).toBe("Mend could not read this worktree's previews");
    expect(lines(mounted.page)).toContain("previews not read · no route");
  });
});
