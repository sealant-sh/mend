import type { PreviewId, WorktreeId } from "@mend/domain";
import { makePreviewPoll, type PreviewStatus } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { WorktreePreviewsDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

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
