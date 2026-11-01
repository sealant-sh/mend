import {
  SlackProofDeliveriesRepo,
  SlackProofDeliveryError,
  type SlackProofDelivery,
  type SlackProofDeliveryProgress,
} from "@mend/db";
import {
  ChangeId,
  OrganizationId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { ProofArtifact, type ProofCapture } from "@mend/domain/workbench";
import {
  makeFakeSlack,
  SlackApi,
  SlackApiError,
  type FakeSlackWorkspace,
} from "@mend/slack/client";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { DateTime, Effect, Layer, Semaphore } from "effect";
import { describe, expect } from "vitest";

import {
  deliverProofToSlack,
  slackProofFilename,
  type SlackProofDeliveryInput,
} from "./slack-proof-delivery.ts";

const workspace: FakeSlackWorkspace = {
  teamId: "T1",
  teamName: "Test",
  appId: "A1",
  botId: "B1",
  botUserId: "UBOT",
  botToken: "xoxb-test",
  appToken: "xapp-test",
  threads: { "C1:1.0": [] },
};
const now = new Date("2026-11-01T14:02:00Z");
const png: ProofCapture = {
  _tag: "Screenshot",
  moment: { screenId: ScreenId.make("screen"), seq: 10 },
  media: { blobKey: "proof.png", mimeType: "image/png", bytes: 4, sha256: "a".repeat(64) },
};
const artifactOf = (capture: ProofCapture = png) =>
  new ProofArtifact({
    id: ProofArtifactId.make("proof-1"),
    changeId: ChangeId.make("change"),
    worktreeId: WorktreeId.make("worktree"),
    projectId: ProjectId.make("project"),
    sessionId: SessionId.make("session"),
    turnId: null,
    title: "Completed task on board",
    caption: "The task appears in Done.",
    side: "before",
    source: { _tag: "Base", commit: Sha.make("1a2b3c4".padEnd(40, "0")) },
    capture,
    launch: null,
    differences: null,
    observedFrom: now,
    observedTo: null,
    createdAt: now,
  });

const harness = (artifact = artifactOf(), slackWorkspace = workspace) => {
  const slack = makeFakeSlack([slackWorkspace]);
  const rows = new Map<string, SlackProofDelivery>();
  const lock = Semaphore.makeUnsafe(1);
  let refuseSave: ((progress: SlackProofDeliveryProgress) => boolean) | null = null;
  const repo = SlackProofDeliveriesRepo.of({
    pendingSince: () => Effect.succeed([]),
    withDelivery: (key, use) =>
      lock.withPermit(
        Effect.suspend(() => {
          const id = `${key.sessionId}:${key.artifactId}`;
          let row = rows.get(id) ?? {
            ...key,
            slackFileId: null,
            uploadUrl: null,
            state: "reserved",
            messageTs: null,
            errorCode: null,
            attempts: 0,
            completionStartedAt: null,
            replyStartedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          rows.set(id, row);
          return use({
            read: () => Effect.succeed(row),
            startAttempt: () =>
              Effect.gen(function* () {
                row = { ...row, attempts: row.attempts + 1, updatedAt: yield* DateTime.nowAsDate };
                rows.set(id, row);
                return row;
              }),
            save: (progress) =>
              Effect.gen(function* () {
                if (refuseSave?.(progress) === true) {
                  refuseSave = null;
                  return yield* Effect.fail(
                    new SlackProofDeliveryError({
                      operation: "save",
                      message: "database unavailable",
                    }),
                  );
                }
                row = { ...row, ...progress, updatedAt: yield* DateTime.nowAsDate };
                rows.set(id, row);
                return row;
              }),
          });
        }),
      ),
  });
  const input: SlackProofDeliveryInput<never, never> = {
    artifact,
    thread: {
      sessionId: SessionId.make("session"),
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.0",
      external: false,
    },
    project: {
      id: ProjectId.make("project"),
      organizationId: OrganizationId.make("org"),
      visibility: "shared",
    },
    install: {
      teamId: "T1",
      organizationId: OrganizationId.make("org"),
      settings: {
        defaultHarness: "claude",
        showAgentMessages: true,
        showDiffs: false,
        externalChannels: false,
        landAutomatically: false,
      },
    },
    token: workspace.botToken,
    media: () => Effect.succeed({ body: new Uint8Array([1, 2, 3, 4]), length: 4 }),
  };
  const layer = Layer.merge(Layer.succeed(SlackProofDeliveriesRepo, repo), slack.layer);
  return {
    input,
    layer,
    slack,
    rows,
    failNextSave: (when: (progress: SlackProofDeliveryProgress) => boolean) => {
      refuseSave = when;
    },
  };
};

describe("Slack proof delivery", () => {
  it.effect(
    "uploads the PNG with its label and caption, saves the ticket before reading bytes, and does not repost on retry",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const first = yield* deliverProofToSlack({
          ...h.input,
          media: () =>
            Effect.sync(() => {
              expect([...h.rows.values()][0]?.slackFileId).not.toBeNull();
              return { body: new Uint8Array(4), length: 4 };
            }),
        });
        expect(first).toMatchObject({
          state: "shared",
          messageTs: expect.any(String),
          slackFileId: expect.any(String),
          attempts: 1,
        });
        expect(h.slack.calls.map((call) => call.kind)).toEqual([
          "filesGetUploadUrl",
          "filesUpload",
          "filesCompleteUpload",
        ]);
        expect(h.slack.calls.at(-1)).toMatchObject({
          input: {
            channelId: "C1",
            threadTs: "1.0",
            initialComment:
              "Completed task on board · before · base 1a2b3c4 · observed 14:02 UTC\nThe task appears in Done.",
          },
        });
        yield* deliverProofToSlack(h.input);
        expect(h.slack.calls).toHaveLength(3);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("uploads an MP4 as a separate file with its own caption", () => {
    const artifact = artifactOf({
      _tag: "Video",
      span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 5 },
      media: { blobKey: "video.mp4", mimeType: "video/mp4", bytes: 4, sha256: "a".repeat(64) },
      durationMs: 9000,
      ending: "stopped",
    });
    const h = harness(new ProofArtifact({ ...artifact, side: "after" }));
    return Effect.gen(function* () {
      yield* deliverProofToSlack(h.input);
      expect(h.slack.calls[0]).toMatchObject({
        input: { filename: expect.stringMatching(/-after-.*\.mp4$/), length: 4 },
      });
      expect(
        h.slack.calls[0]?.kind === "filesGetUploadUrl" && h.slack.calls[0].input,
      ).not.toHaveProperty("altText");
      expect(h.slack.calls[2]).toMatchObject({
        input: { initialComment: expect.stringContaining(" · after · ") },
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "recognizes a completed upload after the final database write failed, without completing twice",
    () => {
      const h = harness();
      h.failNextSave((progress) => progress.state === "shared");
      return Effect.gen(function* () {
        expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
          _tag: "SlackProofDeliveryError",
        });
        const retried = yield* deliverProofToSlack(h.input);
        expect(retried).toMatchObject({ state: "shared", attempts: 2 });
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("replaces an expired ticket and uploads a fresh file", () => {
    const h = harness();
    return Effect.gen(function* () {
      const api = yield* SlackApi;
      const ticket = yield* api.filesGetUploadUrl(h.input.token, {
        filename: "old.png",
        length: 4,
        altText: "old",
      });
      const repo = yield* SlackProofDeliveriesRepo;
      yield* repo.withDelivery(
        { sessionId: h.input.thread.sessionId, artifactId: h.input.artifact.id },
        (store) =>
          Effect.gen(function* () {
            yield* store.save({
              ...(yield* store.read()),
              slackFileId: ticket.fileId,
              uploadUrl: ticket.uploadUrl,
            });
          }),
      );
      h.slack.expireFile(ticket.fileId);
      const result = yield* deliverProofToSlack(h.input);
      expect(result?.state).toBe("shared");
      expect(result?.slackFileId).not.toBe(ticket.fileId);
      expect(h.slack.calls.filter((call) => call.kind === "filesGetUploadUrl")).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "records missing scope as final and posts one named failure with reinstall instructions",
    () => {
      const h = harness(artifactOf(), {
        ...workspace,
        grantedScopes: ["chat:write", "files:read"],
      });
      return Effect.gen(function* () {
        const result = yield* deliverProofToSlack(h.input);
        expect(result).toMatchObject({
          state: "failed",
          errorCode: "missing_scope",
          messageTs: expect.any(String),
        });
        yield* deliverProofToSlack(h.input);
        const posts = h.slack.calls.filter((call) => call.kind === "postMessage");
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
          input: {
            threadTs: "1.0",
            text: expect.stringContaining(slackProofFilename(h.input.artifact)),
          },
        });
        expect(JSON.stringify(posts)).toContain("files:write");
        expect(JSON.stringify(posts)).toContain("reinstall");
        expect(JSON.stringify(posts)).not.toContain("https://");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "withholds media in Slack Connect even when the install enables external messages",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const result = yield* deliverProofToSlack({
          ...h.input,
          thread: { ...h.input.thread, external: true },
          install: {
            ...h.input.install,
            settings: { ...h.input.install.settings, externalChannels: true },
          },
        });
        expect(result).toMatchObject({ state: "withheld", errorCode: "slack_connect" });
        expect(h.slack.calls).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "withholds private projects in channels, foreign organizations, and disabled agent messages",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const cases: ReadonlyArray<SlackProofDeliveryInput<never, never>> = [
          {
            ...h.input,
            project: { ...h.input.project, visibility: "private" },
            artifact: new ProofArtifact({
              ...h.input.artifact,
              id: ProofArtifactId.make("private"),
            }),
          },
          {
            ...h.input,
            install: { ...h.input.install, organizationId: OrganizationId.make("other") },
            artifact: new ProofArtifact({
              ...h.input.artifact,
              id: ProofArtifactId.make("foreign"),
            }),
          },
          {
            ...h.input,
            install: {
              ...h.input.install,
              settings: { ...h.input.install.settings, showAgentMessages: false },
            },
            artifact: new ProofArtifact({
              ...h.input.artifact,
              id: ProofArtifactId.make("disabled"),
            }),
          },
        ];
        for (const input of cases)
          expect((yield* deliverProofToSlack(input))?.state).toBe("withheld");
        expect(h.slack.calls).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("posts a not-captured label once, recovering a lost text receipt", () => {
    const h = harness(
      artifactOf({ _tag: "NotCaptured", kind: "screenshot", reason: "The base does not run." }),
    );
    h.failNextSave((progress) => progress.state === "shared");
    return Effect.gen(function* () {
      yield* deliverProofToSlack(h.input).pipe(Effect.flip);
      const retried = yield* deliverProofToSlack(h.input).pipe(
        Effect.provideService(SlackApi, {
          ...h.slack.service,
          postMessage: () => Effect.die("A retry must recover the existing text reply."),
          conversationsReplies: (token, input) =>
            h.slack.service.conversationsReplies(token, input).pipe(
              Effect.map((replies) =>
                replies.map((reply) => {
                  const { clientMessageId, ...withoutClientId } = reply;
                  expect(clientMessageId).toBeDefined();
                  return withoutClientId;
                }),
              ),
            ),
        }),
      );
      expect(retried).toMatchObject({
        state: "shared",
        slackFileId: null,
        messageTs: expect.any(String),
      });
      expect(h.slack.calls).toHaveLength(1);
      expect(h.slack.calls[0]).toMatchObject({
        kind: "postMessage",
        input: {
          threadTs: "1.0",
          text: expect.stringContaining(
            "before · base 1a2b3c4 · not captured · The base does not run.",
          ),
        },
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves an in-progress video for the job enqueued when it settles", () => {
    const h = harness(
      artifactOf({ _tag: "Recording", screenId: ScreenId.make("screen"), fromSeq: 1 }),
    );
    return Effect.gen(function* () {
      expect(yield* deliverProofToSlack(h.input)).toBeNull();
      expect(h.rows.size).toBe(0);
      expect(h.slack.calls).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("keeps a transient failure retryable and does not send a final-failure reply", () => {
    const h = harness();
    h.slack.refuseFiles(
      new SlackApiError({
        method: "files.getUploadURLExternal",
        code: "ratelimited",
        message: "wait",
      }),
    );
    return Effect.gen(function* () {
      expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
        code: "ratelimited",
      });
      expect(h.slack.calls).toEqual([]);
      expect((yield* deliverProofToSlack(h.input))?.state).toBe("shared");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reconciles a shared file when reading shares failed after completion", () => {
    const h = harness();
    h.slack.refuseFiles(
      new SlackApiError({ method: "files.info", code: "request_failed", message: "lost response" }),
    );
    return Effect.gen(function* () {
      expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
        code: "request_failed",
      });
      expect((yield* deliverProofToSlack(h.input))?.state).toBe("shared");
      expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("retries a completion that Slack explicitly rate limited", () => {
    const h = harness();
    h.slack.refuseFiles(
      new SlackApiError({
        method: "files.completeUploadExternal",
        code: "ratelimited",
        message: "wait",
        retryAfterSeconds: 1,
      }),
    );
    return Effect.gen(function* () {
      expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
        code: "ratelimited",
      });
      expect((yield* deliverProofToSlack(h.input))?.state).toBe("shared");
      expect(h.slack.calls.filter((call) => call.kind === "filesGetUploadUrl")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("posts one failure reply when saving its message receipt failed", () => {
    const h = harness(artifactOf(), { ...workspace, grantedScopes: ["chat:write", "files:read"] });
    h.failNextSave((progress) => progress.state === "failed" && progress.messageTs !== null);
    return Effect.gen(function* () {
      expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
        _tag: "SlackProofDeliveryError",
      });
      yield* deliverProofToSlack(h.input);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  for (const code of [
    "not_in_channel",
    "channel_not_found",
    "file_uploads_except_images_disabled",
    "file_upload_size_restricted",
    "file_type_not_allowed",
    "storage_limit_reached",
    "posting_to_channel_denied",
    "token_revoked",
  ]) {
    it.effect(`records ${code} as final and names the undelivered file`, () => {
      const h = harness();
      h.slack.refuseFiles(
        new SlackApiError({ method: "files.getUploadURLExternal", code, message: code }),
      );
      return Effect.gen(function* () {
        expect(yield* deliverProofToSlack(h.input)).toMatchObject({
          state: "failed",
          errorCode: code,
        });
        yield* deliverProofToSlack(h.input);
        expect(h.slack.calls).toHaveLength(1);
        expect(h.slack.calls[0]).toMatchObject({
          kind: "postMessage",
          input: { text: expect.stringContaining(code) },
        });
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("does not complete again while the result of completion is unknown", () => {
    const h = harness();
    return Effect.gen(function* () {
      const api = yield* SlackApi;
      const ticket = yield* api.filesGetUploadUrl(h.input.token, {
        filename: "uncertain.png",
        length: 4,
        altText: "uncertain",
      });
      yield* api.filesUpload(ticket.uploadUrl, { body: new Uint8Array(4), length: 4 });
      const repo = yield* SlackProofDeliveriesRepo;
      yield* repo.withDelivery(
        { sessionId: h.input.thread.sessionId, artifactId: h.input.artifact.id },
        (store) =>
          Effect.gen(function* () {
            yield* store.save({
              ...(yield* store.read()),
              slackFileId: ticket.fileId,
              state: "uploaded",
              completionStartedAt: now,
            });
          }),
      );
      expect(yield* deliverProofToSlack(h.input).pipe(Effect.flip)).toMatchObject({
        code: "share_not_observed",
      });
      expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "keeps an accepted DM video pending after seven checks, then observes its share without uploading again",
    () => {
      const h = harness(
        artifactOf({
          _tag: "Video",
          span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 5 },
          media: { blobKey: "video.mp4", mimeType: "video/mp4", bytes: 4, sha256: "a".repeat(64) },
          durationMs: 28_000,
          ending: "stopped",
        }),
        { ...workspace, threads: { "D1:1.0": [] } },
      );
      const input: SlackProofDeliveryInput<never, never> = {
        ...h.input,
        attemptLimit: 7,
        thread: { ...h.input.thread, channelId: "D1" },
        project: { ...h.input.project, visibility: "private" },
      };
      let visible = false;
      let checks = 0;
      const slack: SlackApi["Service"] = {
        ...h.slack.service,
        filesInfo: (token, fileId, channelId) =>
          Effect.suspend(() => {
            checks += 1;
            return visible
              ? h.slack.service.filesInfo(token, fileId, channelId)
              : Effect.succeed([]);
          }),
      };
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        for (let attempt = 1; attempt < 7; attempt++)
          expect(yield* deliverProofToSlack(input).pipe(Effect.flip)).toMatchObject({
            code: "share_not_observed",
          });
        expect(yield* deliverProofToSlack(input)).toMatchObject({
          state: "uploaded",
          errorCode: "share_not_observed",
          attempts: 7,
        });
        const posts = h.slack.calls.filter((call) => call.kind === "postMessage");
        expect(posts).toHaveLength(1);
        expect(posts[0]?.input.text).toContain("Slack accepted the upload");
        expect(posts[0]?.input.text).not.toContain("not delivered");
        expect(checks).toBe(7);
        yield* deliverProofToSlack(input);
        expect(checks).toBe(7);
        yield* TestClock.adjust("5 minutes");
        visible = true;
        expect(yield* deliverProofToSlack(input)).toMatchObject({
          state: "shared",
          errorCode: null,
          attempts: 8,
        });
        expect(checks).toBe(8);
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
        expect(h.slack.calls.filter((call) => call.kind === "filesUpload")).toHaveLength(1);
        expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(1);
        expect(h.slack.calls.find((call) => call.kind === "update")).toMatchObject({
          input: { text: expect.stringContaining("File shown in thread") },
        });
      }).pipe(Effect.provideService(SlackApi, slack), Effect.provide(h.layer));
    },
  );

  it.effect(
    "stops checking after an hour without claiming the accepted file was not delivered",
    () => {
      const h = harness();
      const input = { ...h.input, attemptLimit: 1 };
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        expect(yield* deliverProofToSlack(input)).toMatchObject({ state: "uploaded" });
        yield* TestClock.adjust("1 hour");
        expect(yield* deliverProofToSlack(input)).toMatchObject({
          state: "failed",
          errorCode: "share_not_observed",
        });
        const updates = h.slack.calls.filter((call) => call.kind === "update");
        expect(updates).toHaveLength(1);
        expect(updates[0]?.input.text).toContain("Mend has stopped checking");
        expect(updates[0]?.input.text).not.toContain("not delivered");
      }).pipe(
        Effect.provideService(SlackApi, {
          ...h.slack.service,
          filesInfo: () => Effect.succeed([]),
        }),
        Effect.provide(h.layer),
      );
    },
  );

  it.effect(
    "observes an accepted completion after its response was lost at the fast retry limit",
    () => {
      const h = harness();
      const input = { ...h.input, attemptLimit: 1 };
      const slack: SlackApi["Service"] = {
        ...h.slack.service,
        filesCompleteUpload: (token, upload) =>
          h.slack.service.filesCompleteUpload(token, upload).pipe(
            Effect.andThen(
              Effect.fail(
                new SlackApiError({
                  method: "files.completeUploadExternal",
                  code: "request_failed",
                  message: "Response lost",
                }),
              ),
            ),
          ),
      };
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        expect(yield* deliverProofToSlack(input)).toMatchObject({
          state: "uploaded",
          errorCode: "share_not_observed",
        });
        const notice = h.slack.calls.find((call) => call.kind === "postMessage");
        expect(notice?.input.text).toContain("Slack accepted the upload");
        yield* TestClock.adjust("5 minutes");
        expect(yield* deliverProofToSlack(input)).toMatchObject({ state: "shared", attempts: 2 });
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
      }).pipe(Effect.provideService(SlackApi, slack), Effect.provide(h.layer));
    },
  );

  it.effect(
    "records an observed share even if updating its earlier visibility notice fails",
    () => {
      const h = harness();
      const input = { ...h.input, attemptLimit: 1 };
      let visible = false;
      return Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        expect(yield* deliverProofToSlack(input)).toMatchObject({ state: "uploaded" });
        yield* TestClock.adjust("5 minutes");
        visible = true;
        expect(yield* deliverProofToSlack(input)).toMatchObject({
          state: "shared",
          errorCode: null,
        });
      }).pipe(
        Effect.provideService(SlackApi, {
          ...h.slack.service,
          filesInfo: (token, fileId, channelId) =>
            Effect.suspend(() =>
              visible ? h.slack.service.filesInfo(token, fileId, channelId) : Effect.succeed([]),
            ),
          update: () =>
            Effect.fail(
              new SlackApiError({
                method: "chat.update",
                code: "request_failed",
                message: "Response lost",
              }),
            ),
        }),
        Effect.provide(h.layer),
      );
    },
  );
});
