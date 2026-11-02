import {
  isMendPageTool,
  mendPageReferenceIn,
  mendScreenToolOf,
  mendProofToolOf,
  proofToolTextIn,
  screenToolTextIn,
  storedScreenArguments,
} from "@mend/agent-protocol";
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

/** A screen call shows its tool's text, never its frame, and its arguments as Mend stores them. */
const withoutScreenPayload = (event: CanonicalEvent): CanonicalEvent => {
  if (event.kind !== "tool") return event;
  if (mendProofToolOf({ name: event.name, namespace: null }) !== null) {
    const text = proofToolTextIn(event.output);
    return { ...event, output: text === null ? "" : JSON.stringify(text) };
  }
  const tool = mendScreenToolOf({ name: event.name, namespace: null });
  if (tool === null) return event;
  const args = storedScreenArguments(tool, event.args);
  const text = screenToolTextIn(event.output);
  return {
    ...event,
    args: args === null ? "" : JSON.stringify(args),
    argsFormat: "json",
    output: text === null ? "" : JSON.stringify(text),
  };
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
      entries.push(withoutScreenPayload(event));
      continue;
    }
    unplaced.delete(page.id);
    entries.push({ kind: "page", page });
  }
  for (const page of unplaced.values()) entries.push({ kind: "page", page });
  return entries;
};
