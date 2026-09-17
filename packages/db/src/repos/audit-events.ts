import { AuditEventId, type OrganizationId } from "@mend/domain";
import {
  AUDIT_PAGE_MAX,
  AuditEvent,
  type AuditAction,
  type AuditData,
} from "@mend/domain/workbench";
import { and, desc, eq, lt } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { auditEvents } from "../schema/workbench.ts";

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
    /** Newest first; `before` pages back from an event's time. */
    readonly listForOrganization: (
      organizationId: OrganizationId,
      page: { readonly before: Date | null; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<AuditEvent>>;
  }
>()("@mend/db/AuditEventsRepo") {}

const decodeEvent = Schema.decodeUnknownSync(AuditEvent);

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
      page: { readonly before: Date | null; readonly limit: number },
    ) {
      const rows = yield* db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, organizationId),
            page.before === null ? undefined : lt(auditEvents.createdAt, page.before),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(Math.min(Math.max(1, page.limit), AUDIT_PAGE_MAX))
        .pipe(Effect.orDie);
      return rows.map((row) => decodeEvent(row));
    });

    return { record, listForOrganization };
  }),
);
