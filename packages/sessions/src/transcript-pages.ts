import { isMendPageTool, mendPageReferenceIn } from "@mend/agent-protocol";
import type { PageRef } from "@mend/domain/workbench";

import type { CanonicalEvent } from "./native-convert.ts";

export interface TranscriptPage {
  readonly kind: "page";
  readonly page: PageRef;
}

export type TranscriptEntry = CanonicalEvent | TranscriptPage;

export const withPages = (
  events: ReadonlyArray<CanonicalEvent>,
  pages: ReadonlyArray<PageRef>,
): ReadonlyArray<TranscriptEntry> => {
  const unplaced = new Map<string, PageRef>(pages.map((page) => [page.id, page]));
  const entries: Array<TranscriptEntry> = [];
  for (const event of events) {
    entries.push(event);
    if (event.kind !== "tool" || !isMendPageTool({ name: event.name, namespace: null })) continue;
    const id = mendPageReferenceIn(event.output);
    const page = id === null ? undefined : unplaced.get(id);
    if (page === undefined) continue;
    unplaced.delete(page.id);
    entries.push({ kind: "page", page });
  }
  for (const page of unplaced.values()) entries.push({ kind: "page", page });
  return entries;
};
