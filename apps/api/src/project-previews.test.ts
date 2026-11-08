import {
  PreviewPreparationsRepo,
  PreviewsRepo,
  ProjectsRepo,
  ProjectServiceRecipesRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreeNotFoundError,
  WorktreesRepo,
} from "@mend/db";
import {
  OrganizationId,
  PreviewId,
  PreviewLabel,
  ProjectId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { type ProjectPreview, Session, Worktree } from "@mend/domain/workbench";
import {
  ProjectLocalWorktrees,
  SessionEngine,
  ServiceStartUnderWayError,
  WORKTREE_STAMP,
  WorktreeReads,
} from "@mend/sessions";
import { parseMendToml, resolveDeclarations } from "@mend/sessions/recipes";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "./budgets.ts";
import { PreviewSetupConfig } from "./preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { ProjectPreviews, ProjectPreviewsLive } from "./project-previews.ts";

const PROJECT = ProjectId.make("fixed-project");
const CHECKOUT = new Worktree({
  id: WorktreeId.make("local"),
  projectId: PROJECT,
  name: "local",
  directory: "local",
  branch: "main",
  baseRef: "main",
  baseSha: Sha.make("abc"),
  handoff: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const CONFIG =
  '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\n[preview]\nservice = "web"\nfixed = true';
const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");

const world = () => {
  const calls: string[] = [];
  const state: {
    local: Worktree | null;
    fixed: ProjectPreview | null;
    holder: Session | null;
    config: string;
  } = { local: null, fixed: null, holder: null, config: CONFIG };
  const file = () => {
    const bytes = new TextEncoder().encode(state.config);
    return Effect.succeed({
      stamp: WORKTREE_STAMP,
      value: { bytes, size: bytes.length, binary: false, truncated: false },
    });
  };
  const project = makeProject({
    id: PROJECT,
    organizationId: OrganizationId.make("org"),
    visibility: "shared",
    createdByUserId: "alice",
    storePath: "/store/project",
  });
  const runtime = ManagedRuntime.make(
    ProjectPreviewsLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewsRepo, {
            projectPreview: () => Effect.succeed(state.fixed),
            ensureProject: () =>
              Effect.sync(() => {
                calls.push("allocate");
                return (state.fixed ??= {
                  targetMode: "default",
                  preview: {
                    id: PreviewId.make("fixed"),
                    scope: "project",
                    projectId: PROJECT,
                    worktreeId: null,
                    state: "unassigned",
                    label: LABEL,
                    serviceName: "web",
                  },
                });
              }),
            useProject: (_id, selection) =>
              Effect.sync(() => {
                calls.push(`target:${selection.mode}:${selection.worktreeId}`);
                if (state.fixed === null) throw new Error("identity must precede target");
                const identity = state.fixed.preview;
                state.fixed = {
                  targetMode: selection.mode,
                  preview:
                    selection.worktreeId === null
                      ? {
                          ...identity,
                          scope: "project",
                          projectId: PROJECT,
                          state: "unassigned",
                          worktreeId: null,
                        }
                      : {
                          ...identity,
                          projectId: PROJECT,
                          state: "kept",
                          worktreeId: selection.worktreeId,
                        },
                };
                return state.fixed;
              }),
            tailnetPorts: () => Effect.succeed(new Map([[PreviewId.make("fixed"), 20001]])),
            assignTailnetPort: () =>
              Effect.sync(() => {
                calls.push("reserve");
                return { _tag: "Assigned", port: 20001 };
              }),
            resolveById: () =>
              Effect.succeed(
                state.fixed === null
                  ? null
                  : {
                      preview: state.fixed.preview,
                      binding: { _tag: "Unbound", reason: "no-live-attempt" },
                    },
              ),
            gatewaySnapshots: () => Effect.succeed(new Map()),
          }),
          Layer.mock(ProjectLocalWorktrees, {
            find: () => Effect.succeed(state.local),
            start: () =>
              Effect.sync(() => {
                calls.push("local:start");
                return (state.local ??= CHECKOUT);
              }),
          }),
          Layer.mock(WorktreeReads, { readDefaultBranchFile: file, readFile: file }),
          Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
          Layer.mock(ProjectServiceRecipesRepo, { listForProject: () => Effect.succeed([]) }),
          Layer.mock(WorktreesRepo, {
            byId: (id) =>
              state.local?.id === id
                ? Effect.succeed(state.local)
                : Effect.fail(new WorktreeNotFoundError({ id })),
          }),
          Layer.mock(SessionsRepo, {
            listForWorktree: () => Effect.succeed(state.holder === null ? [] : [state.holder]),
            listUnsettledForOwner: () => Effect.succeed([]),
            countUnsettledForOrganization: () => Effect.succeed(0),
          }),
          Layer.mock(SessionEngine, {
            launchUnderWay: () => false,
            provisionSessionIn: (_id, input) =>
              Effect.sync(() => {
                calls.push("session:create");
                expect(input).toMatchObject({
                  harness: "shell",
                  autoLand: false,
                  ownerUserId: "alice",
                });
                return (state.holder = new Session({
                  ...makeSession(SessionId.make("preview-holder"), PROJECT, CHECKOUT.id, "alice"),
                  harness: "shell",
                  label: input.label,
                }));
              }),
            wakeWorkspace: () =>
              Effect.sync(() => {
                calls.push("workspace:wake");
                if (state.holder === null) throw new Error("no preview holder");
                return state.holder;
              }),
            serviceDeclarations: () =>
              parseMendToml(state.config, ".mend/mend.toml").pipe(
                Effect.map((parsed) => resolveDeclarations(parsed, [])),
              ),
            runServiceRecipe: (_id, name, cause) =>
              Effect.sync(() => {
                calls.push(`service:${name}`);
                expect(cause).toEqual({ kind: "person", userId: "alice" });
              }).pipe(
                Effect.andThen(Effect.fail(new ServiceStartUnderWayError({ message: "starting" }))),
              ),
          }),
          Layer.mock(ServicesRepo, {}),
          Layer.mock(SessionProcessesRepo, {}),
          Layer.mock(ServiceObservationsRepo, {}),
          Layer.mock(PreviewPreparationsRepo, { latestForWorktree: () => Effect.succeed(null) }),
          Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
          Layer.succeed(PreviewSetupConfig, {
            setup: {
              _tag: "On",
              routing: { mode: "tailnet-https", hostname: "mend.tail.ts.net", ports: [20001] },
              gateway: { bind: "127.0.0.1", port: 443, ...PREVIEW_GATEWAY_DEFAULTS },
            },
          }),
        ),
      ),
    ),
  );
  return {
    state,
    calls,
    runtime,
    run: <A, E>(f: (preview: ProjectPreviews["Service"]) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(ProjectPreviews, f)),
  };
};

it("reads without allocation, selects Default without creating Local, then Start reuses the shared checkout and preview holder", async () => {
  const w = world();
  try {
    expect(await w.run((p) => p.read(PROJECT))).toMatchObject({
      configured: true,
      url: null,
      target: null,
    });
    expect(w.calls).toEqual([]);
    const chosen = await w.run((p) => p.use(PROJECT, { _tag: "Default" }));
    expect(chosen).toMatchObject({ url: "https://mend.tail.ts.net:20001", target: null });
    expect(w.state.local).toBeNull();
    expect(w.calls).not.toContain("local:start");
    const started = await w.run((p) => p.start(PROJECT, "alice"));
    expect(started.target?.id).toBe(CHECKOUT.id);
    const again = await w.run((p) => p.start(PROJECT, "alice"));
    expect(again.url).toBe(chosen.url);
    expect(again.target?.id).toBe(CHECKOUT.id);
    expect(w.calls.filter((call) => call === "session:create")).toHaveLength(1);
    expect(w.calls.filter((call) => call === "service:web")).toHaveLength(2);
  } finally {
    await w.runtime.dispose();
  }
});

it("refuses an invalid browser recipe before allocating or starting anything", async () => {
  const w = world();
  w.state.config = CONFIG.replace('browserScheme = "http"', 'protocol = "http"');
  try {
    const refused = await w.run((p) => p.start(PROJECT, "alice").pipe(Effect.flip));
    expect(refused.message).toContain("preview.service");
    expect(w.calls).toEqual([]);
  } finally {
    await w.runtime.dispose();
  }
});

it("keeps a removed explicit target unassigned instead of creating a default checkout", async () => {
  const w = world();
  try {
    await w.run((p) => p.use(PROJECT, { _tag: "Default" }));
    if (w.state.fixed === null) throw new Error("no fixed address");
    w.state.fixed = { ...w.state.fixed, targetMode: "worktree" };
    w.calls.length = 0;
    const refused = await w.run((p) => p.start(PROJECT, "alice").pipe(Effect.flip));
    expect(refused.message).toContain("selected worktree was removed");
    expect(w.calls).toEqual(["allocate", "reserve"]);
    expect(w.state.local).toBeNull();
    expect((await w.run((p) => p.read(PROJECT))).url).toBe("https://mend.tail.ts.net:20001");
  } finally {
    await w.runtime.dispose();
  }
});
