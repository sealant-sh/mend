import { makePreviewPoll } from "@mend/domain/workbench";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePairing } from "@/data/pairing-scope";
import {
  openPreviewIn,
  type ProjectPreviewDto,
  type PreviewBrowser,
  type PreviewOpenFailure,
  previewOpenFailureLine,
  type PreviewOpeningDto,
  type PreviewToOpen,
  type ReservePreviewBrowser,
  type WorktreePreviewsDto,
} from "@/data/previews";

const IDLE_REFRESH_MS = 10_000;

export const useWorktreePreviews = (worktreeId: string | null) => {
  const { machine } = usePairing();
  const [poll] = useState(makePreviewPoll);
  return useQuery({
    queryKey: ["worktree", worktreeId, "previews"],
    enabled: worktreeId !== null,
    queryFn: () => machine.read<WorktreePreviewsDto>(`/worktrees/${worktreeId}/previews`),
    refetchInterval: (query) => {
      const starting = poll(worktreeId ?? "", query.state.data, Date.now());
      return starting === false ? IDLE_REFRESH_MS : starting;
    },
    retry: false,
  });
};

/** A phone observes the shared address; target changes stay on CLI and web. */
export const useProjectPreview = (projectId: string | null) => {
  const { machine } = usePairing();
  return useQuery({
    queryKey: ["project", projectId, "preview"],
    enabled: projectId !== null,
    queryFn: () =>
      machine.read<ProjectPreviewDto>(`/projects/${encodeURIComponent(projectId ?? "")}/preview`),
    refetchInterval: IDLE_REFRESH_MS,
    retry: false,
  });
};

const openStateOf = (preview: PreviewToOpen | null) =>
  preview === null ? null : `${preview.id}\n${preview.open}`;

export const usePreviewOpen = (
  preview: PreviewToOpen | null,
  reserveBrowser: ReservePreviewBrowser,
): {
  readonly open: () => void;
  readonly pending: boolean;
  readonly failure: string | null;
} => {
  const { machine } = usePairing();
  const [failure, setFailure] = useState<PreviewOpenFailure | null>(null);
  const [failedIn, setFailedIn] = useState(openStateOf(preview));
  if (failedIn !== openStateOf(preview)) {
    setFailedIn(openStateOf(preview));
    setFailure(null);
  }
  const opening = useMutation({
    mutationFn: (input: { readonly id: string; readonly browser: PreviewBrowser }) =>
      openPreviewIn(
        input.browser,
        () =>
          machine.write<PreviewOpeningDto>(
            "POST",
            `/previews/${encodeURIComponent(input.id)}/open`,
          ),
        (reason) => setFailure({ _tag: "BrowserFailed", reason }),
      ),
    onError: (error) => setFailure({ _tag: "Refused", message: error.message }),
  });
  return {
    open: () => {
      if (preview === null) return;
      setFailure(null);
      opening.mutate({ id: preview.id, browser: reserveBrowser() });
    },
    pending: opening.isPending,
    failure: failure === null ? null : previewOpenFailureLine(failure),
  };
};
