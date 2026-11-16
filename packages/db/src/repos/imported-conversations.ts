import { PgClient } from "@effect/sql-pg";
import type { OrganizationId, ProjectId, SessionId } from "@mend/domain";
import type { ConversationArchiveFile, ImportedHarness } from "@mend/domain/workbench";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import {
  agentSessions,
  projects,
  sessionImportedConversationFiles,
  sessionImportedConversations,
} from "../schema/workbench.ts";
import {
  type BackfillTurnInput,
  landHistoryTurns,
  notifyAgentConversation,
} from "./agent-conversation.ts";

/** A conversation imported into one session, without its bytes. */
export interface ImportedConversation {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly ownerUserId: string;
  readonly harness: ImportedHarness;
  readonly nativeId: string;
  /** Where it ran on the person's machine. */
  readonly source: { readonly checkout: string; readonly home: string };
  readonly files: ReadonlyArray<ConversationArchiveFile>;
  readonly byteLength: number;
  readonly permissionMode: "bypass" | "ask" | null;
  /** When the session's first agent started over it; null while it waits for that launch. */
  readonly deliveredAt: Date | null;
}

export interface ImportedConversationFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export type SaveImportedConversation =
  | { readonly _tag: "Saved"; readonly turns: number }
  /** The same person already imported this native conversation into this project. */
  | { readonly _tag: "AlreadyImported"; readonly sessionId: SessionId }
  /** The session already holds another imported conversation. */
  | { readonly _tag: "SessionTaken" };

/**
 * Imported conversations (SLNT-895): the person's own native files for one session, kept sealed
 * until its first agent starts, and the turns they showed before any launch. Deleting the session,
 * its project or its owner deletes them; so does removing the owner from the organization.
 */
export class ImportedConversationsRepo extends Context.Service<
  ImportedConversationsRepo,
  {
    /** The session this person imported `nativeId` into in this project, if they did. */
    readonly sessionOf: (input: {
      readonly ownerUserId: string;
      readonly projectId: ProjectId;
      readonly harness: ImportedHarness;
      readonly nativeId: string;
    }) => Effect.Effect<SessionId | null>;
    readonly bySession: (sessionId: SessionId) => Effect.Effect<ImportedConversation | null>;
    /** The files' bytes, in arrival order. */
    readonly files: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<ImportedConversationFile>>;
    /**
     * Keep the conversation and land its turns as imported history, in one transaction: nothing is
     * kept when another import holds its native key or the session, which the answer names.
     */
    readonly save: (
      conversation: Omit<ImportedConversation, "deliveredAt">,
      bytes: ReadonlyArray<ImportedConversationFile>,
      turns: ReadonlyArray<BackfillTurnInput>,
    ) => Effect.Effect<SaveImportedConversation>;
    /** The session's first agent started over the delivered files; true when this call said so. */
    readonly markDelivered: (sessionId: SessionId) => Effect.Effect<boolean>;
  }
>()("@mend/db/ImportedConversationsRepo") {}

type Row = typeof sessionImportedConversations.$inferSelect;

const toConversation = (row: Row): ImportedConversation => ({
  sessionId: row.sessionId,
  projectId: row.projectId,
  ownerUserId: row.ownerUserId,
  harness: row.harness,
  nativeId: row.nativeId,
  source: { checkout: row.sourceCheckout, home: row.sourceHome },
  files: row.files,
  byteLength: row.byteLength,
  permissionMode: row.permissionMode,
  deliveredAt: row.deliveredAt,
});

/**
 * Member removal, inside its transaction: the imported conversations of the person's sessions in
 * the organization go with the rest of their private state. Turns already shown stay, as other
 * turns of their sessions do.
 */
export const deleteImportedConversationsOf = Effect.fn(
  "ImportedConversationsRepo.deleteImportedConversationsOf",
)(function* (
  tx: Pick<MendDatabase, "delete" | "select">,
  userId: string,
  organizationId: OrganizationId,
) {
  const inOrganization = tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, organizationId));
  yield* tx
    .delete(sessionImportedConversations)
    .where(
      and(
        eq(sessionImportedConversations.ownerUserId, userId),
        inArray(sessionImportedConversations.projectId, inOrganization),
      ),
    );
});

export const ImportedConversationsRepoLive: Layer.Layer<
  ImportedConversationsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ImportedConversationsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const sessionOf = Effect.fn("ImportedConversationsRepo.sessionOf")(function* (input: {
      readonly ownerUserId: string;
      readonly projectId: ProjectId;
      readonly harness: ImportedHarness;
      readonly nativeId: string;
    }) {
      const [row] = yield* db
        .select({ sessionId: sessionImportedConversations.sessionId })
        .from(sessionImportedConversations)
        .where(
          and(
            eq(sessionImportedConversations.ownerUserId, input.ownerUserId),
            eq(sessionImportedConversations.projectId, input.projectId),
            eq(sessionImportedConversations.harness, input.harness),
            eq(sessionImportedConversations.nativeId, input.nativeId),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row?.sessionId ?? null;
    });

    const bySession = Effect.fn("ImportedConversationsRepo.bySession")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select()
        .from(sessionImportedConversations)
        .where(eq(sessionImportedConversations.sessionId, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toConversation(row);
    });

    const files = Effect.fn("ImportedConversationsRepo.files")(function* (sessionId: SessionId) {
      const conversation = yield* bySession(sessionId);
      if (conversation === null) return [];
      const rows = yield* db
        .select({
          relativePath: sessionImportedConversationFiles.relativePath,
          content: sessionImportedConversationFiles.content,
        })
        .from(sessionImportedConversationFiles)
        .where(eq(sessionImportedConversationFiles.sessionId, sessionId))
        .orderBy(asc(sessionImportedConversationFiles.relativePath))
        .pipe(Effect.orDie);
      const byPath = new Map(rows.map((row) => [row.relativePath, row.content]));
      return conversation.files.flatMap((file) => {
        const content = byPath.get(file.relativePath);
        return content === undefined
          ? []
          : [
              {
                relativePath: file.relativePath,
                bytes: new Uint8Array(content),
              },
            ];
      });
    });

    const save = Effect.fn("ImportedConversationsRepo.save")(function* (
      conversation: Omit<ImportedConversation, "deliveredAt">,
      bytes: ReadonlyArray<ImportedConversationFile>,
      turns: ReadonlyArray<BackfillTurnInput>,
    ) {
      const outcome = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // One import per session and per native key at a time: the session's row is the lock.
            yield* tx
              .select({ id: agentSessions.id })
              .from(agentSessions)
              .where(eq(agentSessions.id, conversation.sessionId))
              .for("update");
            const [held] = yield* tx
              .select({ nativeId: sessionImportedConversations.nativeId })
              .from(sessionImportedConversations)
              .where(eq(sessionImportedConversations.sessionId, conversation.sessionId));
            if (held !== undefined) return { _tag: "SessionTaken" } as const;
            const [inserted] = yield* tx
              .insert(sessionImportedConversations)
              .values({
                sessionId: conversation.sessionId,
                projectId: conversation.projectId,
                ownerUserId: conversation.ownerUserId,
                harness: conversation.harness,
                nativeId: conversation.nativeId,
                sourceCheckout: conversation.source.checkout,
                sourceHome: conversation.source.home,
                files: conversation.files,
                byteLength: conversation.byteLength,
                permissionMode: conversation.permissionMode,
              })
              .onConflictDoNothing({
                target: [
                  sessionImportedConversations.ownerUserId,
                  sessionImportedConversations.projectId,
                  sessionImportedConversations.harness,
                  sessionImportedConversations.nativeId,
                ],
              })
              .returning({ sessionId: sessionImportedConversations.sessionId });
            if (inserted === undefined) {
              const [earlier] = yield* tx
                .select({ sessionId: sessionImportedConversations.sessionId })
                .from(sessionImportedConversations)
                .where(
                  and(
                    eq(sessionImportedConversations.ownerUserId, conversation.ownerUserId),
                    eq(sessionImportedConversations.projectId, conversation.projectId),
                    eq(sessionImportedConversations.harness, conversation.harness),
                    eq(sessionImportedConversations.nativeId, conversation.nativeId),
                  ),
                );
              if (earlier === undefined) return yield* Effect.die("imported conversation vanished");
              return {
                _tag: "AlreadyImported",
                sessionId: earlier.sessionId,
              } as const;
            }
            for (const file of bytes)
              yield* tx.insert(sessionImportedConversationFiles).values({
                sessionId: conversation.sessionId,
                relativePath: file.relativePath,
                content: Buffer.from(
                  file.bytes.buffer,
                  file.bytes.byteOffset,
                  file.bytes.byteLength,
                ),
              });
            const landed = yield* landHistoryTurns(
              tx,
              conversation.sessionId,
              { imported: true },
              turns,
            );
            return { _tag: "Saved", turns: landed } as const;
          }),
        )
        .pipe(Effect.orDie);
      if (outcome._tag === "Saved" && outcome.turns > 0)
        yield* notifyAgentConversation(db, pg, conversation.sessionId);
      return outcome;
    });

    const markDelivered = Effect.fn("ImportedConversationsRepo.markDelivered")(function* (
      sessionId: SessionId,
    ) {
      const now = yield* DateTime.nowAsDate;
      const rows = yield* db
        .update(sessionImportedConversations)
        .set({ deliveredAt: now })
        .where(
          and(
            eq(sessionImportedConversations.sessionId, sessionId),
            isNull(sessionImportedConversations.deliveredAt),
          ),
        )
        .returning({ sessionId: sessionImportedConversations.sessionId })
        .pipe(Effect.orDie);
      return rows.length === 1;
    });

    return ImportedConversationsRepo.of({
      sessionOf,
      bySession,
      files,
      save,
      markDelivered,
    });
  }),
);
