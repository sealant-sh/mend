import type { MendConnection } from "../config.js";
import { requestMend } from "../mend-http.js";
import {
  parseComment,
  parseComments,
  parseContents,
  parseOpenedReview,
  parseRangeDiff,
  parseReadPass,
  parseSliceDiff,
  parseTranscript,
  parseWorktreeChain,
  type FileContents,
  type PinnedSlice,
  type ReadPass,
  type ServerComment,
  type SliceDiff,
  type TranscriptEntry,
  type WorktreeChain,
} from "./review-wire.js";

const segment = encodeURIComponent;

/** The review's reads and writes on Mend, each answer parsed into the review's types. */
export class ReviewClient {
  constructor(private readonly connection: () => Promise<MendConnection>) {}

  private async get(path: string): Promise<unknown> {
    return requestMend(await this.connection(), path);
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    return requestMend(await this.connection(), path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Pins a slice, base to a checkpoint taken now; the same key answers the same slice. */
  async openReview(changeId: string, idempotencyKey: string): Promise<PinnedSlice> {
    return parseOpenedReview(
      await this.post(`/changes/${segment(changeId)}/reviews/open`, { idempotencyKey }),
    );
  }

  async sliceDiff(changeId: string, sliceId: string): Promise<SliceDiff> {
    return parseSliceDiff(
      await this.get(`/changes/${segment(changeId)}/reviews/${segment(sliceId)}/diff`),
    );
  }

  async rangeDiff(worktreeId: string, from: string, to: string): Promise<SliceDiff> {
    const query = new URLSearchParams({ from, to });
    return parseRangeDiff(await this.get(`/worktrees/${segment(worktreeId)}/diff?${query}`));
  }

  async chain(worktreeId: string): Promise<WorktreeChain> {
    return parseWorktreeChain(await this.get(`/worktrees/${segment(worktreeId)}`));
  }

  async contents(worktreeId: string, path: string, at: string): Promise<FileContents> {
    const query = new URLSearchParams({ path, at });
    return parseContents(await this.get(`/worktrees/${segment(worktreeId)}/contents?${query}`));
  }

  /** Every comment on the change, of every state and every slice. */
  async comments(changeId: string): Promise<ReadonlyArray<ServerComment>> {
    return parseComments(await this.get(`/changes/${segment(changeId)}/comments`));
  }

  async setCommentState(
    changeId: string,
    commentId: string,
    state: "open" | "addressed" | "dismissed",
  ): Promise<ServerComment> {
    return parseComment(
      await this.post(`/changes/${segment(changeId)}/comments/${segment(commentId)}/state`, {
        state,
      }),
    );
  }

  /** Mend reads the change: queued at once; its drafts arrive as comments when it ends. */
  async readChange(changeId: string): Promise<void> {
    await this.post(`/changes/${segment(changeId)}/read`, {});
  }

  async readPass(changeId: string): Promise<ReadPass | null> {
    return parseReadPass(await this.get(`/changes/${segment(changeId)}/passes`));
  }

  async transcript(sessionId: string): Promise<ReadonlyArray<TranscriptEntry>> {
    return parseTranscript(await this.get(`/sessions/${segment(sessionId)}/transcript`));
  }
}
