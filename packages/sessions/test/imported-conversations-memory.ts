import {
  type ImportedConversation,
  type ImportedConversationFile,
  ImportedConversationsRepo,
} from "@mend/db";
import type { SessionId } from "@mend/domain";
import { Effect, Layer } from "effect";

/**
 * Imported conversations as the database keeps them, in memory: one per session and per native
 * key. A test seeds `rows` and reads them back, a delivery's mark included.
 */
export const makeImportedConversationsMemory = () => {
  const rows = new Map<
    SessionId,
    { row: ImportedConversation; readonly bytes: ReadonlyArray<ImportedConversationFile> }
  >();
  const layer: Layer.Layer<ImportedConversationsRepo> = Layer.succeed(
    ImportedConversationsRepo,
    ImportedConversationsRepo.of({
      sessionOf: (input) =>
        Effect.sync(
          () =>
            [...rows.values()].find(
              ({ row }) =>
                row.ownerUserId === input.ownerUserId &&
                row.projectId === input.projectId &&
                row.harness === input.harness &&
                row.nativeId === input.nativeId,
            )?.row.sessionId ?? null,
        ),
      bySession: (sessionId) => Effect.sync(() => rows.get(sessionId)?.row ?? null),
      undeliveredAmong: (sessionIds) =>
        Effect.sync(
          () => new Set(sessionIds.filter((id) => rows.get(id)?.row.deliveredAt === null)),
        ),
      files: (sessionId) => Effect.sync(() => rows.get(sessionId)?.bytes ?? []),
      save: (conversation, bytes) =>
        Effect.sync(() => {
          if (rows.has(conversation.sessionId)) return { _tag: "SessionTaken" as const };
          rows.set(conversation.sessionId, { row: { ...conversation, deliveredAt: null }, bytes });
          return { _tag: "Saved" as const, turns: 0 };
        }),
      markDelivered: (sessionId) =>
        Effect.sync(() => {
          const held = rows.get(sessionId);
          if (held === undefined || held.row.deliveredAt !== null) return false;
          held.row = { ...held.row, deliveredAt: new Date() };
          return true;
        }),
    }),
  );
  return { rows, layer };
};
