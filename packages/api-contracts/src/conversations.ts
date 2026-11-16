import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  CONVERSATION_ARCHIVE_CONTENT_TYPE,
  ImportedHarness,
  ImportedNativeId,
  Session,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, BudgetExceeded } from "./common.ts";
import { RemovalInProgress, StoreFailure } from "./workbench-views.ts";

export const CONVERSATION_IMPORT_REFUSALS = [
  /** The body is not a conversation archive, or a file's bytes differ from its digest. */
  "damaged",
  /** A path is not one of the harness's conversation files, or it appears twice. */
  "path-not-allowed",
  "path-duplicated",
  /** The files hold no transcript named by the conversation id, or more than one. */
  "transcript-missing",
  /** The transcript is not valid for its harness, or names another conversation. */
  "transcript-invalid",
  /** The conversation's paths cannot be rewritten for a Mend workspace. */
  "not-rewritable",
  /** The session runs another harness than the conversation's. */
  "harness-mismatch",
  /** An agent was already started in the session; its conversation is its own. */
  "session-launched",
  /** The session already holds another imported conversation. */
  "session-holds-another",
  /** The session or worktree is not in this project, or the request names neither or both. */
  "wrong-target",
] as const;

/** The server will not take this conversation; `message` says why, in words a person can act on. */
export class ConversationImportRefused extends Schema.TaggedError<ConversationImportRefused>()(
  "ConversationImportRefused",
  {
    reason: Schema.Literals(CONVERSATION_IMPORT_REFUSALS),
    message: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

/**
 * Where the conversation lands: `session`, one the caller owns that never started an agent (the
 * one a handoff just made), or `worktree`, where a new session of the caller's is made for it.
 * Exactly one.
 */
export const ConversationImportQuery = {
  session: Schema.optionalKey(SessionId),
  worktree: Schema.optionalKey(WorktreeId),
};

/** A conversation archive (`encodeConversationArchive` in `@mend/domain/workbench`). */
export const ConversationArchiveBytes = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({
    contentType: CONVERSATION_ARCHIVE_CONTENT_TYPE,
  }),
);

export class ConversationImported extends Schema.Class<ConversationImported>(
  "ConversationImported",
)({
  /** The session holding the conversation, its history already shown. */
  session: Session,
  /** The same person imported the same native conversation into this project before. */
  replayed: Schema.Boolean,
  /** Turns of history the conversation showed. */
  turns: Schema.Int,
}) {}

/** The session an earlier import of the same native conversation made, or null. */
export class ConversationImportLookup extends Schema.Class<ConversationImportLookup>(
  "ConversationImportLookup",
)({
  session: Schema.NullOr(Session),
}) {}

export const conversationsGroup = HttpApiGroup.make("conversations")
  .add(
    HttpApiEndpoint.get("lookup", "/projects/:id/conversations", {
      params: { id: ProjectId },
      query: { harness: ImportedHarness, nativeId: ImportedNativeId },
      success: ConversationImportLookup,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/projects/:id/conversations", {
      params: { id: ProjectId },
      query: ConversationImportQuery,
      payload: ConversationArchiveBytes,
      success: ConversationImported,
      error: [NotFound, ConversationImportRefused, BudgetExceeded, StoreFailure, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
