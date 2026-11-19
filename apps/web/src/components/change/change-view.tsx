import { Banner } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { skipToken, type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileDiffIcon, RefreshCwIcon } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { QueryView } from "#/components/query-view";
import { QueryError } from "#/components/route-screens";
import type { ViewPlace } from "#/components/workspace/views";
import type {
  OpenReviewResultDto,
  ReviewCommentDto,
  ReviewDiffDto,
  ReviewRangeRequest,
  SessionDetailDto,
  SessionInboxRowDto,
} from "#/lib/api";
import {
  changeFileOf,
  type ChangeFile,
  fileGroups,
  filterGroups,
  orderedFiles,
} from "#/lib/change-files";
import { inboxQuery } from "#/lib/inbox-live";
import { AGENTS } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import {
  openReviewQuery,
  opensCurrentChange,
  renewReviewOpenKey,
  renewReviewOpenKeyFrom,
  setReviewRange,
  useReviewOpenKey,
  useReviewRange,
} from "#/lib/review-open";
import { checkpointRows, finishedWords, rangeLabel, rangeNoteWords } from "#/lib/review-range";
import { sessionDetailQuery } from "#/lib/session-queries";
import { harnessName } from "#/lib/session-view";
import { removedWithin, type StopPlace, stopPlace } from "#/lib/tour";
import { useTRPC } from "#/lib/trpc";
import { diffLayout } from "#/lib/ui-prefs";
import { isViewed, markViewed, viewedFiles } from "#/lib/viewed-files";

import { type CommentMark, useChangeComments } from "./change-comments.tsx";
import { ChangeDescription, useTourCurrent } from "./change-description.tsx";
import { ChangeDiffs, type DiffsFocus, type MarkedLines, useFolds } from "./change-diffs.tsx";
import { ChangeFileTree, FILTER_FROM, FileFilter } from "./change-file-tree.tsx";
import { ChangeProofArtifacts } from "./change-proof-artifacts.tsx";
import { ChangeToolbar } from "./change-toolbar.tsx";
import { type TourMoves, TourNote, TourRail } from "./change-tour.tsx";
import { FilePicker } from "./file-picker.tsx";
import { useChangeLanding } from "./land-dialog.tsx";
import { type PickedRange, RangePicker } from "./range-picker.tsx";

/** What sits between a file's lines: a tour stop's note, or a comment and the box writing one. */
type BetweenMark = { readonly kind: "tour" } | CommentMark;

/** Narrower than this, the view drops its file column for a picker over the diffs. */
const NARROW_PX = 768;

/** Whether the view's own box is narrow: a tile beside a conversation, or a phone. */
const useNarrow = (box: RefObject<HTMLElement | null>): boolean => {
  const [narrow, setNarrow] = useState(false);
  // The tile's width is the browser's to tell, as it is dragged and the window resized.
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const watch = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setNarrow(entry.contentRect.width < NARROW_PX);
    });
    watch.observe(element);
    return () => watch.disconnect();
  }, [box]);
  return narrow;
};

/** The sessions working in this workspace, from the inbox rows the sheet already reads. */
const useWorkspaceSessions = (worktreeId: string): ReadonlyArray<SessionInboxRowDto> => {
  const trpc = useTRPC();
  const rows = useQuery({
    ...inboxQuery(trpc),
    select: (all) => all.filter((row) => row.session.worktreeId === worktreeId),
  });
  return rows.isPending || rows.isError ? [] : rows.data;
};

/** Where the change starts: "main · 9c41e07", or the commit alone when the base has no name. */
const baseWords = (detail: SessionDetailDto): string | null => {
  const ref = detail.session.baseRef;
  const sha = detail.change?.baseSha.slice(0, 7) ?? null;
  if (ref === null) return sha;
  return sha === null ? ref : `${ref} · ${sha}`;
};

/** A read that failed, with Try again, inside the view's padding. */
const readFailed = (error: unknown, retry: () => void) => (
  <div className="p-4 lg:p-6">
    <QueryError error={error} retry={retry} retrying={false} />
  </div>
);

/** Why there is nothing to review, naming the agent when one works here alone. */
const nothingYetWords = (harness: string, sessions: number): string => {
  if (sessions > 1)
    return "No session in this workspace has changed a file yet. The change shows up here as soon as one does.";
  const agent = AGENTS.find((each) => each.id === harness)?.label;
  return agent === undefined
    ? "This session hasn't changed any files. The change shows up here as soon as a file changes."
    : `${agent} hasn't changed any files in this session. The change shows up here as soon as it edits one.`;
};

/** Nothing to review yet: no file differs from the base. */
function NothingYet({
  detail,
  sessions,
}: {
  readonly detail: SessionDetailDto;
  readonly sessions: number;
}) {
  const base = baseWords(detail);
  return (
    <Empty className="m-auto">
      <EmptyHeader className="max-w-md">
        <EmptyMedia>
          <FileDiffIcon aria-hidden className="size-6 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No changes yet</EmptyTitle>
        <EmptyDescription>{nothingYetWords(detail.session.harness, sessions)}</EmptyDescription>
      </EmptyHeader>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-left text-row">
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="font-mono">{detail.session.branch}</dd>
        {base === null ? null : (
          <>
            <dt className="text-muted-foreground">Base</dt>
            <dd className="font-mono">{base}</dd>
          </>
        )}
      </dl>
    </Empty>
  );
}

/** The column's section title with a muted fact on its right: "Files · 0 of 3 viewed". */
function ColumnTitle({ title, fact }: { readonly title: string; readonly fact: string }) {
  return (
    <h3 className="flex items-baseline justify-between gap-3 px-2 text-row font-semibold">
      {title}
      <span className="text-meta font-normal text-muted-foreground">{fact}</span>
    </h3>
  );
}

/**
 * What the review's bytes are and where they were seen, in the recorder's voice: the two commits,
 * whether a capture or the live worktree was read, and paths git can't reach.
 */
function Observed({ review }: { readonly review: ReviewDiffDto }) {
  const observation = review.observation;
  const seen =
    observation === undefined
      ? null
      : observation.source === "capture"
        ? [
            `${observation.state} at capture ${observation.captureN ?? "?"}`,
            ...(observation.partial ? ["partial"] : []),
          ].join(" · ")
        : "observed on the worktree";
  return (
    <div className="grid gap-1 px-2 font-mono text-2xs text-faint">
      <p title={observation?.label}>
        {review.checkpointA.sha.slice(0, 7)} → {review.checkpointB.sha.slice(0, 7)}
        {seen === null ? "" : ` · ${seen}`}
      </p>
      {review.outsideGit == null ? null : (
        // Saved and restored, but in no patch git computes: said, never hidden.
        <p title={review.outsideGit.paths.join("\n")}>{review.outsideGit.label}</p>
      )}
    </div>
  );
}

/**
 * The other repositories the session holds (docs/adr/0011), each with its own change to review,
 * or the words for why it has none of its own yet.
 */
function Repositories({ detail }: { readonly detail: SessionDetailDto }) {
  if (detail.repositories.length === 0) return null;
  return (
    <section className="grid gap-1.5 border-t px-3 py-4">
      <ColumnTitle title="Repositories" fact={String(detail.repositories.length)} />
      <ul className="grid gap-1 px-2 text-row">
        {detail.repositories.map((view) => (
          <li key={view.repository.id} className="grid">
            {view.change !== null && view.checkpointsBeyondStart > 0 ? (
              <Link
                to="/changes/$changeId"
                params={{ changeId: view.change.id }}
                className="truncate font-mono text-2xs text-info hover:underline"
              >
                {view.repository.path}
              </Link>
            ) : (
              <span className="truncate font-mono text-2xs">{view.repository.path}</span>
            )}
            <span className="text-meta text-muted-foreground">
              {view.repository.state}
              {view.repository.state === "ready" && view.checkpointsBeyondStart === 0
                ? " · nothing of its own to review yet"
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The sessions whose work this change holds, when more than one shares the workspace. */
function Sessions({ sessions }: { readonly sessions: ReadonlyArray<SessionInboxRowDto> }) {
  if (sessions.length < 2) return null;
  return (
    <section className="grid gap-1.5 border-t px-3 py-4">
      <ColumnTitle title="Sessions" fact={String(sessions.length)} />
      <ul className="grid gap-1">
        {sessions.map((row) => (
          <li key={row.session.id}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: row.session.id }}
              className="grid rounded-chip px-2 py-1 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="truncate text-row">{row.title}</span>
              <span className="text-meta text-muted-foreground">
                {harnessName(row.session.harness)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The change as the review pinned it: toolbar, files, and every file's diff. */
function ReviewBody({
  detail,
  changeId,
  review,
  opened,
  range,
  comments,
  sessions,
  box,
}: {
  readonly detail: SessionDetailDto;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  /** How the review was opened: over which range, and where the person last reviewed. */
  readonly opened: OpenReviewResultDto;
  /** The range this tab asked for; null is the whole change. */
  readonly range: ReviewRangeRequest | null;
  readonly comments: UseQueryResult<ReadonlyArray<ReviewCommentDto>, unknown>;
  readonly sessions: ReadonlyArray<SessionInboxRowDto>;
  readonly box: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  const narrow = useNarrow(box);
  const phone = usePhone();
  const layout = diffLayout.use();
  const viewedStore = viewedFiles(changeId);
  const marks = viewedStore.use();
  const files = useMemo(() => review.files.map(changeFileOf), [review.files]);
  const groups = useMemo(() => fileGroups(files), [files]);
  const ordered = useMemo(() => orderedFiles(groups), [groups]);
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<DiffsFocus | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const folds = useFolds();
  const landing = useChangeLanding({ detail, changeId, review, sessions });
  const tourRead = useQuery(trpc.changes.tour.queryOptions({ id: changeId }));
  const passesRead = useQuery(trpc.changes.passes.queryOptions({ id: changeId }));
  const tour = tourRead.isSuccess ? tourRead.data : null;
  const tourCurrent = useTourCurrent(tour, review);
  // A first look opens the description; a later one (a file already viewed) folds it.
  const [laterLook] = useState(() =>
    ordered.some((file) => isViewed(marks, file.path, file.fingerprint)),
  );
  // The stop the tour is on, and how the view was before it started, to go back to.
  const [stopAt, setStopAt] = useState<number | null>(null);
  const before = useRef<{
    readonly top: number;
    readonly folds: ReadonlySet<string>;
    readonly showing: string | null;
  } | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const viewedCount = ordered.filter((file) => isViewed(marks, file.path, file.fingerprint)).length;
  // Second look: the range the review covers, and moving to another one.
  // The session's chain, with the review's own checkpoints when it was read before they were taken.
  const chain = [
    ...detail.checkpoints,
    ...[review.checkpointA, review.checkpointB].filter(
      (taken) => !detail.checkpoints.some((each) => each.id === taken.id),
    ),
  ];
  const latest = Math.max(review.checkpointB.ordinal, ...chain.map((each) => each.ordinal));
  const rangeKind = opened.range?.kind ?? "whole";
  const fromBase = review.checkpointA.ordinal === 0;
  const queryClient = useQueryClient();
  // The chain grows while the agent works: read it again when a checkpoint isn't known yet.
  const freshChain = async () =>
    (await queryClient.fetchQuery({ ...sessionDetailQuery(trpc, detail.session.id), staleTime: 0 }))
      .checkpoints;
  const showEdit = (checkpointId: string) => {
    const known = chain.some((each) => each.id === checkpointId);
    void (known ? Promise.resolve(chain) : freshChain()).then((checkpoints) => {
      const edited = checkpoints.find((each) => each.id === checkpointId);
      const prior =
        edited === undefined
          ? undefined
          : checkpoints.find((each) => each.ordinal === edited.ordinal - 1);
      if (edited !== undefined && prior !== undefined)
        setReviewRange(changeId, { from: prior.id, to: edited.id });
      return undefined;
    });
  };
  const review24 = useChangeComments({
    detail,
    changeId,
    review,
    fileCount: ordered.length,
    viewedAll: ordered.length > 0 && viewedCount === ordered.length,
    comments,
    passes: passesRead,
    narrow,
    phone,
    moves: {
      show: (path, target) => {
        if (path === null) {
          setFocus((was) => ({ path: null, nonce: (was?.nonce ?? 0) + 1 }));
          return;
        }
        const file = ordered.find((each) => each.path === path);
        if (file !== undefined)
          folds.fold(path, false, isViewed(marks, file.path, file.fingerprint));
        setShowing(path);
        setFocus((was) => ({
          path,
          nonce: (was?.nonce ?? 0) + 1,
          ...(target === undefined ? {} : { target, above: 30 }),
        }));
      },
      showEdit,
    },
  });

  const baseName = detail.session.baseRef ?? "the base";
  const label = rangeLabel(opened, baseName, range?.to !== undefined);
  const picked: PickedRange =
    rangeKind === "since-last-review" && range?.to === undefined
      ? { kind: "since-last-review" }
      : range !== null && range.from === "base" && range.to !== undefined
        ? { kind: "up-to", checkpointId: range.to }
        : fromBase
          ? { kind: "whole" }
          : { kind: "custom" };
  const picker = (
    <RangePicker
      label={label}
      picked={picked}
      base={baseName}
      latest={latest}
      lastReview={opened.lastReview ?? null}
      rows={checkpointRows(chain, opened.lastReview ?? null)}
      onPick={(next) => setReviewRange(changeId, next)}
      onOpen={() => void freshChain()}
    />
  );
  if (ordered.length === 0 && fromBase)
    return (
      <>
        <NothingYet detail={detail} sessions={sessions.length} />
        {landing.dialog}
      </>
    );
  if (ordered.length === 0)
    // A narrower range with nothing in it: say so, and keep the picker to move on.
    return (
      <>
        <div className="flex h-[50px] shrink-0 items-center border-b px-4">{picker}</div>
        <Empty className="m-auto">
          <EmptyHeader className="max-w-md">
            <EmptyMedia>
              <FileDiffIcon aria-hidden className="size-6 text-muted-foreground" />
            </EmptyMedia>
            <EmptyTitle>
              {rangeKind === "since-last-review"
                ? "Nothing changed since your last review"
                : "Nothing changed between these checkpoints"}
            </EmptyTitle>
            <EmptyDescription>
              Checkpoint {review.checkpointA.ordinal} and checkpoint {review.checkpointB.ordinal}{" "}
              hold the same files.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            className="max-lg:h-11"
            onClick={() => setReviewRange(changeId, null)}
          >
            Show the whole change
          </Button>
        </Empty>
        {landing.dialog}
      </>
    );

  const viewedOf = (file: ChangeFile) => isViewed(marks, file.path, file.fingerprint);
  const setViewed = (file: ChangeFile, viewed: boolean) =>
    viewedStore.set(markViewed(marks, file.path, file.fingerprint, viewed));
  const current = ordered.find((file) => file.path === showing) ?? ordered[0] ?? null;
  const nextFocus = (path: string | null, target?: Pick<DiffsFocus, "target" | "above">) =>
    setFocus((was) => ({ path, nonce: (was?.nonce ?? 0) + 1, ...target }));
  const select = (path: string, target?: Pick<DiffsFocus, "target" | "above">) => {
    const file = ordered.find((each) => each.path === path);
    if (file !== undefined) folds.fold(path, false, viewedOf(file));
    setShowing(path);
    nextFocus(path, target);
  };
  const all = comments.isSuccess ? comments.data : [];
  const finished =
    rangeKind === "whole"
      ? finishedWords(all, opened.lastReview ?? null, latest, harnessName)
      : null;
  const resolvedAny = all.some(
    (comment) => comment.state === "addressed" && comment.sentToSessionId !== null,
  );
  const rangeNote = resolvedAny
    ? null
    : rangeNoteWords(
        picked.kind === "since-last-review" ? "since-last-review" : fromBase ? "whole" : "custom",
        ordered.length,
        review.unchangedInRange,
      );

  // The tour: one stop at a time, its note at its place in the diffs, the stop list above Files.
  const stops = tour?.stops ?? [];
  const at = stopAt !== null && stopAt < stops.length ? stopAt : null;
  const stop = at === null ? undefined : stops[at];
  const place: StopPlace | null = stop === undefined ? null : stopPlace(stop, ordered);
  const go = (index: number) => {
    const next = stops[index];
    if (next === undefined) return;
    setStopAt(index);
    const where = stopPlace(next, ordered);
    // A stop with no file sits under the description, at the top; one on lines leaves a line
    // or so of the diff showing above its note; one on a whole file sits under the header.
    if (where.kind === "change") nextFocus(null);
    else
      select(where.path, {
        target: "[data-tour-note]",
        ...(where.kind === "line" ? { above: 30 } : {}),
      });
  };
  const moves: TourMoves = {
    go,
    end: () => {
      const was = before.current;
      setStopAt(null);
      if (was === null) return;
      before.current = null;
      folds.restore(was.folds);
      setShowing(was.showing);
      // Back where the person was, once the note has left and the folds are back.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (scroller.current !== null) scroller.current.scrollTop = was.top;
        }),
      );
    },
  };
  const startTour = () => {
    before.current = {
      top: scroller.current?.scrollTop ?? 0,
      folds: folds.saved,
      showing,
    };
    go(0);
  };
  const note =
    tour === null || at === null || place === null ? null : (
      <TourNote tour={tour} index={at} place={place} touch={phone} moves={moves} />
    );
  const marked = (file: ChangeFile): "header" | MarkedLines | null => {
    if (place === null || place.kind === "change" || place.path !== file.path) return null;
    if (place.kind === "file") return "header";
    return {
      from: place.from,
      to: place.to,
      removed: removedWithin(file.file.patch, place.from, place.to),
    };
  };

  return (
    <>
      <ChangeToolbar
        range={label.range}
        detail={label.detail}
        picker={picker}
        layout={layout}
        onLayoutChange={diffLayout.set}
        actions={
          review24.action === null && landing.action === null ? undefined : (
            <>
              {review24.action}
              {landing.action}
            </>
          )
        }
        note={
          landing.note ?? (
            <>
              {sessions.length > 1 ? (
                <span className="block font-medium text-foreground">
                  This workspace's change, from {sessions.length} sessions.
                </span>
              ) : null}
              {rangeNote ?? review24.note}
            </>
          )
        }
      />
      {finished === null ? null : (
        <Banner
          tone="info"
          layout={narrow ? "stacked" : "inline"}
          title={finished.title}
          actions={
            <Button
              size={narrow ? "touch" : "sm"}
              className={narrow ? "w-full" : undefined}
              onClick={() => setReviewRange(changeId, { from: "last-review" })}
            >
              Show changes since your last review
            </Button>
          }
        >
          {finished.detail}
        </Banner>
      )}
      {landing.band}
      {review24.band}
      {landing.dialog}
      {review24.dialogs}
      {review.worktreeChangedSinceSnapshot && range?.to === undefined ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-band px-4 py-3 lg:px-5"
        >
          <RefreshCwIcon aria-hidden className="size-4 shrink-0 text-info" />
          <p className="min-w-0 flex-1 text-row">
            <span className="font-semibold">Files changed since you opened this.</span>{" "}
            <span className="text-muted-foreground">
              You're reading checkpoint {review.checkpointB.ordinal}.
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="max-lg:h-11"
            onClick={() => renewReviewOpenKey(changeId)}
          >
            Show the new version
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Files"
          className="flex w-[264px] shrink-0 flex-col overflow-y-auto border-r @max-3xl/change:hidden"
        >
          {tour === null || at === null ? null : <TourRail tour={tour} index={at} moves={moves} />}
          <section className="grid gap-2 px-3 py-4">
            <ColumnTitle title="Files" fact={`${viewedCount} of ${ordered.length} viewed`} />
            {ordered.length >= FILTER_FROM ? (
              <FileFilter value={filter} onChange={setFilter} />
            ) : null}
            <ChangeFileTree
              groups={filterGroups(groups, filter)}
              selected={current?.path ?? null}
              viewed={viewedOf}
              onSelect={select}
            />
          </section>
          {review24.column}
          <Sessions sessions={sessions} />
          <Repositories detail={detail} />
          <div className="mt-auto border-t px-3 py-3">
            <Observed review={review} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {narrow && current !== null ? (
            <FilePicker
              groups={groups}
              files={ordered}
              current={current}
              viewedCount={viewedCount}
              isViewed={viewedOf}
              onViewed={setViewed}
              onSelect={select}
            />
          ) : null}
          <ChangeDiffs
            files={ordered}
            layout={narrow ? "unified" : layout}
            compact={narrow}
            sides={{
              old: `Checkpoint ${review.checkpointA.ordinal} · ${review.checkpointA.sha.slice(0, 7)}`,
              new: `Checkpoint ${review.checkpointB.ordinal} · ${review.checkpointB.sha.slice(0, 7)}`,
            }}
            isViewed={viewedOf}
            onViewed={setViewed}
            folds={folds}
            focus={focus}
            onShowing={setShowing}
            scrollRef={scroller}
            above={
              <>
                {/* Mend's description is of the whole change: a narrower range shows none. */}
                {fromBase ? (
                  <ChangeDescription
                    changeId={changeId}
                    review={review}
                    tour={tourRead}
                    passes={passesRead}
                    current={tourCurrent}
                    folded={laterLook || narrow || phone}
                    touch={phone}
                    touring={at !== null}
                    onStartTour={startTour}
                  />
                ) : null}
                {place?.kind === "change" ? note : null}
                {review24.above}
              </>
            }
            between={{
              annotations: (file: ChangeFile) => [
                ...review24.annotations(file),
                ...(place?.kind === "line" && file.path === place.path
                  ? [
                      {
                        side: "additions" as const,
                        lineNumber: place.after,
                        metadata: { kind: "tour" } as const,
                      },
                    ]
                  : []),
              ],
              render: (annotation: DiffLineAnnotation<BetweenMark>) =>
                annotation.metadata.kind === "tour" ? note : review24.render(annotation.metadata),
            }}
            under={(file) =>
              review24.under(file, place?.kind === "file" && place.path === file.path ? note : null)
            }
            marked={marked}
            picking={review24.picking}
            tools={review24.tools}
            after={
              <>
                {review24.after}
                <ChangeProofArtifacts changeId={changeId} />
              </>
            }
          />
          {review24.bar}
        </div>
      </div>
    </>
  );
}

/**
 * The review of one change: opening it pins a slice once per browser tab (`review-open`), then the
 * slice's diff is read. A slice this tab pinned on an earlier visit that the worktree has moved past
 * opens as the change is now, unless anything on it is still to send.
 */
function ChangeReview({
  detail,
  changeId,
  sessions,
  box,
}: {
  readonly detail: SessionDetailDto;
  readonly changeId: string;
  readonly sessions: ReadonlyArray<SessionInboxRowDto>;
  readonly box: RefObject<HTMLElement | null>;
}) {
  const trpc = useTRPC();
  // Empty while the server renders: the key lives in this tab's sessionStorage.
  const openKey = useReviewOpenKey(changeId);
  const range = useReviewRange(changeId);
  const opened = useQuery({
    ...openReviewQuery(changeId, openKey, range),
    enabled: openKey !== "",
  });
  const slice = opened.isPending || opened.isError ? null : opened.data.slice.id;
  const review = useQuery(
    trpc.changes.reviewDiff.queryOptions(
      slice === null ? skipToken : { id: changeId, sliceId: slice },
    ),
  );
  // Read for the review's slice, each comment also says where it sits on it now.
  const comments = useQuery(
    trpc.changes.comments.queryOptions(
      slice === null ? { id: changeId } : { id: changeId, sliceId: slice },
    ),
  );

  // Once per key, after its slice and the comments are read: move on from a stale slice. The key
  // lives in sessionStorage, outside React, so this is a write to it after the reads land.
  const checked = useRef<string | null>(null);
  const pinned = review.isPending || review.isError ? null : review.data;
  const commentsRead = comments.isPending ? undefined : comments.isError ? null : comments.data;
  useEffect(() => {
    if (pinned === null || commentsRead === undefined || checked.current === openKey) return;
    checked.current = openKey;
    // A range that ends at a chosen checkpoint is meant to stay where it is.
    if (range?.to !== undefined) return;
    if (opensCurrentChange(pinned, changeId, pinned.slice.id, commentsRead))
      renewReviewOpenKeyFrom(changeId, openKey);
  }, [pinned, commentsRead, changeId, openKey, range]);

  if (opened.isError)
    return (
      <div className="p-4 lg:p-6">
        <QueryError
          error={opened.error}
          retry={() => void opened.refetch()}
          retrying={opened.isFetching}
        />
      </div>
    );
  if (opened.isPending)
    return (
      <p role="status" className="p-4 text-row text-muted-foreground lg:p-6">
        Opening the review…
      </p>
    );
  return (
    <QueryView
      query={review}
      pending={
        <p role="status" className="p-4 text-row text-muted-foreground lg:p-6">
          Reading the change…
        </p>
      }
      error={readFailed}
    >
      {(read: ReviewDiffDto) => (
        <ReviewBody
          detail={detail}
          changeId={changeId}
          review={read}
          opened={opened.data}
          range={range}
          comments={comments}
          sessions={sessions}
          box={box}
        />
      )}
    </QueryView>
  );
}

/**
 * The Change view (Doop page 4): this workspace's change, the worktree against its base, which
 * every session in the workspace adds to. Reading it is this view; what attaches later:
 *
 * - Mend's description and "Start tour" (PR 25): `ChangeDescription` in `ChangeDiffs`'s `above`
 *   (the range is always the whole change today; a narrower range shows no description). The
 *   tour's stop list sits above Files; a stop's note goes between lines through `between`, under
 *   a file's header through `under`, or under the description.
 * - Comments (`change-comments.tsx`): rows between lines through `between`, line picking, a
 *   file's "…", the Comments and "Drafts from Mend" sections under Files, comments on the whole
 *   change over the diffs, Your review after the last file, Send in the toolbar's `actions` (at
 *   the foot of a narrow view), its note, and the band saying how a send went.
 * - Land… (`land-dialog.tsx`): the toolbar's `actions` and, once something landed, its note;
 *   `#land` opens the dialog.
 */
export function ChangeBody({ place }: { readonly place: ViewPlace }) {
  const trpc = useTRPC();
  const detail = useQuery(sessionDetailQuery(trpc, place.sessionId));
  const sessions = useWorkspaceSessions(place.worktreeId);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="@container/change flex min-h-0 flex-1 flex-col bg-background">
      <QueryView query={detail} error={readFailed}>
        {(read: SessionDetailDto) =>
          read.change === null ? (
            <NothingYet detail={read} sessions={sessions.length} />
          ) : (
            <ChangeReview
              key={read.change.id}
              detail={read}
              changeId={read.change.id}
              sessions={sessions}
              box={box}
            />
          )
        }
      </QueryView>
    </div>
  );
}
