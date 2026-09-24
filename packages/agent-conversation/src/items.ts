import type { AgentItemDto } from "./feed.ts";

/** Items read per page of `GET /api/sessions/:id/items`. */
export const ITEM_PAGE_SIZE = 500;

/** The cursor went backwards or stood still: the server's pages would repeat forever. */
export class AgentItemCursorStalled extends Error {
  constructor(readonly after: number) {
    super("The server returned malformed agent item cursor data.");
  }
}

/**
 * Read every item update after `initialAfter`, a page at a time, until a short page. Items are
 * keyed by id, so an item that grew between pages is held once, at its latest.
 */
export const readAgentItemsAfter = async <I extends AgentItemDto>(
  readPage: (after: number, limit: number) => Promise<ReadonlyArray<I>>,
  initialAfter: number,
  pageSize: number = ITEM_PAGE_SIZE,
): Promise<ReadonlyArray<I>> => {
  const items = new Map<string, I>();
  let after = initialAfter;
  for (;;) {
    const page = await readPage(after, pageSize);
    for (const item of page) {
      items.set(item.id, item);
    }
    if (page.length < pageSize) {
      return [...items.values()];
    }
    const next = page.reduce((latest, item) => Math.max(latest, item.seq), after);
    if (next <= after) {
      throw new AgentItemCursorStalled(after);
    }
    after = next;
  }
};
