import {
  SlackProofDeliveriesRepo,
  SlackProofDeliveryError,
  type SlackProofDelivery,
  type SlackProofDeliveryProgress,
  type SlackProofTurnProgress,
  type SlackProofTurnContext,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
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

import { deliverProofToSlack, type SlackProofDeliveryInput } from "./slack-proof-delivery.ts";

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
    turnId: AgentTurnId.make("turn"),
    title: "Completed task on board",
    caption: "The task appears in Done.",
    source: {
      _tag: "Checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      ordinal: 2,
      commit: Sha.make("1a2b3c4".padEnd(40, "0")),
    },
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
  let progress: SlackProofTurnProgress = { batches: [] };
  let context: SlackProofTurnContext | null = {
    projectId: ProjectId.make("project"),
    changeId: ChangeId.make("change"),
    url: "https://mend.test/sessions/session",
    previewUrl: "https://mend.test/preview/p",
    push: { sessionId: SessionId.make("session"), updates: false },
  };
  const file = (artifactId: ProofArtifactId) =>
    Effect.sync(() => {
      let row: SlackProofDelivery = rows.get(artifactId) ?? {
        sessionId: SessionId.make("session"),
        artifactId,
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
      rows.set(artifactId, row);
      return {
        read: () => Effect.sync(() => row),
        startAttempt: () =>
          Effect.gen(function* () {
            row = { ...row, attempts: row.attempts + 1, updatedAt: yield* DateTime.nowAsDate };
            rows.set(artifactId, row);
            return row;
          }),
        save: (next: SlackProofDeliveryProgress) =>
          Effect.gen(function* () {
            if (refuseSave?.(next)) {
              refuseSave = null;
              return yield* new SlackProofDeliveryError({
                operation: "save",
                message: "database unavailable",
              });
            }
            row = { ...row, ...next, updatedAt: yield* DateTime.nowAsDate };
            rows.set(artifactId, row);
            return row;
          }),
      };
    });
  const repo = Layer.mock(SlackProofDeliveriesRepo, {
    withTurn: (_key, use) =>
      lock.withPermit(
        Effect.suspend(() =>
          use({
            context,
            file,
            read: () => Effect.sync(() => progress),
            save: (next) =>
              Effect.sync(() => {
                progress = next;
              }),
          }),
        ),
      ),
  });
  const input: SlackProofDeliveryInput<never> = {
    turnId: AgentTurnId.make("turn"),
    artifacts: [artifact],
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
  const layer = Layer.merge(repo, slack.layer);
  return {
    input,
    layer,
    slack,
    rows,
    setContext: (next: SlackProofTurnContext | null) => {
      context = next;
    },
    failNextSave: (when: (progress: SlackProofDeliveryProgress) => boolean) => {
      refuseSave = when;
    },
  };
};

const video = new ProofArtifact({
  ...artifactOf(),
  id: ProofArtifactId.make("video"),
  title: "Complete a task and reload",
  source: {
    _tag: "Checkpoint",
    checkpointId: CheckpointId.make("cp3"),
    ordinal: 3,
    commit: Sha.make("a".repeat(40)),
  },
  capture: {
    _tag: "Video",
    span: { screenId: ScreenId.make("screen"), fromSeq: 10, toSeq: 20 },
    media: { blobKey: "video.mp4", mimeType: "video/mp4", bytes: 4, sha256: "a".repeat(64) },
    durationMs: 28_000,
    ending: "stopped",
  },
});

describe("quiet turn delivery", () => {
  it.effect(
    "shares all files in one message with one button row, short titles and caption alt text",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const input = { ...h.input, artifacts: [artifactOf(), video] };
        yield* deliverProofToSlack(input);
        yield* deliverProofToSlack(input);
        const completions = h.slack.calls.filter((call) => call.kind === "filesCompleteUpload");
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({
          input: {
            files: [
              { title: "Completed task on board" },
              { title: "Complete a task and reload · 0:28" },
            ],
            blocks: [
              { text: { text: "Captured · checkpoint #3" } },
              {
                type: "actions",
                elements: [
                  { text: { text: "Open in Mend" } },
                  { text: { text: "Open preview" } },
                  { text: { text: "Push and open pull request" } },
                ],
              },
            ],
          },
        });
        expect(completions[0]?.input.initialComment).toBeUndefined();
        expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(0);
        expect(h.slack.calls.find((call) => call.kind === "filesGetUploadUrl")).toMatchObject({
          input: { altText: artifactOf().caption },
        });
        const visible = JSON.stringify(completions);
        for (const old of [
          "observed",
          "answered HTTP",
          "autopr",
          "only they can use",
          ".mp4",
          artifactOf().caption,
        ])
          expect(visible).not.toContain(old);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("a turn without captures posts only the button row, once", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.setContext({
        projectId: h.input.project.id,
        changeId: null,
        url: "https://mend.test/session",
        previewUrl: null,
        push: null,
      });
      yield* deliverProofToSlack({ ...h.input, artifacts: [] });
      yield* deliverProofToSlack({ ...h.input, artifacts: [] });
      expect(h.slack.calls).toMatchObject([
        {
          kind: "postMessage",
          input: {
            text: "Open in Mend",
            blocks: [{ type: "actions", elements: [{ text: { text: "Open in Mend" } }] }],
          },
        },
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("a definitely failed video is a note in the screenshot's message", () => {
    const h = harness();
    return Effect.gen(function* () {
      const input = {
        ...h.input,
        artifacts: [artifactOf(), video],
        media: (artifact: ProofArtifact) =>
          artifact.id === video.id
            ? Effect.fail(
                new SlackApiError({
                  method: "proof.media",
                  code: "media_not_found",
                  message: "Missing video",
                }),
              )
            : h.input.media(artifact),
      };
      yield* deliverProofToSlack(input);
      yield* deliverProofToSlack(input);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(0);
      expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toMatchObject([
        {
          input: {
            files: [{ title: "Completed task on board" }],
            blocks: [
              {
                text: {
                  text: "Captured · checkpoint #3 · the video didn't reach Slack, it's in Mend",
                },
              },
              { type: "actions" },
            ],
          },
        },
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("all-file refusal posts one short note with controls and no error code", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.slack.refuseFiles(
        new SlackApiError({
          method: "files.completeUploadExternal",
          code: "file_uploads_disabled",
          message: "No uploads",
        }),
      );
      yield* deliverProofToSlack(h.input);
      yield* deliverProofToSlack(h.input);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toMatchObject([
        {
          input: {
            text: "Captured · checkpoint #2 · the screenshot didn't reach Slack, it's in Mend",
          },
        },
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("late captures use a follow-up batch without reposting the first file", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* deliverProofToSlack(h.input);
      yield* deliverProofToSlack({ ...h.input, artifacts: [artifactOf(), video] });
      yield* deliverProofToSlack({ ...h.input, artifacts: [artifactOf(), video] });
      expect(
        h.slack.calls
          .filter((call) => call.kind === "filesCompleteUpload")
          .map((call) => call.input.files.map((file) => file.title)),
      ).toEqual([["Completed task on board"], ["Complete a task and reload · 0:28"]]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("uncertain visibility stays quiet, slows observation and never re-completes", () => {
    const h = harness();
    let visible = false;
    let reads = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const input = { ...h.input, attemptLimit: 1 };
      yield* deliverProofToSlack(input);
      yield* deliverProofToSlack(input);
      expect(reads).toBe(0);
      yield* TestClock.adjust("5 minutes");
      yield* deliverProofToSlack(input);
      expect(reads).toBe(1);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(0);
      yield* TestClock.adjust("5 minutes");
      visible = true;
      yield* deliverProofToSlack(input);
      yield* deliverProofToSlack(input);
      expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
      expect(h.rows.get(artifactOf().id)?.state).toBe("shared");
    }).pipe(
      Effect.provideService(SlackApi, {
        ...h.slack.service,
        filesInfo: (token, id, channel) =>
          Effect.suspend(() => {
            reads += 1;
            return visible ? h.slack.service.filesInfo(token, id, channel) : Effect.succeed([]);
          }),
      }),
      Effect.provide(h.layer),
    );
  });
  for (const code of ["request_failed", "http_503"] as const)
    it.effect(`uncertain completion ${code} is reconciled without a second completion`, () => {
      const h = harness();
      let lose = true;
      return Effect.gen(function* () {
        yield* deliverProofToSlack(h.input);
        yield* deliverProofToSlack(h.input);
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
      }).pipe(
        Effect.provideService(SlackApi, {
          ...h.slack.service,
          filesCompleteUpload: (token, input) =>
            h.slack.service.filesCompleteUpload(token, input).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  if (!lose) return Effect.void;
                  lose = false;
                  return Effect.fail(
                    new SlackApiError({
                      method: "files.completeUploadExternal",
                      code,
                      message: "Response lost",
                    }),
                  );
                }),
              ),
            ),
        }),
        Effect.provide(h.layer),
      );
    });
  it.effect("post response loss recovers the text message by its stable id", () => {
    const h = harness();
    let lose = true;
    return Effect.gen(function* () {
      const input = { ...h.input, artifacts: [] };
      yield* deliverProofToSlack(input).pipe(Effect.flip);
      yield* deliverProofToSlack(input);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(1);
    }).pipe(
      Effect.provideService(SlackApi, {
        ...h.slack.service,
        postMessage: (token, input) =>
          h.slack.service.postMessage(token, input).pipe(
            Effect.flatMap((result) => {
              if (!lose) return Effect.succeed(result);
              lose = false;
              return Effect.fail(
                new SlackApiError({
                  method: "chat.postMessage",
                  code: "request_failed",
                  message: "Response lost",
                }),
              );
            }),
          ),
      }),
      Effect.provide(h.layer),
    );
  });
  it.effect("retries an upload without splitting captures that settle before the message", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.slack.refuseFiles(
        new SlackApiError({
          method: "files.uploadBytes",
          code: "http_503",
          message: "Unavailable",
        }),
      );
      yield* deliverProofToSlack(h.input).pipe(Effect.flip);
      yield* deliverProofToSlack({ ...h.input, artifacts: [artifactOf(), video] });
      const completed = h.slack.calls.filter((call) => call.kind === "filesCompleteUpload");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.input.files).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("a failed receipt save resumes by observing the completed batch", () => {
    const h = harness();
    return Effect.gen(function* () {
      h.failNextSave((progress) => progress.state === "shared");
      yield* deliverProofToSlack(h.input).pipe(Effect.flip);
      yield* deliverProofToSlack(h.input);
      expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
      expect(h.slack.calls.filter((call) => call.kind === "filesUpload")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("visibility observations stop after an hour without a failure notice", () => {
    const h = harness();
    let reads = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      yield* deliverProofToSlack({ ...h.input, attemptLimit: 1 });
      yield* TestClock.adjust("61 minutes");
      yield* deliverProofToSlack({ ...h.input, attemptLimit: 1 });
      const checked = reads;
      yield* TestClock.adjust("5 minutes");
      yield* deliverProofToSlack({ ...h.input, attemptLimit: 1 });
      expect(reads).toBe(checked);
      expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(0);
    }).pipe(
      Effect.provideService(SlackApi, {
        ...h.slack.service,
        filesInfo: () =>
          Effect.sync(() => {
            reads += 1;
            return [];
          }),
      }),
      Effect.provide(h.layer),
    );
  });
  for (const gate of ["not-released", "connect", "private", "disabled"] as const)
    it.effect(`withholds ${gate} without Slack calls`, () => {
      const h = harness();
      return Effect.gen(function* () {
        if (gate === "not-released") h.setContext(null);
        const input = {
          ...h.input,
          thread: { ...h.input.thread, external: gate === "connect" },
          project: {
            ...h.input.project,
            visibility: gate === "private" ? ("private" as const) : ("shared" as const),
          },
          install: {
            ...h.input.install,
            settings: { ...h.input.install.settings, showAgentMessages: gate !== "disabled" },
          },
        };
        yield* deliverProofToSlack(input);
        expect(h.slack.calls).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    });
});
