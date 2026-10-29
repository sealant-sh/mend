import { isMendPageTool, mendPageReferenceIn } from "@mend/agent-protocol";
import type { PageRef } from "@mend/domain/workbench";

import type { CanonicalEvent } from "./native-convert.ts";

export interface TranscriptPage {
  readonly kind: "page";
  readonly page: PageRef;
}

export type TranscriptEntry = CanonicalEvent | TranscriptPage;

const pageCalledBy = (
  event: CanonicalEvent,
  pages: ReadonlyMap<string, PageRef>,
): PageRef | undefined => {
  if (event.kind !== "tool" || !isMendPageTool({ name: event.name, namespace: null })) {
    return undefined;
  }
  const id = mendPageReferenceIn(event.output);
  return id === null ? undefined : pages.get(id);
};

export const withPages = (
  events: ReadonlyArray<CanonicalEvent>,
  pages: ReadonlyArray<PageRef>,
): ReadonlyArray<TranscriptEntry> => {
  const unplaced = new Map<string, PageRef>(pages.map((page) => [page.id, page]));
  const entries: Array<TranscriptEntry> = [];
  for (const event of events) {
    const page = pageCalledBy(event, unplaced);
    if (page === undefined) {
      entries.push(event);
      continue;
    }
    unplaced.delete(page.id);
    entries.push({ kind: "page", page });
  }
  for (const page of unplaced.values()) entries.push({ kind: "page", page });
  return entries;
};
