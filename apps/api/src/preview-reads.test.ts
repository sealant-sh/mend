import {
  PreviewPreparationsRepo,
  PreviewsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionProcessesRepo,
} from "@mend/db";
import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  ServiceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  Service,
  type PreviewGatewayResolution,
  type PreviewView,
  type ServiceDeclarationSource,
} from "@mend/domain/workbench";
import { SlackPreviewReads } from "@mend/jobs";
import { DEFAULT_APP_URL, makePublicNetwork, NetworkConfig } from "@mend/network";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { type PreviewSetup, PreviewSetupConfig } from "./preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { describeWorktreePreviews, SlackPreviewReadsLive } from "./preview-reads.ts";

const WORKTREE = WorktreeId.make("wt-1");
const ON: PreviewSetup = {
  _tag: "On",
  routing: { mode: "domain-https", domain: "preview.test", port: 443 },
  gateway: { bind: "127.0.0.1", port: 443, ...PREVIEW_GATEWAY_DEFAULTS },
};
const read = (setup: PreviewSetup, previews: Layer.PartialEffectful<PreviewsRepo["Service"]>) =>
  Effect.runPromise(
    Effect.flatMap(SlackPreviewReads, (reads) => Effect.result(reads.forWorktree(WORKTREE))).pipe(
      Effect.provide(
        SlackPreviewReadsLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(PreviewsRepo, previews),
              Layer.mock(PreviewPreparationsRepo, {}),
              Layer.mock(ServiceObservationsRepo, {}),
              Layer.mock(ServicesRepo, {}),
              Layer.mock(SessionProcessesRepo, {}),
              Layer.succeed(PreviewSetupConfig, { setup }),
              Layer.succeed(NetworkConfig, makePublicNetwork(DEFAULT_APP_URL, [])),
            ),
          ),
        ),
      ),
    ),
  );

describe("Slack's read of a worktree's previews", () => {
  it("reads nothing and shows nothing while the gateway is off", async () => {
    const result = await read(
      { _tag: "Off" },
      { readForWorktree: () => Effect.die("read while the gateway is off") },
    );
    expect(result).toMatchObject({ _tag: "Success", success: { _tag: "Hidden" } });
  });

  it("says the read failed, never that there are no previews", async () => {
    const result = await read(ON, { readForWorktree: () => Effect.die("connection refused") });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PreviewReadUnavailable", worktreeId: WORKTREE },
    });
  });
});

const before: PreviewView = {
  preview: {
    id: PreviewId.make("before"),
    projectId: ProjectId.make("project"),
    worktreeId: WORKTREE,
    serviceName: "before",
    label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    state: "kept",
  },
  binding: { _tag: "Unbound", reason: "no-live-attempt" },
};
const sourceAttemptId = SessionProcessId.make("before-attempt");
const stoppedService = (declarationSource: ServiceDeclarationSource) =>
  new Service({
    id: ServiceId.make("before-service"),
    sessionId: SessionId.make("session"),
    name: "before",
    declarationSource,
    workspacePort: 3100,
    transport: "tcp",
    browserScheme: "http",
    bindAddresses: [],
    preferredHostPort: null,
    currentAttemptId: null,
    currentForwardId: null,
    attemptHistoryComplete: true,
    forwardHistoryComplete: true,
    observationHistoryComplete: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

it("withholds Open from every worktree reader after an explicit stop, preserving recipe and idle wake", async () => {
  for (const { source, idle, offers } of [
    { source: "explicit-run", idle: false, offers: false },
    { source: "recipe-file", idle: false, offers: true },
    { source: "recipe-project", idle: false, offers: true },
    { source: "explicit-run", idle: true, offers: true },
  ] satisfies ReadonlyArray<{ source: ServiceDeclarationSource; idle: boolean; offers: boolean }>) {
    const service = stoppedService(source);
    const resolution: PreviewGatewayResolution = {
      _tag: "Dormant",
      revision: 0,
      source: { serviceId: service.id, sourceAttemptId },
      workspaceId: null,
    };
    const repos = Layer.mergeAll(
      Layer.mock(PreviewsRepo, {
        readForWorktree: () => Effect.succeed([before]),
        gatewaySnapshots: () =>
          Effect.succeed(new Map([[before.preview.id, { preview: before.preview, resolution }]])),
        activityOf: () =>
          Effect.succeed(
            idle
              ? {
                  previewId: before.preview.id,
                  lastAdmittedAt: null,
                  idleStoppedAttemptId: sourceAttemptId,
                  idleMinutes: 30,
                  idleStoppedAt: new Date(0),
                }
              : null,
          ),
      }),
      Layer.mock(ServicesRepo, { byId: () => Effect.succeed(service) }),
      Layer.mock(SessionProcessesRepo, { byId: () => Effect.succeed(null) }),
      Layer.mock(ServiceObservationsRepo, {}),
      Layer.mock(PreviewPreparationsRepo, { latestForWorktree: () => Effect.succeed(null) }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const described = yield* describeWorktreePreviews(WORKTREE, [before], ON);
        const slack = yield* (yield* SlackPreviewReads).forWorktree(WORKTREE);
        return { described, slack };
      }).pipe(
        Effect.provide(
          SlackPreviewReadsLive.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                repos,
                Layer.succeed(PreviewSetupConfig, { setup: ON }),
                Layer.succeed(NetworkConfig, makePublicNetwork(DEFAULT_APP_URL, [])),
              ),
            ),
          ),
        ),
      ),
    );
    expect(result.described.previews[0]?.open._tag).toBe(offers ? "Open" : "Refused");
    expect(result.slack).toMatchObject({
      _tag: "Shown",
      previews: [{ service: "before", openable: offers }],
    });
  }
});
