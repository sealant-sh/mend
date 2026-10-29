import {
  AgentItemId,
  type AgentTurnId,
  PageId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  MEND_PAGE_CALL_FIELD,
  MendPageCall,
  PageRef,
  pageItemProviderId,
} from "@mend/domain/workbench";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { MendDatabase } from "../client.ts";
import { agentItems, sessionPages } from "../schema/workbench.ts";

type Tx = Pick<MendDatabase, "select">;

const encodePageRef = Schema.encodeSync(PageRef);

export const pageRefOf = (row: Pick<typeof sessionPages.$inferSelect, keyof PageRef>): PageRef =>
  new PageRef({
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    height: row.height,
    publishedAt: row.publishedAt,
  });

export const PAGE_REF_COLUMNS = {
  id: sessionPages.id,
  sessionId: sessionPages.sessionId,
  title: sessionPages.title,
  height: sessionPages.height,
  publishedAt: sessionPages.publishedAt,
};

export const pageItemRow = (
  page: PageRef,
  at: {
    readonly processId: SessionProcessId;
    readonly turnId: AgentTurnId;
    readonly seq: number;
    readonly eventIndex: number;
  },
): typeof agentItems.$inferInsert => ({
  id: AgentItemId.make(crypto.randomUUID()),
  sessionId: page.sessionId,
  processId: at.processId,
  turnId: at.turnId,
  seq: at.seq,
  providerItemId: pageItemProviderId(page.id),
  providerOutputProcessId: at.processId,
  providerOutputSeq: 0n,
  providerEventIndex: at.eventIndex,
  kind: "page",
  status: "completed",
  title: page.title,
  text: null,
  data: encodePageRef(page),
});

export const pagesWithoutItems = Effect.fn("SessionPagesRepo.pagesWithoutItems")(function* (
  tx: Tx,
  sessionId: SessionId,
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return new Map<string, PageRef>();
  const pages = yield* tx
    .select(PAGE_REF_COLUMNS)
    .from(sessionPages)
    .where(
      and(
        eq(sessionPages.sessionId, sessionId),
        inArray(
          sessionPages.id,
          ids.map((id) => PageId.make(id)),
        ),
      ),
    );
  if (pages.length === 0) return new Map<string, PageRef>();
  const shown = yield* tx
    .select({ providerItemId: agentItems.providerItemId })
    .from(agentItems)
    .where(
      and(
        eq(agentItems.sessionId, sessionId),
        inArray(
          agentItems.providerItemId,
          pages.map((page) => pageItemProviderId(page.id)),
        ),
      ),
    );
  const present = new Set(shown.map((row) => row.providerItemId));
  return new Map(
    pages
      .filter((page) => !present.has(pageItemProviderId(page.id)))
      .map((page) => [page.id, pageRefOf(page)]),
  );
});

const isMarker = Schema.is(MendPageCall);

export const publishedPageIdOf = (data: unknown): string | null => {
  if (typeof data !== "object" || data === null || !(MEND_PAGE_CALL_FIELD in data)) return null;
  const marker: unknown = Reflect.get(data, MEND_PAGE_CALL_FIELD);
  return isMarker(marker) ? marker.attachmentId : null;
};
