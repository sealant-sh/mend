import { createHash } from "node:crypto";

import {
  SlackProofDeliveriesRepo,
  type SealedSlackInstall,
  type SlackProofBatch,
  type SlackProofDelivery,
  type SlackProofTurnContext,
  type SlackThreadSession,
} from "@mend/db";
import type { AgentTurnId } from "@mend/domain";
import { type Project, type ProofArtifact } from "@mend/domain/workbench";
import { disclosureFor, escapeSlack, threadShowsReplies, turnControlsMessage } from "@mend/slack";
import {
  SLACK_TOKEN_REFUSALS,
  SlackApi,
  SlackApiError,
  type SlackUploadBody,
} from "@mend/slack/client";
import { DateTime, Effect } from "effect";
/** Final refusals need a person's intervention, rather than another upload attempt. */
const FINAL_UPLOAD_ERRORS: ReadonlySet<string> = new Set([
  ...SLACK_TOKEN_REFUSALS,
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
  "file_uploads_disabled",
  "file_uploads_except_images_disabled",
  "file_upload_size_restricted",
  "file_type_not_allowed",
  "storage_limit_reached",
  "posting_to_channel_denied",
  "no_permission",
  "access_denied",
  "ekm_access_denied",
  "is_archived",
  "restricted_action",
  "invalid_length",
  "invalid_bytes",
  "media_not_found",
  "not_slack_host",
]);

/** The reporter releases a turn only after its unchanged agent reply has been posted. */
export interface SlackProofDeliveryInput<R> {
  readonly turnId: AgentTurnId;
  readonly artifacts: ReadonlyArray<ProofArtifact>;
  readonly thread: Pick<
    SlackThreadSession,
    "sessionId" | "teamId" | "channelId" | "threadTs" | "external"
  >;
  readonly install: Pick<SealedSlackInstall, "teamId" | "organizationId" | "settings">;
  readonly project: Pick<Project, "id" | "organizationId" | "visibility">;
  readonly token: string;
  readonly attemptLimit?: number;
  readonly media: (artifact: ProofArtifact) => Effect.Effect<SlackUploadBody, SlackApiError, R>;
}

/** Slack receives a unique transport filename; the visible title is the capture's short name. */
export const slackProofFilename = (artifact: ProofArtifact): string =>
  `${artifact.id}.${artifact.capture._tag === "Video" ? "mp4" : "png"}`;

const fileTitle = (artifact: ProofArtifact) => {
  if (artifact.capture._tag !== "Video") return artifact.title;
  const seconds = Math.floor(artifact.capture.durationMs / 1000);
  return `${artifact.title} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const captureLine = (
  artifacts: ReadonlyArray<ProofArtifact>,
  failed: ReadonlyArray<ProofArtifact>,
) => {
  const ordinal = artifacts.reduce<number | null>(
    (latest, artifact) =>
      artifact.source._tag === "Checkpoint"
        ? Math.max(latest ?? 0, artifact.source.ordinal)
        : latest,
    null,
  );
  const notes = [
    ...new Set(
      failed.map((artifact) => {
        const capture = artifact.capture;
        const kind =
          capture._tag === "Video" || (capture._tag === "NotCaptured" && capture.kind === "video")
            ? "video"
            : "screenshot";
        return capture._tag === "NotCaptured"
          ? `the ${kind} wasn't captured`
          : `the ${kind} didn't reach Slack, it's in Mend`;
      }),
    ),
  ];
  return escapeSlack(
    [`Captured · ${ordinal === null ? "source unknown" : `checkpoint #${ordinal}`}`, ...notes].join(
      " · ",
    ),
  );
};
const replyId = (sessionId: string, turnId: string, batch: number) => {
  const hex = createHash("sha256")
    .update(`mend:proof-turn:${sessionId}:${turnId}:${batch}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const pending = () =>
  new SlackApiError({
    method: "proof.delivery",
    code: "share_not_observed",
    message: "Slack's file share has not been observed yet.",
  });
const SHARE_RECHECK_MS = 5 * 60_000;
const SHARE_OBSERVATION_MS = 60 * 60_000;

/** Uploads each turn's settled files together, with durable batch membership and file identities. */
export const deliverProofToSlack = Effect.fn("deliverProofToSlack")(function* <R>(
  input: SlackProofDeliveryInput<R>,
) {
  const { artifacts, thread, install, project, token } = input;
  const deliveries = yield* SlackProofDeliveriesRepo;
  const slack = yield* SlackApi;
  yield* deliveries.withTurn({ sessionId: thread.sessionId, turnId: input.turnId }, (store) =>
    Effect.gen(function* () {
      const context: SlackProofTurnContext | null = store.context;
      if (context === null) return;
      if (
        install.teamId !== thread.teamId ||
        install.organizationId !== project.organizationId ||
        thread.external ||
        !threadShowsReplies(thread.channelId, project.visibility) ||
        !disclosureFor(install.settings, thread.external).agentMessages
      )
        return;
      let progress = yield* store.read();
      const eligible = artifacts.filter(
        (artifact) =>
          artifact.sessionId === thread.sessionId &&
          artifact.projectId === project.id &&
          artifact.turnId === input.turnId &&
          artifact.capture._tag !== "Recording",
      );
      const included = new Set(progress.batches.flatMap((batch) => batch.artifactIds));
      const additions: Array<ProofArtifact> = [];
      for (const artifact of eligible) {
        if (included.has(artifact.id)) continue;
        const file = yield* store.file(artifact.id);
        const row = yield* file.read();
        // Completion from the older per-file worker may already have shared this file.
        if (row.completionStartedAt !== null && row.state === "uploaded") {
          const at = yield* DateTime.nowAsDate;
          if (
            at.getTime() < row.completionStartedAt.getTime() + SHARE_OBSERVATION_MS &&
            (row.attempts < (input.attemptLimit ?? 7) ||
              at.getTime() >= row.updatedAt.getTime() + SHARE_RECHECK_MS)
          ) {
            const ts = yield* slack.filesInfo(token, row.slackFileId ?? "", thread.channelId).pipe(
              Effect.map(
                (shares) => shares.find((share) => share.threadTs === thread.threadTs)?.ts ?? null,
              ),
              Effect.catch(() => Effect.succeed(null)),
            );
            yield* file.startAttempt();
            if (ts !== null)
              yield* file.save({
                ...row,
                state: "shared",
                messageTs: ts,
                errorCode: null,
                uploadUrl: null,
              });
            else
              yield* Effect.logInfo("slack proof: earlier share not observed").pipe(
                Effect.annotateLogs({
                  artifactId: artifact.id,
                  slackFileId: row.slackFileId,
                  threadTs: thread.threadTs,
                }),
              );
          }
          continue;
        }
        if (
          row.state !== "shared" &&
          row.state !== "withheld" &&
          row.errorCode !== "share_not_observed"
        )
          additions.push(artifact);
      }
      if (additions.length > 0 || progress.batches.length === 0) {
        const waiting = progress.batches.findIndex(
          (batch) => !batch.finished && batch.startedAt === null && !batch.replyStarted,
        );
        const ids = additions.map((artifact) => artifact.id);
        progress = {
          batches:
            waiting < 0
              ? [
                  ...progress.batches,
                  {
                    artifactIds: ids,
                    startedAt: null,
                    finished: false,
                    messageTs: null,
                    replyStarted: false,
                  },
                ]
              : progress.batches.map((batch, index) =>
                  index === waiting
                    ? { ...batch, artifactIds: [...batch.artifactIds, ...ids] }
                    : batch,
                ),
        };
        yield* store.save(progress);
      }
      for (let index = 0; index < progress.batches.length; index += 1) {
        const initial = progress.batches[index];
        if (initial === undefined || initial.finished) continue;
        let batch: SlackProofBatch = initial;
        const saveBatch = (next: SlackProofBatch) =>
          Effect.gen(function* () {
            batch = next;
            progress = {
              batches: progress.batches.map((current, at) => (at === index ? next : current)),
            };
            yield* store.save(progress);
          });
        const captures = eligible.filter((artifact) => batch?.artifactIds.includes(artifact.id));
        // File stores use the turn lock's connection, without holding a database transaction.
        const prepared = yield* Effect.forEach(captures, (artifact) =>
          Effect.gen(function* () {
            const file = yield* store.file(artifact.id);
            let row = yield* file.read();
            const save = (next: SlackProofDelivery) =>
              file.save(next).pipe(
                Effect.tap((saved) =>
                  Effect.sync(() => {
                    row = saved;
                  }),
                ),
              );
            if (row.state === "failed" || row.state === "shared") return { artifact, row, file };
            const now = yield* DateTime.nowAsDate;
            if (batch?.startedAt !== null && batch?.startedAt !== undefined)
              return { artifact, row, file };
            row = yield* file.startAttempt();
            if (artifact.capture._tag === "NotCaptured") {
              yield* save({ ...row, state: "failed", errorCode: "not_captured" });
              return { artifact, row, file };
            }
            yield* Effect.gen(function* () {
              const capture = artifact.capture;
              if (capture._tag !== "Screenshot" && capture._tag !== "Video") return;
              if (row.slackFileId === null) {
                const ticket = yield* slack.filesGetUploadUrl(token, {
                  filename: slackProofFilename(artifact),
                  length: capture.media.bytes,
                  ...(capture._tag === "Screenshot"
                    ? { altText: artifact.caption.slice(0, 1000) }
                    : {}),
                });
                yield* save({ ...row, slackFileId: ticket.fileId, uploadUrl: ticket.uploadUrl });
              }
              if (row.state === "reserved") {
                if (row.uploadUrl === null)
                  return yield* Effect.die("proof ticket has no upload URL");
                const media = yield* input.media(artifact);
                if (media.length !== capture.media.bytes)
                  return yield* new SlackApiError({
                    method: "proof.media",
                    code: "invalid_length",
                    message: "Stored proof length differs.",
                  });
                yield* slack.filesUpload(row.uploadUrl, media);
                yield* save({ ...row, state: "uploaded", errorCode: null });
              }
            }).pipe(
              Effect.catchTag("SlackApiError", (error) =>
                Effect.gen(function* () {
                  if (
                    !FINAL_UPLOAD_ERRORS.has(error.code) &&
                    row.attempts < (input.attemptLimit ?? 7)
                  ) {
                    const expired =
                      error.code === "file_not_found" ||
                      (error.method === "files.uploadBytes" &&
                        ["http_404", "http_410"].includes(error.code));
                    yield* save({
                      ...row,
                      errorCode: error.code,
                      ...(expired
                        ? { slackFileId: null, uploadUrl: null, state: "reserved" as const }
                        : {}),
                    });
                    return yield* error;
                  }
                  yield* save({ ...row, state: "failed", uploadUrl: null, errorCode: error.code });
                }),
              ),
            );
            yield* Effect.logInfo("slack proof: file prepared").pipe(
              Effect.annotateLogs({
                artifactId: artifact.id,
                state: row.state,
                at: now.toISOString(),
              }),
            );
            return { artifact, row, file };
          }),
        );
        const failed = prepared
          .filter((file) => file.row.state === "failed")
          .map((file) => file.artifact);
        const uploadable = prepared.filter(
          (file) => file.row.state === "uploaded" && file.row.slackFileId !== null,
        );
        const controls = turnControlsMessage(context);
        const text = captures.length === 0 ? controls.text : captureLine(captures, failed);
        const clientMessageId = replyId(thread.sessionId, input.turnId, index);
        const blocks = [
          ...(captures.length === 0
            ? []
            : [
                {
                  type: "section" as const,
                  block_id: clientMessageId,
                  text: { type: "mrkdwn" as const, text },
                },
              ]),
          ...controls.blocks,
        ];
        if (uploadable.length === 0 && batch.startedAt === null) {
          let ts =
            batch.messageTs ??
            prepared.find((item) => item.row.state === "shared")?.row.messageTs ??
            null;
          if (ts === null && batch.replyStarted) {
            const replies = yield* slack.conversationsReplies(token, {
              channel: thread.channelId,
              ts: thread.threadTs,
            });
            ts =
              replies.find((reply) => reply.isBot && reply.clientMessageId === clientMessageId)
                ?.ts ?? null;
          }
          if (ts === null) {
            yield* saveBatch({ ...batch, replyStarted: true });
            ts = (yield* slack.postMessage(token, {
              channel: thread.channelId,
              threadTs: thread.threadTs,
              text,
              blocks,
              clientMessageId,
            })).ts;
          }
          for (const item of prepared) yield* item.file.save({ ...item.row, messageTs: ts });
          yield* saveBatch({ ...batch, messageTs: ts, finished: true });
          continue;
        }
        if (batch.startedAt === null) {
          const startedAt = (yield* DateTime.nowAsDate).getTime();
          yield* saveBatch({ ...batch, startedAt });
          for (const item of uploadable)
            yield* item.file.save({ ...item.row, completionStartedAt: new Date(startedAt) });
          const completion = yield* slack
            .filesCompleteUpload(token, {
              files: uploadable.flatMap((item) =>
                item.row.slackFileId === null
                  ? []
                  : [{ id: item.row.slackFileId, title: fileTitle(item.artifact) }],
              ),
              channelId: thread.channelId,
              threadTs: thread.threadTs,
              blocks,
            })
            .pipe(Effect.result);
          if (completion._tag === "Failure") {
            const error = completion.failure;
            if (
              error.code === "request_failed" ||
              /^http_5\d\d$/.test(error.code) ||
              [
                "internal_error",
                "fatal_error",
                "service_unavailable",
                "request_timeout",
                "already_complete",
              ].includes(error.code)
            ) {
              yield* Effect.logInfo("slack proof: completion response uncertain").pipe(
                Effect.annotateLogs({ turnId: input.turnId, code: error.code }),
              );
            } else {
              yield* saveBatch({ ...batch, startedAt: null });
              if (
                !FINAL_UPLOAD_ERRORS.has(error.code) &&
                uploadable.some((item) => item.row.attempts < (input.attemptLimit ?? 7))
              )
                return yield* error;
              for (const item of uploadable)
                yield* item.file.save({
                  ...item.row,
                  state: "failed",
                  errorCode: error.code,
                  completionStartedAt: null,
                  uploadUrl: null,
                });
              index -= 1;
              continue;
            }
          } else
            yield* Effect.logInfo("slack proof: upload completion accepted").pipe(
              Effect.annotateLogs({
                turnId: input.turnId,
                files: uploadable.length,
                threadTs: thread.threadTs,
              }),
            );
        }
        let allObserved = true;
        let ts =
          batch.messageTs ??
          prepared.find((item) => item.row.state === "shared")?.row.messageTs ??
          null;
        const checkedAt = yield* DateTime.nowAsDate;
        for (const item of uploadable) {
          const row = yield* item.file.read();
          if (
            row.attempts >= (input.attemptLimit ?? 7) &&
            checkedAt.getTime() < row.updatedAt.getTime() + SHARE_RECHECK_MS
          ) {
            allObserved = false;
            continue;
          }
          const observed = yield* slack
            .filesInfo(token, row.slackFileId ?? "", thread.channelId)
            .pipe(
              Effect.map(
                (shares) => shares.find((share) => share.threadTs === thread.threadTs)?.ts ?? null,
              ),
              Effect.catch((error) =>
                Effect.logInfo("slack proof: share metadata unavailable").pipe(
                  Effect.annotateLogs({ artifactId: item.artifact.id, code: error.code }),
                  Effect.as(null),
                ),
              ),
            );
          if (observed !== null) {
            ts = observed;
            yield* item.file.save({
              ...row,
              state: "shared",
              messageTs: observed,
              errorCode: null,
              uploadUrl: null,
            });
          } else {
            allObserved = false;
            yield* item.file.startAttempt();
            yield* Effect.logInfo("slack proof: share not observed").pipe(
              Effect.annotateLogs({
                artifactId: item.artifact.id,
                slackFileId: row.slackFileId,
                threadTs: thread.threadTs,
                attempts: row.attempts,
                checking: checkedAt.getTime() < (batch.startedAt ?? 0) + SHARE_OBSERVATION_MS,
              }),
            );
          }
        }
        const finished =
          allObserved || checkedAt.getTime() >= (batch.startedAt ?? 0) + SHARE_OBSERVATION_MS;
        yield* saveBatch({ ...batch, messageTs: ts, finished });
        if (!finished && uploadable.some((item) => item.row.attempts < (input.attemptLimit ?? 7)))
          return yield* pending();
      }
    }),
  );
});
