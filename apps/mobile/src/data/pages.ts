import {
  isShownAsPage,
  itemFailed,
  mendPageCallOf,
  type AgentConversationEntry,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTurnDto,
} from "@mend/agent-conversation";
import { PAGE_FRAME_MIN_URL_LIFE_MS, PAGE_FRAME_TTL_MS, PageRef } from "@mend/domain/workbench";
import { Option, Schema } from "effect";

const decodePage = Schema.decodeUnknownOption(PageRef);

export const pageOf = (value: unknown): PageRef | null => Option.getOrNull(decodePage(value));

export const pagesOf = (value: unknown): ReadonlyArray<PageRef> =>
  Array.isArray(value) ? value.flatMap((entry) => pageOf(entry) ?? []) : [];

export const pageOfItem = (item: AgentItemDto): PageRef | null =>
  item.kind === "page" ? pageOf(item.data) : null;

const shownAsPage = (item: AgentItemDto): boolean =>
  isShownAsPage(item) && !itemFailed(item) && mendPageCallOf(item)?.failure == null;

export const withPagesInPlace = <
  T extends AgentTurnDto,
  I extends AgentItemDto,
  R extends AgentRequestDto,
>(
  entries: ReadonlyArray<AgentConversationEntry<T, I, R>>,
): ReadonlyArray<AgentConversationEntry<T, I, R>> =>
  entries.filter((entry) => entry.kind !== "item" || !shownAsPage(entry.item));

export const pageCallFailureOf = (item: AgentItemDto): string | null => {
  const failure = mendPageCallOf(item)?.failure;
  return failure == null ? null : `page not shown · ${failure.message}`;
};

export interface PageConnection {
  readonly url: string;
  readonly token: string;
}

export const pageFrameKey = (pageId: string) => ["page-frame", pageId] as const;

export const pageFrameQuery = (pageId: string, mint: () => Promise<string>) => ({
  queryKey: pageFrameKey(pageId),
  queryFn: mint,
  staleTime: PAGE_FRAME_TTL_MS - PAGE_FRAME_MIN_URL_LIFE_MS,
});

const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: ":80", https: ":443" };

// Scheme and host in lower case, a default port dropped: the URL as WebKit and Chromium report it.
const canonical = (url: string): string =>
  url.replace(
    /^([a-z][a-z0-9+.-]*):\/\/([^/?#@]*@)?([^/?#]*)/i,
    (_, scheme: string, user = "", host: string) => {
      const lower = scheme.toLowerCase();
      const port = DEFAULT_PORTS[lower];
      const bare = host.toLowerCase();
      return `${lower}://${user}${port !== undefined && bare.endsWith(port) ? bare.slice(0, -port.length) : bare}`;
    },
  );

export const resolvePageUrl = (serverUrl: string, url: string): string | null => {
  if (/^https?:\/\//i.test(url)) return canonical(url);
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  return canonical(`${serverUrl.replace(/\/+$/, "")}${url}`);
};

export const PAGE_OFFLINE_RETRY_MS = 5_000;

export const transcriptPageOf = (event: {
  readonly kind: string;
  readonly page?: unknown;
}): PageRef | null => (event.kind === "page" ? pageOf(event.page) : null);

export const pageKey = (sessionId: string, pageId: string) =>
  ["session", sessionId, "page", pageId] as const;

export const pageRouteParams = (page: PageRef) => ({ id: page.id, session: page.sessionId });

export const pageRouteOf = (params: {
  readonly id?: string | ReadonlyArray<string>;
  readonly session?: string | ReadonlyArray<string>;
}): { readonly id: string; readonly sessionId: string } | null =>
  typeof params.id === "string" && typeof params.session === "string"
    ? { id: params.id, sessionId: params.session }
    : null;
