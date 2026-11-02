import { createHash } from "node:crypto";

import {
  ProofArtifactsRepo,
  PullRequestProofUploadsRepo,
  type ProofArtifactStorageError,
  type PullRequestProofStorageError,
} from "@mend/db";
import type { ChangeId } from "@mend/domain";
import {
  describeProofMedia,
  mergeDescription,
  proofKindOf,
  proofLabel,
  proofMarker,
  type PullRequestMediaItem,
  type PullRequestMediaReport,
} from "@mend/domain/workbench";
import { BlobStore } from "@mend/store";
import { Effect, Result } from "effect";

import {
  appendBinaryFileArgv,
  createDirectoryArgv,
  editArgv,
  parsePullRequest,
  removeDirectoryArgv,
  viewArgv,
  writeFileArgv,
} from "./gh.ts";
import type { GitHubRepository } from "./github.ts";
import type {
  PullRequestStepError,
  PullRequestWorkspace,
  PullRequestWorkspaceTarget,
} from "./pull-requests.ts";

/** The published PR already exists; attachment failures never undo the landing. */
export interface AttachProofInput {
  readonly changeId: ChangeId;
  readonly repository: GitHubRepository;
  readonly target: PullRequestWorkspaceTarget;
  readonly number: number;
  readonly section: string;
  readonly checkpointOrdinal: number | null;
}

const MEDIA_START = "<!-- mend:captures:start -->";
const MEDIA_END = "<!-- mend:captures:end -->";

/** Replace just the capture block when attaching after the main publish step. */
const sectionWithProof = (
  section: string,
  items: ReadonlyArray<PullRequestMediaItem>,
  ordinal: number | null,
  unavailable?: string,
): string => {
  const start = section.indexOf(MEDIA_START);
  const end = section.indexOf(MEDIA_END, start);
  const block = `${MEDIA_START}\n${describeProofMedia(items, ordinal)}${unavailable === undefined ? "" : `\nmedia unavailable · ${unavailable}\n`}\n${MEDIA_END}`;
  if (start !== -1 && end !== -1)
    return `${section.slice(0, start)}${block}${section.slice(end + MEDIA_END.length)}`;
  return section.replace("## In Mend", `${block}\n\n## In Mend`);
};

/** Only GitHub-native asset URLs without credentials or query strings are reusable. */
const uploadedProofUrl = (body: string, artifactId: string): string | null => {
  const marker = proofMarker(artifactId);
  const start = body.indexOf(marker);
  if (start === -1) return null;
  const block = body.slice(start + marker.length).split(/<!-- mend:|\n## /, 1)[0] ?? "";
  return (
    block.match(
      /^(?:!\[[^\r\n]*\]\()?(https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+)(?:\))?$/m,
    )?.[1] ?? null
  );
};

const shortReason = (output: {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number;
}): string => {
  const words = `${output.stderr}\n${output.stdout}`;
  if (/422/.test(words)) return "GitHub refused the upload (HTTP 422)";
  if (/ghs_|installation token/i.test(words))
    return "GitHub installation tokens cannot upload attachments";
  if (/403|permission|write access/i.test(words)) return "GitHub requires repository write access";
  if (/401|auth|login/i.test(words)) return "GitHub authentication unavailable";
  return `GitHub attachment command failed (exit ${output.exitCode})`;
};

interface ProofAttachments {
  readonly proofItems: (
    changeId: ChangeId,
    repository: GitHubRepository,
  ) => Effect.Effect<
    ReadonlyArray<PullRequestMediaItem>,
    ProofArtifactStorageError | PullRequestProofStorageError
  >;
  readonly attachProof: (
    workspace: PullRequestWorkspace,
    input: AttachProofInput,
  ) => Effect.Effect<PullRequestMediaReport>;
}

/** One owner for blob staging, GitHub rewrites, upload reuse and cleanup. */
export const makeProofAttachments: Effect.Effect<
  ProofAttachments,
  never,
  ProofArtifactsRepo | PullRequestProofUploadsRepo | BlobStore
> = Effect.gen(function* () {
  const artifacts = yield* ProofArtifactsRepo;
  const uploads = yield* PullRequestProofUploadsRepo;
  const blobs = yield* BlobStore;

  const proofItems = Effect.fn("PullRequests.proofItems")(function* (
    changeId: ChangeId,
    repository: GitHubRepository,
  ) {
    const stored = yield* artifacts.listForChange(changeId);
    const delivered = yield* uploads.listForChange(changeId, repository.slug);
    return stored.map((artifact): PullRequestMediaItem => {
      const url = delivered.find((row) => row.artifactId === artifact.id)?.url;
      const capture = artifact.capture;
      return {
        artifactId: artifact.id,
        createdAt: artifact.createdAt.toISOString(),
        kind: proofKindOf(capture),
        label: proofLabel(artifact, (at) => `${at.toISOString().slice(11, 16)} UTC`),
        checkpointOrdinal: artifact.source._tag === "Checkpoint" ? artifact.source.ordinal : null,
        ref:
          url !== undefined &&
          uploadedProofUrl(`${proofMarker(artifact.id)}\n${url}`, artifact.id) !== null
            ? { url }
            : {
                missing:
                  capture._tag === "NotCaptured"
                    ? capture.reason
                    : capture._tag === "Recording"
                      ? "recording in progress"
                      : "upload pending",
              },
      };
    });
  });

  const attachProof = (
    workspace: PullRequestWorkspace,
    input: AttachProofInput,
  ): Effect.Effect<PullRequestMediaReport> =>
    Effect.gen(function* () {
      const initial = yield* proofItems(input.changeId, input.repository).pipe(Effect.result);
      if (Result.isFailure(initial))
        return {
          delivered: 0,
          reused: 0,
          failed: [],
          unavailable: "proof capture metadata unavailable",
        };
      let items = initial.success.toSorted(
        (a, b) => Number(a.kind === "video") - Number(b.kind === "video"),
      );
      if (items.length === 0) return { delivered: 0, reused: 0, failed: [] };
      let delivered = 0;
      let reused = items.filter((item) => "url" in item.ref).length;
      let unavailable: string | undefined;
      const failPending = (reason: string) => {
        items = items.map((item) =>
          "path" in item.ref || ("missing" in item.ref && item.ref.missing === "upload pending")
            ? { ...item, ref: { missing: reason } }
            : item,
        );
      };
      const run = (): Effect.Effect<void, PullRequestStepError> =>
        Effect.gen(function* () {
          const pending = items.some(
            (item) => "missing" in item.ref && item.ref.missing === "upload pending",
          );
          if (pending && !workspace.supportsAttachments) {
            unavailable = "gh has no --attach";
            failPending(unavailable);
          }
          const current = yield* workspace.exec(viewArgv(input.repository, input.number));
          const pr = current.exitCode === 0 ? parsePullRequest(current.stdout) : null;
          if (pr === null) {
            unavailable = "pull request body could not be read";
            failPending(unavailable);
            return;
          }
          const directory = `/tmp/mend-pull-request-${crypto.randomUUID()}`;
          const created = yield* workspace.exec(createDirectoryArgv(directory));
          if (created.exitCode !== 0) {
            unavailable = "media staging unavailable";
            failPending(unavailable);
            return;
          }
          yield* Effect.acquireUseRelease(
            Effect.succeed(directory),
            () =>
              Effect.gen(function* () {
                const bodyFile = `${directory}/body.md`;
                let body = pr.body;
                const edit = (attachments: ReadonlyArray<string>) =>
                  Effect.gen(function* () {
                    const section = sectionWithProof(
                      input.section,
                      items,
                      input.checkpointOrdinal,
                      unavailable,
                    );
                    const written = yield* workspace.exec(
                      writeFileArgv(bodyFile, mergeDescription(body, section)),
                    );
                    if (written.exitCode !== 0) return written;
                    return yield* workspace.exec(
                      editArgv({
                        repository: input.repository,
                        number: input.number,
                        title: null,
                        bodyFile,
                        attachments,
                      }),
                    );
                  });
                const stored = yield* artifacts.listForChange(input.changeId);
                for (let offset = 0; offset < items.length; offset += 50) {
                  const batch = items.slice(offset, offset + 50);
                  const paths: Array<string> = [];
                  for (const item of batch) {
                    if (!("missing" in item.ref) || item.ref.missing !== "upload pending") continue;
                    const recovered = uploadedProofUrl(body, item.artifactId);
                    if (recovered !== null) {
                      yield* uploads.record({
                        artifactId: item.artifactId,
                        repository: input.repository.slug,
                        url: recovered,
                        pullRequest: input.number,
                        uploadedBy: input.target.ownerUserId,
                      });
                      items = items.map((entry) =>
                        entry.artifactId === item.artifactId
                          ? { ...entry, ref: { url: recovered } }
                          : entry,
                      );
                      reused++;
                      continue;
                    }
                    const artifact = stored.find((entry) => entry.id === item.artifactId);
                    const capture = artifact?.capture;
                    if (
                      capture === undefined ||
                      (capture._tag !== "Screenshot" && capture._tag !== "Video")
                    )
                      continue;
                    const media = capture.media;
                    const bytes = yield* blobs.get(media.blobKey).pipe(Effect.result);
                    let reason: string | null = null;
                    if (Result.isFailure(bytes)) reason = "stored media unavailable";
                    else if (
                      bytes.success.length !== media.bytes ||
                      createHash("sha256").update(bytes.success).digest("hex") !== media.sha256
                    )
                      reason = "stored media checksum differs";
                    else if (media.bytes > (capture._tag === "Screenshot" ? 10 : 100) * 1024 * 1024)
                      reason = "media exceeds GitHub's size limit";
                    const file = `${directory}/${item.artifactId.replace(/[^a-zA-Z0-9_-]/g, "")}.${capture._tag === "Screenshot" ? "png" : "mp4"}`;
                    if (reason === null && Result.isSuccess(bytes)) {
                      for (let start = 0; start < bytes.success.length; start += 750_000) {
                        const written = yield* workspace.exec(
                          appendBinaryFileArgv(
                            file,
                            bytes.success.subarray(start, start + 750_000),
                          ),
                        );
                        if (written.exitCode !== 0) {
                          reason = "media staging failed";
                          break;
                        }
                      }
                      if (reason === null) {
                        const checked = yield* workspace.exec(["sha256sum", "--", file]);
                        if (
                          checked.exitCode !== 0 ||
                          checked.stdout.split(/\s/)[0] !== media.sha256
                        )
                          reason = "staged media checksum differs";
                      }
                    }
                    items = items.map((entry) =>
                      entry.artifactId === item.artifactId
                        ? { ...entry, ref: reason === null ? { path: file } : { missing: reason } }
                        : entry,
                    );
                    if (reason === null) paths.push(file);
                  }
                  if (paths.length === 0) continue;
                  const edited = yield* edit(paths).pipe(Effect.result);
                  const observed = yield* workspace
                    .exec(viewArgv(input.repository, input.number))
                    .pipe(Effect.result);
                  const answer =
                    Result.isSuccess(observed) && observed.success.exitCode === 0
                      ? parsePullRequest(observed.success.stdout)
                      : null;
                  if (answer !== null) body = answer.body;
                  const reason = Result.isFailure(edited)
                    ? "attachment command unavailable"
                    : edited.success.exitCode === 0
                      ? "GitHub returned no attachment URL"
                      : shortReason(edited.success);
                  for (const item of items.filter((entry) => "path" in entry.ref)) {
                    const url =
                      answer === null ? null : uploadedProofUrl(answer.body, item.artifactId);
                    items = items.map((entry) =>
                      entry.artifactId === item.artifactId
                        ? { ...entry, ref: url === null ? { missing: reason } : { url } }
                        : entry,
                    );
                    if (url !== null) {
                      delivered++;
                      yield* uploads
                        .record({
                          artifactId: item.artifactId,
                          repository: input.repository.slug,
                          url,
                          pullRequest: input.number,
                          uploadedBy: input.target.ownerUserId,
                        })
                        .pipe(Effect.ignore);
                    }
                  }
                }
                // gh can publish a partial body with local paths even when its edit fails.
                const cleaned = yield* edit([]);
                if (cleaned.exitCode !== 0) unavailable = "capture body cleanup failed";
              }).pipe(
                Effect.catch(() => {
                  failPending("media delivery unavailable");
                  items = items.map((item) =>
                    "path" in item.ref
                      ? { ...item, ref: { missing: "media delivery unavailable" } }
                      : item,
                  );
                  return workspace
                    .exec(
                      writeFileArgv(
                        `${directory}/body.md`,
                        mergeDescription(
                          pr.body,
                          sectionWithProof(
                            input.section,
                            items,
                            input.checkpointOrdinal,
                            unavailable,
                          ),
                        ),
                      ),
                    )
                    .pipe(
                      Effect.flatMap(() =>
                        workspace.exec(
                          editArgv({
                            repository: input.repository,
                            number: input.number,
                            title: null,
                            bodyFile: `${directory}/body.md`,
                          }),
                        ),
                      ),
                      Effect.tap((result) =>
                        Effect.sync(() => {
                          if (result.exitCode !== 0) unavailable = "capture body cleanup failed";
                        }),
                      ),
                      Effect.asVoid,
                    );
                }),
              ),
            () => workspace.exec(removeDirectoryArgv(directory)).pipe(Effect.ignore),
          );
        });
      const attempted = yield* run().pipe(Effect.result);
      if (Result.isFailure(attempted)) {
        unavailable = "media workspace unavailable";
        failPending(unavailable);
      }
      return {
        delivered,
        reused,
        failed: items.flatMap((item) =>
          "missing" in item.ref ? [{ artifactId: item.artifactId, reason: item.ref.missing }] : [],
        ),
        ...(unavailable === undefined ? {} : { unavailable }),
      };
    });
  return { proofItems, attachProof };
});
