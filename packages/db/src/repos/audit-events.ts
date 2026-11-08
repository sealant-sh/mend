import { AuditEventId, type OrganizationId } from "@mend/domain";
import {
  AUDIT_PAGE_MAX,
  AuditEvent,
  type AuditAction,
  type AuditData,
} from "@mend/domain/workbench";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { auditEvents, deviceTokens } from "../schema/workbench.ts";

/**
 * The access key the running request was made with (docs/adr/0023-access-keys.md, "Audit"): the
 * API's auth middleware provides it for a `key:` caller, and every audit row written under it
 * names the key. Null outside such a request.
 */
export const CurrentAccessKey = Context.Reference<string | null>("@mend/db/CurrentAccessKey", {
  defaultValue: () => null,
});

export interface NewAuditEvent {
  readonly organizationId: OrganizationId;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly data?: AuditData;
}

/**
 * The organization audit log (docs/adr/0003-organizations-and-tenancy.md). Recorded after the
 * change it describes succeeds; a failed write is logged and never undoes the change.
 */
export class AuditEventsRepo extends Context.Service<
  AuditEventsRepo,
  {
    readonly record: (event: NewAuditEvent) => Effect.Effect<void>;
    /**
     * Newest first. `beforeId` is the last event of the previous page: the next page starts
     * strictly after it in (time, id) order, so events sharing an instant are never skipped.
     */
    readonly listForOrganization: (
      organizationId: OrganizationId,
      page: { readonly beforeId: string | null; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<AuditEvent>>;
    /**
     * Whether `action` was recorded on `subjectId` for `actorUserId` with `data[field]` equal to
     * `value`: a bundle tip the change's endpoint served this person, say.
     */
    readonly recorded: (query: AuditLookup) => Effect.Effect<boolean>;
    /** The newest `action` recorded on `subjectId` in the organization, or null. */
    readonly latest: (query: {
      readonly organizationId: OrganizationId;
      readonly action: AuditAction;
      readonly subjectId: string;
    }) => Effect.Effect<AuditEvent | null>;
  }
>()("@mend/db/AuditEventsRepo") {}

export interface AuditLookup {
  readonly organizationId: OrganizationId;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly subjectId: string;
  readonly field: string;
  readonly value: string;
}

const decodeEvent = Schema.decodeUnknownSync(AuditEvent);

const selectedEvent = {
  id: auditEvents.id,
  organizationId: auditEvents.organizationId,
  actorUserId: auditEvents.actorUserId,
  action: auditEvents.action,
  subjectType: auditEvents.subjectType,
  subjectId: auditEvents.subjectId,
  data: auditEvents.data,
  createdAt: auditEvents.createdAt,
  accessKeyId: deviceTokens.id,
  accessKeyName: deviceTokens.name,
};

const eventOf = ({
  accessKeyId,
  accessKeyName,
  ...event
}: {
  readonly accessKeyId: string | null;
  readonly accessKeyName: string | null;
}) =>
  decodeEvent({
    ...event,
    accessKey:
      accessKeyId === null || accessKeyName === null
        ? null
        : { id: accessKeyId, name: accessKeyName },
  });

export const AuditEventsRepoLive: Layer.Layer<AuditEventsRepo, never, MendDB> = Layer.effect(
  AuditEventsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const record = Effect.fn("AuditEventsRepo.record")(function* (event: NewAuditEvent) {
      yield* db
        .insert(auditEvents)
        .values({
          id: AuditEventId.make(crypto.randomUUID()),
          organizationId: event.organizationId,
          actorUserId: event.actorUserId,
          action: event.action,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          data: event.data ?? {},
          accessKeyId: yield* CurrentAccessKey,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("audit: event not recorded").pipe(
              Effect.annotateLogs({ action: event.action, cause: String(cause) }),
            ),
          ),
        );
    });

    const listForOrganization = Effect.fn("AuditEventsRepo.listForOrganization")(function* (
      organizationId: OrganizationId,
      page: { readonly beforeId: string | null; readonly limit: number },
    ) {
      // Compared in the database against the cursor row's stored time, at full precision.
      const afterCursor =
        page.beforeId === null
          ? undefined
          : sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (
              SELECT cursor.created_at, cursor.id FROM audit_events cursor
              WHERE cursor.id = ${page.beforeId} AND cursor.organization_id = ${organizationId}
            )`;
      const rows = yield* db
        .select(selectedEvent)
        .from(auditEvents)
        .leftJoin(deviceTokens, eq(deviceTokens.id, auditEvents.accessKeyId))
        .where(and(eq(auditEvents.organizationId, organizationId), afterCursor))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(Math.min(Math.max(1, page.limit), AUDIT_PAGE_MAX))
        .pipe(Effect.orDie);
      return rows.map(eventOf);
    });

    const recorded = Effect.fn("AuditEventsRepo.recorded")(function* (query: AuditLookup) {
      // The organization first, so the lookup walks that organization's index.
      const rows = yield* db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, query.organizationId),
            eq(auditEvents.action, query.action),
            eq(auditEvents.subjectId, query.subjectId),
            eq(auditEvents.actorUserId, query.actorUserId),
            sql`${auditEvents.data} ->> ${query.field} = ${query.value}`,
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return rows.length > 0;
    });

    const latest = Effect.fn("AuditEventsRepo.latest")(function* (query: {
      readonly organizationId: OrganizationId;
      readonly action: AuditAction;
      readonly subjectId: string;
    }) {
      const [row] = yield* db
        .select(selectedEvent)
        .from(auditEvents)
        .leftJoin(deviceTokens, eq(deviceTokens.id, auditEvents.accessKeyId))
        .where(
          and(
            eq(auditEvents.organizationId, query.organizationId),
            eq(auditEvents.action, query.action),
            eq(auditEvents.subjectId, query.subjectId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : eventOf(row);
    });

    return { record, listForOrganization, recorded, latest };
  }),
);
