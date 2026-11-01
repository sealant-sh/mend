import { createHash } from "node:crypto";

import {
  SlackProofDeliveriesRepo,
  type SealedSlackInstall,
  type SlackProofDeliveryProgress,
  type SlackThreadSession,
} from "@mend/db";
import { type ProofArtifactId } from "@mend/domain";
import { proofLabel, type Project, type ProofArtifact } from "@mend/domain/workbench";
import { disclosureFor, escapeSlack, threadShowsReplies } from "@mend/slack";
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

export interface SlackProofDeliveryInput<E, R> {
  readonly artifact: ProofArtifact;
  readonly thread: Pick<
    SlackThreadSession,
    "sessionId" | "teamId" | "channelId" | "threadTs" | "external"
  >;
  readonly install: Pick<SealedSlackInstall, "teamId" | "organizationId" | "settings">;
  readonly project: Pick<Project, "id" | "organizationId" | "visibility">;
  readonly token: string;
  /** Fast attempts before an upload failure is final or share observation slows down. */
  readonly attemptLimit?: number;
  /** Opens a fresh reader for every attempt. */
  readonly media: (artifact: ProofArtifact) => Effect.Effect<SlackUploadBody, E, R>;
}

/** A readable filename, with the artifact identity keeping same-title captures distinct. */
export const slackProofFilename = (artifact: ProofArtifact): string => {
  const title =
    artifact.title
      .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 80) || "proof";
  return `${title}-${artifact.id}.${artifact.capture._tag === "Video" ? "mp4" : "png"}`;
};

const observedAt = (at: Date): string => `${at.toISOString().slice(11, 16)} UTC`;

/** Stable UUID so a text reply can be found after Slack answered but its receipt was not saved. */
const replyId = (
  sessionId: string,
  artifactId: ProofArtifactId,
  purpose: "missing" | "failed",
): string => {
  const hex = createHash("sha256")
    .update(`mend:proof:${sessionId}:${artifactId}:${purpose}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const pending = () =>
  new SlackApiError({
    method: "proof.delivery",
    code: "share_not_observed",
    message: "Slack has not shown the file in this thread yet. Mend will check again.",
  });

const SHARE_RECHECK_MS = 5 * 60_000;
const SHARE_OBSERVATION_MS = 60 * 60_000;

/**
 * Delivers one settled artifact to one thread. Callers resolve the current install and project
 * before calling; this function checks their audience and receives no blob-store transport.
 * Recording videos have nothing to deliver yet and return null.
 */
export const deliverProofToSlack = Effect.fn("deliverProofToSlack")(function* <E, R>(
  input: SlackProofDeliveryInput<E, R>,
) {
  const { artifact, thread, install, project, token } = input;
  if (artifact.capture._tag === "Recording") return null;
  const deliveries = yield* SlackProofDeliveriesRepo;
  const slack = yield* SlackApi;
  return yield* deliveries.withDelivery(
    { sessionId: thread.sessionId, artifactId: artifact.id },
    (store) =>
      Effect.gen(function* () {
        let delivery = yield* store.read();
        if (delivery.state === "shared" || delivery.state === "withheld") return delivery;
        const withheld =
          artifact.sessionId !== thread.sessionId || artifact.projectId !== project.id
            ? "artifact_session_mismatch"
            : install.teamId !== thread.teamId || install.organizationId !== project.organizationId
              ? "organization_mismatch"
              : thread.external
                ? "slack_connect"
                : !threadShowsReplies(thread.channelId, project.visibility)
                  ? "project_private"
                  : !disclosureFor(install.settings, thread.external).agentMessages
                    ? "agent_messages_disabled"
                    : null;
        if (withheld !== null)
          return yield* store.save({ ...delivery, state: "withheld", errorCode: withheld });
        const checkedAt = yield* DateTime.nowAsDate;
        if (
          delivery.state !== "failed" &&
          delivery.completionStartedAt !== null &&
          delivery.attempts >= (input.attemptLimit ?? Infinity) &&
          checkedAt.getTime() < delivery.completionStartedAt.getTime() + SHARE_OBSERVATION_MS &&
          checkedAt.getTime() < delivery.updatedAt.getTime() + SHARE_RECHECK_MS
        )
          return delivery;
        delivery = yield* store.startAttempt();
        const label = proofLabel(artifact, observedAt);
        const comment = escapeSlack(`${label}\n${artifact.caption}`);
        const postText = (purpose: "missing" | "failed", text: string) =>
          Effect.gen(function* () {
            if (delivery.messageTs !== null) return delivery.messageTs;
            const clientMessageId = replyId(thread.sessionId, artifact.id, purpose);
            if (delivery.replyStartedAt !== null) {
              const replies = yield* slack.conversationsReplies(token, {
                channel: thread.channelId,
                ts: thread.threadTs,
              });
              const existing = replies.find(
                (reply) =>
                  (reply.clientMessageId === clientMessageId ||
                    reply.blockIds?.includes(clientMessageId) === true) &&
                  reply.isBot,
              );
              if (existing !== undefined) return existing.ts;
            } else {
              delivery = yield* store.save({
                ...delivery,
                replyStartedAt: yield* DateTime.nowAsDate,
              });
            }
            const posted = yield* slack.postMessage(token, {
              channel: thread.channelId,
              threadTs: thread.threadTs,
              text,
              clientMessageId,
              blocks: [
                { type: "section", block_id: clientMessageId, text: { type: "mrkdwn", text } },
              ],
            });
            return posted.ts;
          });
        const visibilityReply = (checking: boolean) =>
          Effect.gen(function* () {
            const text = escapeSlack(
              `File visibility not confirmed · ${slackProofFilename(artifact)}\n${label}\nSlack accepted the upload; Mend has not observed it in this thread. ${
                checking
                  ? "Mend will check every five minutes for up to an hour after completion started."
                  : "Mend has stopped checking. The file may still appear in Slack."
              }`,
            );
            const messageTs = yield* postText("failed", text);
            if (!checking && delivery.messageTs !== null)
              yield* slack.update(token, { channel: thread.channelId, ts: messageTs, text });
            return yield* store.save({ ...delivery, messageTs });
          });
        const failureReply = () =>
          Effect.gen(function* () {
            if (delivery.errorCode === "share_not_observed") return yield* visibilityReply(false);
            const why =
              delivery.errorCode === "missing_scope"
                ? "The Slack app needs files:write. Add the scope and reinstall the app to the workspace."
                : delivery.errorCode === "media_not_found"
                  ? "The stored proof file is no longer available."
                  : delivery.errorCode === "media_unavailable"
                    ? "Mend could not read the stored proof file."
                    : `Slack answered ${delivery.errorCode ?? "unknown_error"}.`;
            const messageTs = yield* postText(
              "failed",
              escapeSlack(`File not delivered · ${slackProofFilename(artifact)}\n${label}\n${why}`),
            );
            return yield* store.save({ ...delivery, messageTs });
          });
        if (delivery.state === "failed") return yield* failureReply();
        if (artifact.capture._tag === "NotCaptured") {
          const messageTs = yield* postText("missing", comment);
          return yield* store.save({ ...delivery, state: "shared", messageTs });
        }

        const save = (progress: SlackProofDeliveryProgress) =>
          store.save(progress).pipe(
            Effect.tap((saved) =>
              Effect.sync(() => {
                delivery = saved;
              }),
            ),
          );
        const resetTicket = () =>
          save({
            ...delivery,
            slackFileId: null,
            uploadUrl: null,
            state: "reserved",
            completionStartedAt: null,
            errorCode: null,
          });
        const sharedTs = (fileId: string) =>
          slack.filesInfo(token, fileId, thread.channelId).pipe(
            Effect.map(
              (shares) => shares.find((share) => share.threadTs === thread.threadTs)?.ts ?? null,
            ),
            Effect.annotateLogs({ artifactId: artifact.id, threadTs: thread.threadTs }),
          );
        const markShared = (messageTs: string) =>
          Effect.gen(function* () {
            if (delivery.messageTs !== null)
              yield* slack
                .update(token, {
                  channel: thread.channelId,
                  ts: delivery.messageTs,
                  text: escapeSlack(
                    `File shown in thread · ${slackProofFilename(artifact)}\n${label}`,
                  ),
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("slack proof: visibility notice update failed").pipe(
                      Effect.annotateLogs({ artifactId: artifact.id, code: error.code }),
                    ),
                  ),
                );
            return yield* save({
              ...delivery,
              state: "shared",
              messageTs,
              uploadUrl: null,
              errorCode: null,
            });
          });
        const deliver = Effect.gen(function* () {
          if (delivery.slackFileId !== null) {
            const observed = yield* sharedTs(delivery.slackFileId).pipe(
              Effect.catchIf(
                (error) => error.code === "file_not_found",
                () => resetTicket().pipe(Effect.as(null)),
              ),
            );
            if (observed !== null) return yield* markShared(observed);
            // Completion may have succeeded remotely. Only observation can settle that uncertainty.
            if (delivery.completionStartedAt !== null) return yield* pending();
          }
          if (delivery.slackFileId === null) {
            const media = artifact.capture;
            if (media._tag !== "Screenshot" && media._tag !== "Video")
              return yield* Effect.die("proof media was not settled");
            const ticket = yield* slack.filesGetUploadUrl(token, {
              filename: slackProofFilename(artifact),
              length: media.media.bytes,
              ...(media._tag === "Screenshot"
                ? { altText: `${label}\n${artifact.caption}`.slice(0, 1000) }
                : {}),
            });
            yield* save({
              ...delivery,
              slackFileId: ticket.fileId,
              uploadUrl: ticket.uploadUrl,
              state: "reserved",
            });
          }
          if (delivery.state === "reserved") {
            if (delivery.uploadUrl === null)
              return yield* Effect.die("proof upload ticket has no URL");
            const media = yield* input.media(artifact);
            const capture = artifact.capture;
            if (
              (capture._tag === "Screenshot" || capture._tag === "Video") &&
              media.length !== capture.media.bytes
            ) {
              return yield* new SlackApiError({
                method: "proof.delivery",
                code: "invalid_length",
                message: "The stored proof file has a different length.",
              });
            }
            yield* slack
              .filesUpload(delivery.uploadUrl, media)
              .pipe(
                Effect.annotateLogs({ artifactId: artifact.id, slackFileId: delivery.slackFileId }),
              );
            yield* save({ ...delivery, state: "uploaded", errorCode: null });
          }
          const fileId = delivery.slackFileId;
          if (fileId === null) return yield* Effect.die("uploaded proof has no Slack file id");
          yield* save({ ...delivery, completionStartedAt: yield* DateTime.nowAsDate });
          yield* slack.filesCompleteUpload(token, {
            files: [{ id: fileId, title: artifact.title }],
            channelId: thread.channelId,
            threadTs: thread.threadTs,
            initialComment: comment,
          });
          yield* Effect.logInfo("slack proof: upload completion accepted").pipe(
            Effect.annotateLogs({
              artifactId: artifact.id,
              slackFileId: fileId,
              channelId: thread.channelId,
              threadTs: thread.threadTs,
            }),
          );
          const messageTs = yield* sharedTs(fileId);
          if (messageTs === null) return yield* pending();
          return yield* markShared(messageTs);
        });
        return yield* deliver.pipe(
          Effect.catchIf(
            (error): error is SlackApiError => error instanceof SlackApiError,
            (error) =>
              Effect.gen(function* () {
                if (
                  delivery.completionStartedAt !== null &&
                  (error.code === "share_not_observed" ||
                    error.method === "files.info" ||
                    (error.method === "files.completeUploadExternal" &&
                      error.code === "request_failed"))
                ) {
                  const now = yield* DateTime.nowAsDate;
                  const checking =
                    now.getTime() < delivery.completionStartedAt.getTime() + SHARE_OBSERVATION_MS;
                  yield* Effect.logInfo("slack proof: share not observed").pipe(
                    Effect.annotateLogs({
                      artifactId: artifact.id,
                      slackFileId: delivery.slackFileId,
                      channelId: thread.channelId,
                      threadTs: thread.threadTs,
                      attempts: delivery.attempts,
                      code: error.code,
                      checking,
                    }),
                  );
                  yield* save({
                    ...delivery,
                    state: checking ? "uploaded" : "failed",
                    errorCode: "share_not_observed",
                    uploadUrl: null,
                  });
                  if (!checking || delivery.attempts >= (input.attemptLimit ?? Infinity))
                    return yield* visibilityReply(checking);
                  return yield* error;
                }
                if (
                  delivery.attempts < (input.attemptLimit ?? Infinity) &&
                  (error.code === "file_not_found" ||
                    (error.method === "files.uploadBytes" &&
                      ["http_404", "http_410"].includes(error.code)))
                ) {
                  yield* resetTicket();
                  return yield* error;
                }
                if (
                  !FINAL_UPLOAD_ERRORS.has(error.code) &&
                  delivery.attempts < (input.attemptLimit ?? Infinity)
                ) {
                  yield* save({
                    ...delivery,
                    errorCode: error.code,
                    ...(error.method === "files.completeUploadExternal" &&
                    error.code === "ratelimited"
                      ? { completionStartedAt: null }
                      : {}),
                  });
                  return yield* error;
                }
                yield* save({
                  ...delivery,
                  state: "failed",
                  errorCode: error.code,
                  uploadUrl: null,
                });
                return yield* failureReply();
              }),
          ),
        );
      }),
  );
});
