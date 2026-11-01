import { type PreviewGatewaySnapshot, WorktreeNotFoundError } from "@mend/db";
import {
  AgentTurnId,
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
  type PreviewPreparation,
  type PreviewView,
  ServiceObservation,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";
import type { PreviewSetup } from "../preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "../preview-gateway-settings.ts";

const GATEWAY = { bind: "127.0.0.1", port: 3200, ...PREVIEW_GATEWAY_DEFAULTS };
const routingOf = async (previews: PreviewSetup | undefined): Promise<string | null> => {
  const api = await createTenancyApi(
    {},
    {
      ...(previews === undefined ? {} : { previews }),
      implement: {
        previews: {
          ensureForWorktree: () => Effect.succeed([]),
          gatewaySnapshots: () => Effect.succeed(new Map()),
        },
        preparations: { latestForWorktree: () => Effect.succeed(null) },
      },
    },
  );
  try {
    const response = await api.request(
      "alice",
      "GET",
      `/api/worktrees/${ids("shared-a").worktree}/previews`,
    );
    const body: { routing: string | null } = await response.json();
    return body.routing;
  } finally {
    await api.dispose();
  }
};

describe("GET /worktrees/:id/previews", () => {
  it("anyone who sees the project reads its previews, including unbound ones", async () => {
    const target = ids("shared-a");
    const bound: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: {
        _tag: "Bound",
        serviceId: ServiceId.make(target.service),
        attemptId: SessionProcessId.make(target.process),
        host: "rewrite",
        dial: "session-bound",
      },
    };
    const unbound: PreviewView = {
      preview: {
        ...bound.preview,
        id: PreviewId.make("preview-docs"),
        serviceName: "docs",
        label: PreviewLabel.make("bbbbbbbbbbbbbbbbbbbbbbbbba"),
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
    };
    const seen: Array<WorktreeId> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: (id) =>
              Effect.sync(() => {
                seen.push(id);
                return [bound, unbound];
              }),
            gatewaySnapshots: () => Effect.succeed(new Map()),
          },
          preparations: { latestForWorktree: () => Effect.succeed(null) },
        },
      },
    );
    try {
      for (const user of ["alice", "carol"] as const) {
        const response = await api.request(
          user,
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          previews: [
            {
              ...bound,
              status: [],
              facts: [],
              open: null,
              boundTo: { serviceId: target.service, sessionId: target.session },
            },
            { ...unbound, status: [], facts: [], open: null, boundTo: null },
          ],
          unprepared: null,
          starting: false,
          routing: null,
        });
      }
      expect(seen).toEqual([target.worktree, target.worktree]);
      expect(api.world.calls).toEqual([
        "previews.ensureForWorktree",
        "previews.gatewaySnapshots",
        "preparations.latestForWorktree",
        "previews.ensureForWorktree",
        "previews.gatewaySnapshots",
        "preparations.latestForWorktree",
      ]);
    } finally {
      await api.dispose();
    }
  });

  it("refused and missing worktrees have identical 404s before any preview read", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.die("authorization must run first"),
          },
        },
      },
    );
    try {
      const target = ids("private-alice").worktree;
      const hidden = await api.request("carol", "GET", `/api/worktrees/${target}/previews`);
      const missing = await api.request("carol", "GET", "/api/worktrees/missing/previews");
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await hidden.json()).toEqual({ _tag: "WorktreeNotFound", id: target });
      expect(await missing.json()).toEqual({ _tag: "WorktreeNotFound", id: "missing" });
      expect(api.world.calls).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  it("a worktree removed after authorization answers the missing-worktree 404", async () => {
    const target = ids("shared-a").worktree;
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: (id) => Effect.fail(new WorktreeNotFoundError({ id })),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "GET", `/api/worktrees/${target}/previews`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ _tag: "WorktreeNotFound", id: target });
    } finally {
      await api.dispose();
    }
  });

  it("an authorized worktree without browser Services returns an empty list", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.succeed([]),
            gatewaySnapshots: () => Effect.succeed(new Map()),
          },
          preparations: { latestForWorktree: () => Effect.succeed(null) },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "GET",
        `/api/worktrees/${ids("shared-a").worktree}/previews`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        previews: [],
        unprepared: null,
        starting: false,
        routing: null,
      });
    } finally {
      await api.dispose();
    }
  });

  it("says what the bound preview's HTTP check answered, and what the last turn's preparation recorded", async () => {
    const target = ids("shared-a");
    const now = Date.now();
    const web: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: {
        _tag: "Bound",
        serviceId: ServiceId.make(target.service),
        attemptId: SessionProcessId.make(target.process),
        host: "rewrite",
        dial: "session-bound",
      },
    };
    const snapshot: PreviewGatewaySnapshot = {
      preview: web.preview,
      resolution: {
        _tag: "Bound",
        revision: 0,
        attempt: {
          serviceId: ServiceId.make(target.service),
          attemptId: SessionProcessId.make(target.process),
          sessionId: SessionId.make(target.session),
          workspaceId: SealantWorkspaceId.make("ws"),
          port: 3000,
          platformSessionId: "pty",
          host: "rewrite",
          dial: "session-bound",
        },
      },
    };
    const notCaptured: PreviewPreparation = {
      turnId: AgentTurnId.make("turn-1"),
      sessionId: SessionId.make(target.session),
      worktreeId: WorktreeId.make(target.worktree),
      claimedAt: new Date(now - 10_000),
      state: {
        _tag: "Decided",
        decision: { _tag: "NotCaptured" },
        decidedAt: new Date(now - 9_000),
      },
    };
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.succeed([web]),
            gatewaySnapshots: () => Effect.succeed(new Map([[web.preview.id, snapshot]])),
          },
          observations: {
            latestForService: (serviceId) =>
              Effect.succeed(
                new ServiceObservation({
                  id: ServiceObservationId.make("observation-1"),
                  serviceId,
                  forwardId: ServiceForwardId.make("forward-1"),
                  state: "reachable",
                  source: "probe",
                  error: null,
                  httpStatus: 200,
                  firstObservedAt: new Date(now - 60_000),
                  lastObservedAt: new Date(now - 4_000),
                }),
              ),
          },
          preparations: { latestForWorktree: () => Effect.succeed(notCaptured) },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "GET",
        `/api/worktrees/${target.worktree}/previews`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        previews: [
          {
            ...web,
            status: [
              expect.stringMatching(/^preview · web · answered HTTP 200 · observed [45] s ago$/),
            ],
            facts: [
              {
                _tag: "Observed",
                service: "web",
                reachable: true,
                httpStatus: 200,
                observedAt: new Date(now - 4_000).toISOString(),
              },
            ],
            open: null,
            boundTo: { serviceId: target.service, sessionId: target.session },
          },
        ],
        unprepared: "preview not prepared · change not captured",
        starting: false,
        routing: null,
      });
    } finally {
      await api.dispose();
    }
  });

  it("drops a refusal once a Start began an attempt after it, though the preview now sleeps", async () => {
    const target = ids("shared-a");
    const web: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
    };
    const snapshot: PreviewGatewaySnapshot = {
      preview: web.preview,
      resolution: {
        _tag: "Dormant",
        revision: 0,
        source: {
          serviceId: ServiceId.make(target.service),
          sourceAttemptId: SessionProcessId.make(target.process),
        },
        workspaceId: null,
      },
    };
    const refused = (decidedAt: Date): PreviewPreparation => ({
      turnId: AgentTurnId.make("turn-1"),
      sessionId: SessionId.make(target.session),
      worktreeId: WorktreeId.make(target.worktree),
      claimedAt: decidedAt,
      state: {
        _tag: "Decided",
        decision: {
          _tag: "Refused",
          service: "web",
          previewId: web.preview.id,
          reason: "setup failed",
        },
        decidedAt,
      },
    });
    const statusWith = async (
      preparation: PreviewPreparation,
      idleMinutes: number | null = null,
    ) => {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            previews: {
              activityOf: () =>
                Effect.succeed(
                  idleMinutes === null
                    ? null
                    : {
                        previewId: web.preview.id,
                        lastAdmittedAt: null,
                        idleStoppedAttemptId: SessionProcessId.make(target.process),
                        idleStoppedAt: new Date(),
                        idleMinutes,
                      },
                ),
              ensureForWorktree: () => Effect.succeed([web]),
              gatewaySnapshots: () => Effect.succeed(new Map([[web.preview.id, snapshot]])),
            },
            preparations: { latestForWorktree: () => Effect.succeed(preparation) },
          },
        },
      );
      try {
        const response = await api.request(
          "alice",
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        const body: { previews: ReadonlyArray<{ status: ReadonlyArray<string> }> } =
          await response.json();
        return body.previews.map((preview) => preview.status);
      } finally {
        await api.dispose();
      }
    };

    expect(await statusWith(refused(new Date("2000-01-01T00:00:00Z")))).toEqual([[]]);
    expect(await statusWith(refused(new Date("2000-01-01T00:00:00Z")), 30)).toEqual([
      ["preview · web · stopped after 30 min idle"],
    ]);
    expect(await statusWith(refused(new Date(Date.now() + 86_400_000)))).toEqual([
      ["preview not prepared · web · setup failed"],
    ]);
  });
  it("says that a start is under way until it settles", async () => {
    const target = ids("shared-a");
    const web: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
    };
    const starting: PreviewGatewaySnapshot = {
      preview: web.preview,
      resolution: {
        _tag: "Starting",
        revision: 0,
        attemptId: SessionProcessId.make(target.process),
        workspaceId: SealantWorkspaceId.make("ws"),
      },
    };
    const preparing = (service: string): PreviewPreparation => ({
      turnId: AgentTurnId.make("turn-1"),
      sessionId: SessionId.make(target.session),
      worktreeId: WorktreeId.make(target.worktree),
      claimedAt: new Date(),
      state: { _tag: "Starting", service, previewId: null, phase: "setup", note: null },
    });
    const read = async (
      snapshots: ReadonlyMap<PreviewId, PreviewGatewaySnapshot>,
      preparation: PreviewPreparation | null,
    ) => {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            previews: {
              ensureForWorktree: () => Effect.succeed([web]),
              gatewaySnapshots: () => Effect.succeed(snapshots),
            },
            preparations: { latestForWorktree: () => Effect.succeed(preparation) },
          },
        },
      );
      try {
        const response = await api.request(
          "alice",
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        const body: {
          previews: ReadonlyArray<{ status: ReadonlyArray<string> }>;
          unprepared: string | null;
          starting: boolean;
        } = await response.json();
        return {
          status: body.previews.map((preview) => preview.status),
          unprepared: body.unprepared,
          starting: body.starting,
        };
      } finally {
        await api.dispose();
      }
    };

    expect(await read(new Map([[web.preview.id, starting]]), preparing("web"))).toEqual({
      status: [["preview · web · starting · setup"]],
      unprepared: null,
      starting: true,
    });
    expect(await read(new Map(), preparing("docs"))).toEqual({
      status: [[]],
      unprepared: "preview · docs · starting · setup",
      starting: true,
    });
    expect(await read(new Map(), null)).toEqual({
      status: [[]],
      unprepared: null,
      starting: false,
    });
  });

  it("offers an Open only for what the gateway serves, and says whose Service each preview binds", async () => {
    const target = ids("shared-a");
    const sibling = ids("shared-b");
    const kept = (name: string, binding: PreviewView["binding"]): PreviewView => ({
      preview: {
        id: PreviewId.make(`preview-${name}`),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: name,
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding,
    });
    const bindingTo = (service: string): PreviewView["binding"] => ({
      _tag: "Bound",
      serviceId: ServiceId.make(service),
      attemptId: SessionProcessId.make(target.process),
      host: "rewrite",
      dial: "session-bound",
    });
    const views = [
      kept("web", bindingTo(target.service)),
      kept("sibling", bindingTo(sibling.service)),
      kept("ended", { _tag: "Unbound", reason: "no-live-attempt" }),
      kept("https", { _tag: "Unbound", reason: "https-unsupported" }),
      kept("adopted", { _tag: "Unbound", reason: "no-recorded-command" }),
      kept("raw", { _tag: "Unbound", reason: "not-browser-service" }),
      kept("gone", { _tag: "Unbound", reason: "service-missing" }),
    ];
    const read = async (gateway: boolean) => {
      const api = await createTenancyApi(
        {},
        {
          ...(gateway
            ? {
                previews: {
                  _tag: "On",
                  routing: { mode: "loopback-http", port: 3200 },
                  gateway: { bind: "127.0.0.1", port: 3200, ...PREVIEW_GATEWAY_DEFAULTS },
                },
              }
            : {}),
          implement: {
            previews: {
              ensureForWorktree: () => Effect.succeed(views),
              gatewaySnapshots: () =>
                Effect.succeed(
                  new Map(
                    views.flatMap(
                      (view): Array<readonly [PreviewId, PreviewGatewaySnapshot]> =>
                        view.binding._tag !== "Bound"
                          ? []
                          : [
                              [
                                view.preview.id,
                                {
                                  preview: view.preview,
                                  resolution: {
                                    _tag: "Bound",
                                    revision: 0,
                                    attempt: {
                                      serviceId: view.binding.serviceId,
                                      attemptId: view.binding.attemptId,
                                      sessionId: SessionId.make(target.session),
                                      workspaceId: SealantWorkspaceId.make("ws"),
                                      port: 3000,
                                      platformSessionId: "pty",
                                      host: view.binding.host,
                                      dial: view.binding.dial,
                                    },
                                  },
                                },
                              ],
                            ],
                    ),
                  ),
                ),
            },
            preparations: { latestForWorktree: () => Effect.succeed(null) },
            observations: { latestForService: () => Effect.succeed(null) },
          },
        },
      );
      try {
        const response = await api.request(
          "alice",
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        const body: {
          previews: ReadonlyArray<{
            preview: { serviceName: string };
            open: string | null;
            boundTo: { serviceId: string; sessionId: string } | null;
          }>;
        } = await response.json();
        return body.previews.map(({ preview, open, boundTo }) => [
          preview.serviceName,
          open,
          boundTo?.sessionId ?? null,
        ]);
      } finally {
        await api.dispose();
      }
    };

    expect(await read(true)).toEqual([
      ["web", "/preview-auth?preview=preview-web&path=%2F", target.session],
      ["sibling", "/preview-auth?preview=preview-sibling&path=%2F", sibling.session],
      ["ended", null, null],
      ["https", null, null],
      ["adopted", null, null],
      ["raw", null, null],
      ["gone", null, null],
    ]);
    expect((await read(false)).map(([name, open]) => [name, open])).toEqual(
      views.map(({ preview }) => [preview.serviceName, null]),
    );
  });

  it("says how the gateway routes previews, so a phone can tell whether it reaches them", async () => {
    expect(await routingOf(undefined)).toBeNull();
    expect(
      await routingOf({
        _tag: "On",
        routing: { mode: "loopback-http", port: 3200 },
        gateway: GATEWAY,
      }),
    ).toBe("loopback-http");
    expect(
      await routingOf({
        _tag: "On",
        routing: { mode: "domain-https", domain: "previews.example.net", port: 443 },
        gateway: GATEWAY,
      }),
    ).toBe("domain-https");
    expect(
      await routingOf({
        _tag: "On",
        routing: { mode: "tailnet-https", hostname: "box.tail1.ts.net", ports: [8443] },
        gateway: GATEWAY,
      }),
    ).toBe("tailnet-https");
  });
});
