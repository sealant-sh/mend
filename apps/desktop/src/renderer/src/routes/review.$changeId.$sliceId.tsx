import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ReviewDiff } from "#/components/review-diff";
import { Titlebar } from "#/components/titlebar";
import {
  deliverFollowUp,
  isUnauthorized,
  openReview,
  postSliceReviewComment,
  setReviewCommentState,
  type ReviewCommentDto,
  type ReviewDiffFileDto,
  type SliceCommentTargetDto,
} from "#/lib/api";
import { useWorkbenchEvents } from "#/lib/events";
import {
  processOutputQuery,
  queryClient,
  reviewCommentsQuery,
  reviewDiffQuery,
  sessionDetailQuery,
  sessionProcessesQuery,
} from "#/lib/queries";
import {
  assembleReviewInstruction,
  changeCommentTarget,
  commentLocation,
  commentsForComparison,
  commentsForFile,
  fileCommentTarget,
  queueReplayCursor,
  refreshReviewOpenKey,
  reviewFilePath,
  reviewFileStatus,
  terminalEvidenceExcerpt,
} from "#/lib/review";

export const Route = createFileRoute("/review/$changeId/$sliceId")({
  component: ReviewRoute,
});

type Composer = {
  readonly target: SliceCommentTargetDto;
  readonly label: string;
};

const short = (value: string): string => value.slice(0, 8);

const subscribeCompact = (listener: () => void): (() => void) => {
  const media = window.matchMedia("(max-width: 1023px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};

const useCompactReview = (): boolean =>
  useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia("(max-width: 1023px)").matches,
    () => false,
  );

function ReviewRoute() {
  const params = Route.useParams();
  return <ReviewPage key={params.sliceId} {...params} />;
}

function ReviewPage({
  changeId,
  sliceId,
}: {
  readonly changeId: string;
  readonly sliceId: string;
}) {
  useWorkbenchEvents();
  const navigate = useNavigate();
  const compact = useCompactReview();
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [whitespace, setWhitespace] = useState<"include" | "ignore">("include");
  const [context, setContext] = useState(3);
  const [search, setSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activeHunk, setActiveHunk] = useState(0);
  const [commentCursor, setCommentCursor] = useState(-1);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [selectedComments, setSelectedComments] = useState<ReadonlySet<string>>(new Set());
  const [instruction, setInstruction] = useState("");
  const [refreshKey, setRefreshKey] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const diff = useQuery(reviewDiffQuery(changeId, sliceId, { whitespace, context }));
  const comments = useQuery(reviewCommentsQuery(changeId));
  const sessionId = diff.data?.change.sessionId ?? "";
  // Delivering a follow-up steers the session (docs/adr/0003): the owner's unless shared.
  const sessionControl = useQuery({ ...sessionDetailQuery(sessionId), enabled: sessionId !== "" });
  const processes = useQuery({
    ...sessionProcessesQuery(sessionId),
    enabled: sessionId !== "",
  });
  const checkpointRunId = diff.data?.checkpointB.sealantRunId ?? null;
  const evidenceProcessId =
    checkpointRunId === null
      ? ""
      : ((processes.data ?? []).find((process) => process.sealantRunId === checkpointRunId)?.id ??
        "");
  const recordOutput = useQuery({
    ...processOutputQuery(evidenceProcessId),
    enabled: evidenceProcessId !== "",
  });

  const files = diff.data?.files ?? [];
  const visibleFiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return files;
    return files.filter(
      (file) =>
        reviewFilePath(file).toLowerCase().includes(needle) ||
        file.patch.toLowerCase().includes(needle),
    );
  }, [files, search]);
  const navigationFiles = search.trim() === "" ? files : visibleFiles;
  const selectedFile =
    navigationFiles.find((file) => reviewFilePath(file) === selectedPath) ??
    navigationFiles[0] ??
    null;
  const canonicalFile =
    selectedFile === null
      ? null
      : (diff.data?.anchorFiles.find(
          (file) => reviewFilePath(file) === reviewFilePath(selectedFile),
        ) ?? null);
  const currentPath = selectedFile === null ? null : reviewFilePath(selectedFile);
  const currentHunk =
    selectedFile === null ? 0 : Math.min(activeHunk, Math.max(0, selectedFile.hunks.length - 1));
  const sliceComments = commentsForComparison(
    comments.data ?? [],
    diff.data?.slice.diffDigest ?? null,
  );
  const openComments = sliceComments.filter((comment) => comment.state === "open");
  const currentComments = commentsForFile(sliceComments, currentPath);
  const agentProcess =
    checkpointRunId === null
      ? undefined
      : (processes.data ?? []).find((process) => process.sealantRunId === checkpointRunId);

  const chooseFile = (file: ReviewDiffFileDto) => {
    setSelectedPath(reviewFilePath(file));
    setActiveHunk(0);
    setFilesOpen(false);
  };
  const moveFile = (delta: number) => {
    if (navigationFiles.length === 0) return;
    const index = navigationFiles.findIndex((file) => reviewFilePath(file) === currentPath);
    const next =
      navigationFiles[
        (Math.max(index, 0) + delta + navigationFiles.length) % navigationFiles.length
      ];
    if (next !== undefined) chooseFile(next);
  };
  const moveHunk = (delta: number) => {
    if (selectedFile === null || selectedFile.hunks.length === 0) return;
    setActiveHunk((currentHunk + delta + selectedFile.hunks.length) % selectedFile.hunks.length);
  };
  const moveComment = (delta: number) => {
    if (openComments.length === 0) return;
    const current =
      commentCursor < 0 ? (delta > 0 ? -1 : 0) : Math.min(commentCursor, openComments.length - 1);
    const next = (current + delta + openComments.length) % openComments.length;
    const target = openComments[next];
    if (target === undefined) return;
    setCommentCursor(next);
    const path = target.anchor?.newPath ?? target.anchor?.oldPath ?? target.file;
    const file = files.find((candidate) => reviewFilePath(candidate) === path);
    if (file !== undefined) {
      chooseFile(file);
      const line = target.anchor?.startLine ?? target.line;
      const side = target.anchor?.side ?? "new";
      const hunk =
        line === null
          ? -1
          : file.hunks.findIndex((candidate) => {
              const start = side === "old" ? candidate.oldStart : candidate.newStart;
              const count = side === "old" ? candidate.oldLines : candidate.newLines;
              return count > 0 && line >= start && line <= start + count - 1;
            });
      if (hunk >= 0) setActiveHunk(hunk);
    }
    setInspectorOpen(true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          searchRef.current?.focus();
        }
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        moveFile(1);
      } else if (event.key === "[") {
        event.preventDefault();
        moveFile(-1);
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        moveHunk(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        moveHunk(-1);
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        moveComment(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const refresh = useMutation({
    mutationFn: (idempotencyKey: string) => openReview(changeId, idempotencyKey),
    onSuccess: (opened) => {
      setRefreshKey(null);
      return navigate({
        to: "/review/$changeId/$sliceId",
        params: { changeId, sliceId: opened.slice.id },
        replace: true,
      });
    },
  });

  const unauthorized =
    isUnauthorized(diff.error) ||
    isUnauthorized(comments.error) ||
    isUnauthorized(processes.error) ||
    isUnauthorized(recordOutput.error);
  if (unauthorized) return <Navigate to="/connect" search={{ reason: "unauthorized" }} />;

  return (
    <>
      <Titlebar liveCount={null} />
      <div className="flex min-h-0 flex-1 flex-col bg-canvas">
        <header className="shrink-0 border-b border-rule bg-background px-4 py-3">
          <div className="flex items-start gap-4">
            <button
              type="button"
              className="mt-0.5 font-sans text-[12.5px] text-label hover:text-foreground"
              onClick={() => navigate({ to: "/" })}
            >
              ← Workbench
            </button>
            <div className="min-w-0 flex-1">
              <p className="ev-eyebrow">Pinned Review</p>
              <div className="mt-1 flex min-w-0 items-baseline gap-3">
                <h1 className="truncate font-display text-[21px] font-semibold tracking-tight">
                  {diff.data?.change.branch ?? "Reading the change…"}
                </h1>
                {diff.data !== undefined && (
                  <span className="truncate font-mono text-[11px] text-label">
                    {short(diff.data.checkpointA.sha)} → {short(diff.data.checkpointB.sha)} ·{" "}
                    {short(diff.data.slice.diffDigest)}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={refresh.isPending || diff.data === undefined}
              className="rounded-lg border border-rule bg-panel px-3 py-1.5 font-sans text-xs font-medium shadow-xs hover:-translate-y-px hover:shadow-sm disabled:opacity-40"
              onClick={() => {
                const key = refreshKey ?? refreshReviewOpenKey(changeId);
                setRefreshKey(key);
                refresh.mutate(key);
              }}
            >
              {refresh.isPending
                ? "Creating snapshot…"
                : refresh.isError
                  ? "Retry new snapshot"
                  : "New snapshot"}
            </button>
          </div>
          {diff.data?.worktreeChangedSinceSnapshot === true && (
            <p className="mt-3 border-l-2 border-warning pl-3 font-sans text-[12.5px] text-warning">
              Worktree changed since this Review snapshot. The pinned patch below has not moved.
            </p>
          )}
          {(diff.isError || comments.isError || refresh.isError) && (
            <p className="mt-3 border-l-2 border-danger pl-3 font-sans text-[12.5px] text-danger">
              {diff.error instanceof Error
                ? diff.error.message
                : comments.error instanceof Error
                  ? comments.error.message
                  : refresh.error instanceof Error
                    ? refresh.error.message
                    : "Review could not be read."}
            </p>
          )}
        </header>

        <ReviewToolbar
          style={compact ? "unified" : style}
          whitespace={whitespace}
          context={context}
          search={search}
          searchRef={searchRef}
          fileIndex={navigationFiles.findIndex((file) => reviewFilePath(file) === currentPath)}
          fileCount={navigationFiles.length}
          hunkIndex={currentHunk}
          hunkCount={selectedFile?.hunks.length ?? 0}
          openCommentCount={openComments.length}
          compact={compact}
          onStyle={setStyle}
          onWhitespace={setWhitespace}
          onContext={setContext}
          onSearch={setSearch}
          onPrevFile={() => moveFile(-1)}
          onNextFile={() => moveFile(1)}
          onPrevHunk={() => moveHunk(-1)}
          onNextHunk={() => moveHunk(1)}
          onPrevComment={() => moveComment(-1)}
          onNextComment={() => moveComment(1)}
          onFiles={() => setFilesOpen((value) => !value)}
          onInspector={() => setInspectorOpen((value) => !value)}
        />

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <FileNavigator
            files={visibleFiles}
            comments={sliceComments}
            selectedPath={currentPath}
            open={filesOpen}
            onChoose={chooseFile}
            onClose={() => setFilesOpen(false)}
          />

          <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            {selectedFile === null || canonicalFile === null ? (
              <div className="grid h-full place-items-center p-8 text-center">
                <div>
                  <p className="font-display text-xl font-semibold">
                    {diff.isPending ? "Reading the pinned patch…" : "No matching files"}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {diff.isPending
                      ? "Review remains tied to its checkpoint pair while Mend reads it."
                      : "Clear the search or create a new snapshot after the worktree changes."}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex h-9 shrink-0 items-center gap-3 border-b border-rule bg-panel px-3">
                  <span className="truncate font-mono text-xs text-foreground">
                    {reviewFilePath(selectedFile)}
                  </span>
                  <span className="font-sans text-[11.5px] text-label">
                    {reviewFileStatus(selectedFile)}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px]">
                    <span className="text-success">+{selectedFile.additions}</span>{" "}
                    <span className="text-danger">−{selectedFile.deletions}</span>
                  </span>
                  <button
                    type="button"
                    className="font-sans text-[11.5px] text-label hover:text-foreground"
                    onClick={() => {
                      setComposer({
                        target: fileCommentTarget(canonicalFile),
                        label: reviewFilePath(selectedFile),
                      });
                      setInspectorOpen(true);
                    }}
                  >
                    Comment on file
                  </button>
                </div>
                <ReviewDiff
                  file={selectedFile}
                  anchorFile={canonicalFile}
                  comments={sliceComments}
                  style={compact ? "unified" : style}
                  activeHunk={currentHunk}
                  onCompose={(target, label) => {
                    setComposer({ target, label });
                    setInspectorOpen(true);
                  }}
                />
              </>
            )}
          </main>

          <ReviewInspector
            open={inspectorOpen}
            changeId={changeId}
            sliceId={sliceId}
            sessionId={sessionId}
            steer={sessionControl.data?.control.steer ?? false}
            file={selectedFile}
            comments={currentComments}
            openComments={openComments}
            checkpointA={diff.data?.checkpointA ?? null}
            checkpointB={diff.data?.checkpointB ?? null}
            diffDigest={diff.data?.slice.diffDigest ?? null}
            processLabel={agentProcess?.label ?? null}
            recordExcerpt={terminalEvidenceExcerpt(recordOutput.data?.text ?? "")}
            composer={composer}
            selectedComments={selectedComments}
            instruction={instruction}
            onClose={() => setInspectorOpen(false)}
            onComposer={setComposer}
            onSelectComments={setSelectedComments}
            onInstruction={setInstruction}
            onCommentChange={() =>
              queryClient.invalidateQueries({ queryKey: ["change", changeId, "comments"] })
            }
            onChangeComment={() => {
              setComposer({ target: changeCommentTarget, label: "Whole change" });
              setInspectorOpen(true);
            }}
            onOpenEvidence={(sequence) => {
              queueReplayCursor(sessionId, sequence);
              void navigate({ to: "/" });
            }}
          />
        </div>
      </div>
    </>
  );
}

function ReviewToolbar({
  style,
  whitespace,
  context,
  search,
  searchRef,
  fileIndex,
  fileCount,
  hunkIndex,
  hunkCount,
  openCommentCount,
  compact,
  onStyle,
  onWhitespace,
  onContext,
  onSearch,
  onPrevFile,
  onNextFile,
  onPrevHunk,
  onNextHunk,
  onPrevComment,
  onNextComment,
  onFiles,
  onInspector,
}: {
  readonly style: "unified" | "split";
  readonly whitespace: "include" | "ignore";
  readonly context: number;
  readonly search: string;
  readonly searchRef: React.RefObject<HTMLInputElement | null>;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly hunkIndex: number;
  readonly hunkCount: number;
  readonly openCommentCount: number;
  readonly compact: boolean;
  readonly onStyle: (value: "unified" | "split") => void;
  readonly onWhitespace: (value: "include" | "ignore") => void;
  readonly onContext: (value: number) => void;
  readonly onSearch: (value: string) => void;
  readonly onPrevFile: () => void;
  readonly onNextFile: () => void;
  readonly onPrevHunk: () => void;
  readonly onNextHunk: () => void;
  readonly onPrevComment: () => void;
  readonly onNextComment: () => void;
  readonly onFiles: () => void;
  readonly onInspector: () => void;
}) {
  const control =
    "h-7 shrink-0 whitespace-nowrap border border-rule bg-panel px-2 font-sans text-[11.5px] text-ink-2 hover:bg-sunken disabled:opacity-40";
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-rule bg-sunken px-3">
      <button type="button" className={`${control} min-[1024px]:hidden`} onClick={onFiles}>
        Files
      </button>
      <div className="flex">
        <button
          type="button"
          className={`${control} rounded-l-lg ${style === "unified" ? "bg-wash text-info" : ""}`}
          onClick={() => onStyle("unified")}
        >
          Unified
        </button>
        <button
          type="button"
          className={`${control} -ml-px rounded-r-lg ${style === "split" ? "bg-wash text-info" : ""}`}
          disabled={compact}
          title={compact ? "Split view needs a wider window" : "Side-by-side diff"}
          onClick={() => onStyle("split")}
        >
          Split
        </button>
      </div>
      <button
        type="button"
        className={`${control} rounded-lg ${whitespace === "ignore" ? "bg-wash text-info" : ""}`}
        onClick={() => onWhitespace(whitespace === "include" ? "ignore" : "include")}
      >
        {whitespace === "include" ? "Whitespace included" : "Whitespace ignored"}
      </button>
      <label className="flex items-center gap-1 font-sans text-[11.5px] text-label">
        Context
        <select
          value={context}
          className="h-7 rounded-lg border border-rule bg-panel px-1.5 font-mono text-[11px] text-foreground"
          onChange={(event) => onContext(Number(event.target.value))}
        >
          <option value={3}>3</option>
          <option value={10}>10</option>
          <option value={25}>25</option>
        </select>
      </label>
      <div className="mx-1 h-5 w-px bg-rule" />
      <button
        type="button"
        className={`${control} rounded-l-lg`}
        disabled={fileCount === 0}
        onClick={onPrevFile}
        title="Previous file ([)"
      >
        ← file
      </button>
      <button
        type="button"
        className={`${control} -ml-2 rounded-r-lg`}
        disabled={fileCount === 0}
        onClick={onNextFile}
        title="Next file (])"
      >
        file →
      </button>
      <span className="font-mono text-[10.5px] text-label">
        {fileCount === 0 ? "0/0" : `${Math.max(fileIndex, 0) + 1}/${fileCount}`}
      </span>
      <button
        type="button"
        className={`${control} rounded-l-lg`}
        disabled={hunkCount === 0}
        onClick={onPrevHunk}
        title="Previous hunk (K)"
      >
        ← hunk
      </button>
      <button
        type="button"
        className={`${control} -ml-2 rounded-r-lg`}
        disabled={hunkCount === 0}
        onClick={onNextHunk}
        title="Next hunk (J)"
      >
        hunk →
      </button>
      <span className="font-mono text-[10.5px] text-label">
        {hunkCount === 0 ? "0/0" : `${hunkIndex + 1}/${hunkCount}`}
      </span>
      <button
        type="button"
        className={`${control} rounded-l-lg`}
        disabled={openCommentCount === 0}
        onClick={onPrevComment}
        title="Previous open comment"
      >
        ← comment
      </button>
      <button
        type="button"
        className={`${control} -ml-2 rounded-r-lg`}
        disabled={openCommentCount === 0}
        onClick={onNextComment}
        title="Next open comment (C)"
      >
        comment → {openCommentCount}
      </button>
      <span className="flex-1" />
      <input
        ref={searchRef}
        value={search}
        aria-label="Search Review"
        placeholder="Search patch…"
        className="h-7 w-44 rounded-lg border border-rule bg-panel px-2 font-sans text-[11.5px] outline-none placeholder:text-faint focus:border-info"
        onChange={(event) => onSearch(event.target.value)}
      />
      <button type="button" className={`${control} min-[1200px]:hidden`} onClick={onInspector}>
        Comments & evidence
      </button>
    </div>
  );
}

function FileNavigator({
  files,
  comments,
  selectedPath,
  open,
  onChoose,
  onClose,
}: {
  readonly files: ReadonlyArray<ReviewDiffFileDto>;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly selectedPath: string | null;
  readonly open: boolean;
  readonly onChoose: (file: ReviewDiffFileDto) => void;
  readonly onClose: () => void;
}) {
  return (
    <aside
      className={`${open ? "" : "max-[1023px]:hidden"} z-30 flex w-[230px] shrink-0 flex-col border-r border-rule bg-panel max-[1023px]:absolute max-[1023px]:inset-y-0 max-[1023px]:left-0 max-[1023px]:shadow-overlay`}
    >
      <div className="flex h-9 items-center border-b border-rule px-3">
        <span className="font-sans text-xs font-medium">Files</span>
        <span className="ml-2 font-mono text-[10.5px] text-label">{files.length}</span>
        <button type="button" className="ml-auto text-label min-[1024px]:hidden" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {files.map((file) => {
          const path = reviewFilePath(file);
          const count = comments.filter(
            (comment) =>
              (comment.anchor?.newPath ?? comment.anchor?.oldPath ?? comment.file) === path,
          ).length;
          return (
            <button
              key={`${file.oldPath ?? ""}:${file.newPath ?? ""}`}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-left ${path === selectedPath ? "bg-wash" : "hover:bg-sunken"}`}
              onClick={() => onChoose(file)}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  file.status === "added"
                    ? "bg-success-dot"
                    : file.status === "deleted"
                      ? "bg-danger-dot"
                      : "bg-info-dot"
                }`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">
                {path}
              </span>
              {count > 0 && <span className="font-mono text-[10.5px] text-info">{count}</span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ReviewInspector({
  open,
  changeId,
  sliceId,
  sessionId,
  steer,
  file,
  comments,
  openComments,
  checkpointA,
  checkpointB,
  diffDigest,
  processLabel,
  recordExcerpt,
  composer,
  selectedComments,
  instruction,
  onClose,
  onComposer,
  onSelectComments,
  onInstruction,
  onCommentChange,
  onChangeComment,
  onOpenEvidence,
}: {
  readonly open: boolean;
  readonly changeId: string;
  readonly sliceId: string;
  readonly sessionId: string;
  /** Whether the viewer steers the session, so may deliver to it. */
  readonly steer: boolean;
  readonly file: ReviewDiffFileDto | null;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly openComments: ReadonlyArray<ReviewCommentDto>;
  readonly checkpointA: {
    readonly id: string;
    readonly sha: string;
    readonly sealantRunId: string | null;
    readonly seq: string;
  } | null;
  readonly checkpointB: {
    readonly id: string;
    readonly sha: string;
    readonly sealantRunId: string | null;
    readonly seq: string;
  } | null;
  readonly diffDigest: string | null;
  readonly processLabel: string | null;
  readonly recordExcerpt: string;
  readonly composer: Composer | null;
  readonly selectedComments: ReadonlySet<string>;
  readonly instruction: string;
  readonly onClose: () => void;
  readonly onComposer: (value: Composer | null) => void;
  readonly onSelectComments: (value: ReadonlySet<string>) => void;
  readonly onInstruction: (value: string) => void;
  readonly onCommentChange: () => void;
  readonly onChangeComment: () => void;
  readonly onOpenEvidence: (sequence: string) => void;
}) {
  const [deliveryKey, setDeliveryKey] = useState(
    () => `desktop-follow-up:${sliceId}:${crypto.randomUUID()}`,
  );
  const delivery = useMutation({
    mutationFn: () => {
      if (checkpointA === null || checkpointB === null || diffDigest === null) {
        return Promise.reject(new Error("The immutable Review inputs are unavailable."));
      }
      return deliverFollowUp(sessionId, {
        reviewSliceId: sliceId,
        checkpointAId: checkpointA.id,
        checkpointBId: checkpointB.id,
        diffDigest,
        commentIds: openComments
          .filter((comment) => selectedComments.has(comment.id))
          .map((comment) => comment.id),
        instruction,
        idempotencyKey: deliveryKey,
      });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["change", changeId] }),
        queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
      ]),
  });

  const resetDeliveryKey = () => {
    setDeliveryKey(`desktop-follow-up:${sliceId}:${crypto.randomUUID()}`);
    delivery.reset();
  };

  return (
    <aside
      className={`${open ? "" : "max-[1199px]:hidden"} z-30 flex w-[320px] shrink-0 flex-col border-l border-rule bg-panel max-[1199px]:absolute max-[1199px]:inset-y-0 max-[1199px]:right-0 max-[1199px]:shadow-overlay`}
    >
      <div className="flex h-9 items-center border-b border-rule px-3">
        <span className="font-sans text-xs font-medium">Comments & evidence</span>
        <button type="button" className="ml-auto text-label min-[1200px]:hidden" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3">
        {composer !== null && (
          <CommentComposer
            changeId={changeId}
            sliceId={sliceId}
            composer={composer}
            onDone={() => {
              onComposer(null);
              onCommentChange();
            }}
            onCancel={() => onComposer(null)}
          />
        )}

        <section>
          <div className="flex items-center gap-2">
            <h2 className="ev-eyebrow">Review comments</h2>
            <span className="font-mono text-[10.5px] text-label">{comments.length}</span>
            <button
              type="button"
              className="ml-auto font-sans text-[11.5px] text-info hover:underline"
              onClick={onChangeComment}
            >
              Comment on change
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {comments.length === 0 ? (
              <p className="font-sans text-xs leading-relaxed text-muted-foreground">
                Click a line number, drag across gutter lines, or comment on the file or change.
              </p>
            ) : (
              comments.map((comment) => (
                <CommentCard
                  key={comment.id}
                  changeId={changeId}
                  comment={comment}
                  onChanged={onCommentChange}
                />
              ))
            )}
          </div>
        </section>

        <section className="rounded-2xl bg-background p-3 shadow-sm">
          <h2 className="ev-eyebrow">Evidence beside this file</h2>
          <div className="mt-3 flex items-center gap-2">
            <span className="size-2 rounded-full bg-info-dot" />
            <span className="font-sans text-xs font-medium">Checkpoint pair observed</span>
          </div>
          {file !== null && (
            <p className="mt-2 font-mono text-[11px] text-ink-2">
              {reviewFilePath(file)} · +{file.additions} −{file.deletions}
            </p>
          )}
          <dl className="mt-3 space-y-2 border-t border-rule-faint pt-3 font-mono text-[10.5px]">
            <EvidenceRow
              label="From"
              value={
                checkpointA === null
                  ? "unavailable"
                  : `${short(checkpointA.sha)} · seq ${checkpointA.seq}`
              }
            />
            <EvidenceRow
              label="To"
              value={
                checkpointB === null
                  ? "unavailable"
                  : `${short(checkpointB.sha)} · seq ${checkpointB.seq}`
              }
            />
            <EvidenceRow label="Run" value={checkpointB?.sealantRunId ?? "legacy gap"} />
            <EvidenceRow
              label="Process"
              value={processLabel ?? "coding agent · process pointer unavailable"}
            />
            <EvidenceRow label="Attribution" value="unknown" />
          </dl>
          <p className="mt-3 border-l-2 border-rule pl-2 font-sans text-[11.5px] leading-relaxed text-muted-foreground">
            Supporting-process attribution incomplete. This checkpoint proves the pinned record
            frontier, not which process wrote this file.
          </p>
          <h3 className="mt-4 font-sans text-[11.5px] font-medium text-foreground">
            Latest recorded output for this run
          </h3>
          <p className="mt-1 font-sans text-[10.5px] leading-relaxed text-label">
            Not bounded to To sequence {checkpointB?.seq ?? "unknown"}; not file attribution.
          </p>
          {recordExcerpt === "" ? (
            <p className="mt-2 font-sans text-[11.5px] leading-relaxed text-muted-foreground">
              No process output excerpt is available.
            </p>
          ) : (
            <pre className="mt-2 max-h-32 overflow-auto border-l-2 border-info bg-panel px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
              {recordExcerpt}
            </pre>
          )}
          <p className="mt-2 font-sans text-[11.5px] leading-relaxed text-muted-foreground">
            Telemetry-loss frontier unavailable in this view; the sequence is the latest Mend
            observed.
          </p>
          <button
            type="button"
            disabled={checkpointB === null || sessionId === ""}
            className="mt-3 font-sans text-[11.5px] font-medium text-info hover:underline disabled:opacity-40"
            onClick={() => checkpointB !== null && onOpenEvidence(checkpointB.seq)}
          >
            Open terminal record at To sequence
          </button>
        </section>

        <section>
          <div className="flex items-center gap-2">
            <h2 className="ev-eyebrow">Follow-up instruction</h2>
            <span className="font-mono text-[10.5px] text-label">
              {selectedComments.size} selected
            </span>
          </div>
          <div className="mt-2 space-y-1.5">
            {openComments.map((comment) => (
              <label key={comment.id} className="flex cursor-pointer items-start gap-2 py-1">
                <input
                  type="checkbox"
                  checked={selectedComments.has(comment.id)}
                  className="mt-0.5 accent-[var(--sw-accent)]"
                  onChange={(event) => {
                    const next = new Set(selectedComments);
                    if (event.target.checked) next.add(comment.id);
                    else next.delete(comment.id);
                    resetDeliveryKey();
                    onSelectComments(next);
                  }}
                />
                <span className="min-w-0 font-sans text-[11.5px] leading-relaxed text-ink-2">
                  <span className="block truncate font-mono text-[10.5px] text-label">
                    {commentLocation(comment)}
                  </span>
                  {comment.body}
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={selectedComments.size === 0}
            className="mt-2 font-sans text-[11.5px] font-medium text-info hover:underline disabled:opacity-40"
            onClick={() => {
              resetDeliveryKey();
              onInstruction(assembleReviewInstruction(openComments, selectedComments));
            }}
          >
            Assemble selected comments
          </button>
          <textarea
            value={instruction}
            rows={7}
            placeholder="Select comments, then assemble an editable instruction."
            className="mt-2 w-full resize-y rounded-lg border border-rule bg-background p-2 font-sans text-xs leading-relaxed outline-none placeholder:text-faint focus:border-info"
            onChange={(event) => {
              resetDeliveryKey();
              onInstruction(event.target.value);
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            {steer && (
              <button
                type="button"
                disabled={
                  delivery.isPending ||
                  selectedComments.size === 0 ||
                  instruction.trim() === "" ||
                  checkpointA === null ||
                  checkpointB === null ||
                  diffDigest === null
                }
                className="rounded-lg bg-primary px-3 py-1.5 font-sans text-[11.5px] font-medium text-primary-foreground shadow-cobalt disabled:opacity-40"
                onClick={() => delivery.mutate()}
              >
                {delivery.isPending
                  ? "Delivering…"
                  : delivery.data?.status === "delivering"
                    ? "Check delivery"
                    : delivery.data?.status === "delivery_failed"
                      ? "Retry delivery"
                      : "Deliver to session"}
              </button>
            )}
            <button
              type="button"
              disabled={instruction.trim() === ""}
              className="rounded-lg border border-rule bg-panel px-3 py-1.5 font-sans text-[11.5px] font-medium shadow-xs hover:-translate-y-px hover:shadow-sm disabled:opacity-40"
              onClick={() => void navigator.clipboard.writeText(instruction)}
            >
              Copy
            </button>
          </div>
          {delivery.data !== undefined && (
            <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-label">
              {delivery.data.status === "delivered"
                ? `delivered · run ${delivery.data.deliverySealantRunId ?? "record unavailable"}`
                : delivery.data.status === "delivering"
                  ? "delivery in progress · check again to reconcile membership"
                  : delivery.data.status === "delivery_failed"
                    ? (delivery.data.deliveryError ?? "delivery failed · retryable")
                    : "bundle pending · the session is active"}
            </p>
          )}
          {delivery.isError && (
            <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-danger">
              {delivery.error instanceof Error ? delivery.error.message : "Delivery failed."}
            </p>
          )}
          <p className="mt-2 font-sans text-[10.5px] leading-relaxed text-label">
            {steer
              ? "Comments become sent only after Mend persists the accepted process membership."
              : "Only this session's owner delivers to it, unless they share control. Copy the instruction to hand it over."}
          </p>
        </section>
      </div>
    </aside>
  );
}

function CommentComposer({
  changeId,
  sliceId,
  composer,
  onDone,
  onCancel,
}: {
  readonly changeId: string;
  readonly sliceId: string;
  readonly composer: Composer;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => postSliceReviewComment(changeId, sliceId, composer.target, body.trim()),
    onSuccess: onDone,
  });
  return (
    <section className="rounded-2xl bg-background p-3 shadow-sm">
      <p className="font-mono text-[10.5px] text-label">{composer.label}</p>
      <textarea
        autoFocus
        value={body}
        rows={4}
        placeholder="Describe what you observed or want changed."
        className="mt-2 w-full resize-y rounded-lg border border-rule bg-panel p-2 font-sans text-xs leading-relaxed outline-none placeholder:text-faint focus:border-info"
        onChange={(event) => setBody(event.target.value)}
      />
      {create.isError && (
        <p className="mt-2 text-[11px] text-danger">
          {create.error instanceof Error ? create.error.message : "Comment could not be saved."}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="font-sans text-[11.5px] text-label hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={body.trim() === "" || create.isPending}
          className="rounded-lg bg-primary px-3 py-1.5 font-sans text-[11.5px] font-medium text-primary-foreground shadow-cobalt disabled:opacity-40"
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Saving…" : "Add comment"}
        </button>
      </div>
    </section>
  );
}

function CommentCard({
  changeId,
  comment,
  onChanged,
}: {
  readonly changeId: string;
  readonly comment: ReviewCommentDto;
  readonly onChanged: () => void;
}) {
  const state = useMutation({
    mutationFn: (next: "open" | "addressed" | "dismissed") =>
      setReviewCommentState(changeId, comment.id, next),
    onSuccess: onChanged,
  });
  return (
    <article className="rounded-xl bg-background p-2.5 shadow-xs">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1 size-1.5 shrink-0 rounded-full ${comment.state === "open" ? "bg-warning-dot" : "bg-[var(--sw-faint)]"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[10px] text-label">{commentLocation(comment)}</p>
          <p className="mt-1 font-sans text-[11.5px] leading-relaxed text-ink-2">{comment.body}</p>
          <div className="mt-2 flex gap-3">
            {comment.state === "open" ? (
              <>
                <button
                  type="button"
                  className="text-[10.5px] text-success hover:underline"
                  disabled={state.isPending}
                  onClick={() => state.mutate("addressed")}
                >
                  Mark addressed
                </button>
                <button
                  type="button"
                  className="text-[10.5px] text-label hover:underline"
                  disabled={state.isPending}
                  onClick={() => state.mutate("dismissed")}
                >
                  Dismiss
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-[10.5px] text-info hover:underline"
                disabled={state.isPending}
                onClick={() => state.mutate("open")}
              >
                Reopen
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function EvidenceRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-2">
      <dt className="text-label">{label}</dt>
      <dd className="break-all text-ink-2">{value}</dd>
    </div>
  );
}
