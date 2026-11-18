import type { PreviewId, WorktreeId } from "@mend/domain";
import { makePreviewPoll, type PreviewStatus } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import type { WorktreePreviewsDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * A worktree's previews (ADR 0017): each one's status facts, where it opens, which Service it is
 * bound to, and the site Mend frames previews on. Read again while a preview starts, and no more
 * once it settles (`makePreviewPoll`): each worktree polls on its own.
 */
export const useWorktreePreviews = (worktreeId: WorktreeId) => {
  const trpc = useTRPC();
  const [poll] = useState(makePreviewPoll);
  return useQuery(
    trpc.worktrees.previews.queryOptions(
      { id: worktreeId },
      { refetchInterval: (query) => poll(worktreeId, query.state.data, Date.now()) },
    ),
  );
};

export interface ServicePreview {
  readonly id: PreviewId;
  readonly serviceName: string;
  readonly facts: ReadonlyArray<PreviewStatus>;
  readonly open: string | null;
  readonly inSiblingSession: boolean;
}

export interface PlacedPreviews {
  readonly byService: ReadonlyMap<string, ServicePreview>;
  readonly byName: ReadonlyMap<string, ServicePreview>;
  readonly unplaced: ReadonlyArray<ServicePreview>;
}

export const placePreviews = (
  read: WorktreePreviewsDto,
  sessionId: string,
  rows: { readonly serviceIds: ReadonlySet<string>; readonly names: ReadonlySet<string> },
): PlacedPreviews => {
  const byService = new Map<string, ServicePreview>();
  const byName = new Map<string, ServicePreview>();
  const unplaced: Array<ServicePreview> = [];
  for (const { preview, facts, open, boundTo } of read.previews) {
    const shown: ServicePreview = {
      id: preview.id,
      serviceName: preview.serviceName,
      facts,
      open,
      inSiblingSession: boundTo !== null && boundTo.sessionId !== sessionId,
    };
    if (boundTo !== null) {
      if (!shown.inSiblingSession && rows.serviceIds.has(boundTo.serviceId)) {
        byService.set(boundTo.serviceId, shown);
      } else {
        unplaced.push(shown);
      }
    } else if (rows.names.has(preview.serviceName)) {
      byName.set(preview.serviceName, shown);
    } else if (facts.length > 0) {
      unplaced.push(shown);
    }
  }
  return { byService, byName, unplaced };
};

export type RowOpen =
  | { readonly _tag: "Link"; readonly href: string }
  | { readonly _tag: "Waiting"; readonly why: string }
  | null;

export type PreviewsRead =
  | { readonly _tag: "Unknown"; readonly why: string }
  | { readonly _tag: "Read"; readonly placed: PlacedPreviews };

export const rowOpen = (
  previews: PreviewsRead,
  preview: ServicePreview | null,
  direct: string | null,
): RowOpen => {
  if (previews._tag === "Unknown") {
    return direct === null ? null : { _tag: "Waiting", why: previews.why };
  }
  const href = preview?.open ?? direct;
  return href === null ? null : { _tag: "Link", href };
};

/**
 * Why a live Service's row offers no Open link, in words the row shows; null when it offers one,
 * or when the row already says why (a stopped Service, a tunnel command).
 */
export const whyNoOpen = (row: {
  readonly live: boolean;
  readonly open: RowOpen;
  readonly reach: "direct" | "tunnel" | "none";
  readonly browserUrl: string | null;
  /** What Mend last observed of the current forward, if anything. */
  readonly observed: string | null;
}): string | null => {
  if (!row.live || row.open !== null || row.reach === "tunnel") return null;
  if (row.reach === "none") return "It speaks UDP only, so no browser opens it.";
  if (row.browserUrl === null)
    return 'It is not declared a web page, so Mend offers no browser link. A recipe with browserScheme = "http" (or "https") in .mend/mend.toml makes it one.';
  return row.observed === null
    ? "Mend has not reached its port yet. Open shows once a connection to it succeeds."
    : `Mend last observed it ${row.observed}. Open shows once a connection to it succeeds.`;
};

/**
 * A path typed into the bar, opened in the preview. A preview on its own origin takes the path
 * on that origin. A preview Mend serves is opened through Mend's own `/preview-auth?…&path=`
 * link, which is relative: the path goes in its `path` query, and the link stays relative.
 */
export const joinPath = (base: string, path: string): string => {
  const clean =
    path.trim() === "" ? "/" : path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
  if (base.startsWith("/")) {
    const link = new URL(base, "http://mend.invalid");
    link.searchParams.set("path", clean);
    return `${link.pathname}${link.search}`;
  }
  return new URL(clean, new URL(base).origin).toString();
};

/** Where this page is, as far as framing a preview goes; null while rendering on the server. */
export interface PageAt {
  readonly protocol: string;
  readonly hostname: string;
}

/** How the view shows the app: in a frame, or as a link with the one reason it cannot show here. */
export type PreviewShowing =
  | { readonly _tag: "Frame" }
  | { readonly _tag: "Link"; readonly why: "own-address" | "another-site" };

/**
 * Mend's app frames only a preview Mend serves (a relative `/preview-auth` link) on the site the
 * server says previews share with Mend (`frameSite`, docs/adr/0017, decision log 15), from a page
 * on that site over https. Anywhere else the frame could not stay signed in, so the view offers
 * the link instead of a frame that fails. On the server the page is taken to be at `APP_URL`.
 */
export const previewShowing = (
  base: string,
  frameSite: string | null,
  page: PageAt | null,
): PreviewShowing => {
  if (!base.startsWith("/")) return { _tag: "Link", why: "own-address" };
  if (frameSite === null) return { _tag: "Link", why: "another-site" };
  if (page === null) return { _tag: "Frame" };
  const onSite = page.hostname === frameSite || page.hostname.endsWith(`.${frameSite}`);
  return page.protocol === "https:" && onSite
    ? { _tag: "Frame" }
    : { _tag: "Link", why: "another-site" };
};

const noSubscription = () => () => {};
const pageAt = (): string => `${window.location.protocol}//${window.location.hostname}`;
const serverPage = () => null;

/** This page's scheme and host; null on the server. Neither changes while the page is open. */
export const usePageAt = (): PageAt | null => {
  const at = useSyncExternalStore(noSubscription, pageAt, serverPage);
  if (at === null) return null;
  const url = new URL(at);
  return { protocol: url.protocol, hostname: url.hostname };
};
