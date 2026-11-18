import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileDiffIcon, RefreshCwIcon } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { QueryView } from "#/components/query-view";
import { QueryError } from "#/components/route-screens";
import type { ViewPlace } from "#/components/workspace/views";
import type { ReviewDiffDto, SessionDetailDto, SessionInboxRowDto } from "#/lib/api";
import {
  changeFileOf,
  type ChangeFile,
  fileGroups,
  filterGroups,
  orderedFiles,
} from "#/lib/change-files";
import { inboxQuery } from "#/lib/inbox-live";
import {
  openReviewQuery,
  opensCurrentChange,
  renewReviewOpenKey,
  renewReviewOpenKeyFrom,
  useReviewOpenKey,
} from "#/lib/review-open";
import { sessionDetailQuery } from "#/lib/session-queries";
import { harnessName } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { diffLayout } from "#/lib/ui-prefs";
import { isViewed, markViewed, viewedFiles } from "#/lib/viewed-files";

import { ChangeDiffs, useFolds } from "./change-diffs.tsx";
import { ChangeFileTree, FILTER_FROM, FileFilter } from "./change-file-tree.tsx";
import { ChangeProofArtifacts } from "./change-proof-artifacts.tsx";
import { ChangeToolbar } from "./change-toolbar.tsx";
import { FilePicker } from "./file-picker.tsx";

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

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

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
        <EmptyDescription>
          {sessions > 1
            ? "No session in this workspace has changed a file yet. The change shows up here as soon as one does."
            : `${harnessName(detail.session.harness)} hasn't changed any files in this session. The change shows up here as soon as it edits one.`}
        </EmptyDescription>
      </EmptyHeader>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-row">
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
  sessions,
  box,
}: {
  readonly detail: SessionDetailDto;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  readonly sessions: ReadonlyArray<SessionInboxRowDto>;
  readonly box: RefObject<HTMLElement | null>;
}) {
  const narrow = useNarrow(box);
  const layout = diffLayout.use();
  const viewedStore = viewedFiles(changeId);
  const marks = viewedStore.use();
  const files = useMemo(() => review.files.map(changeFileOf), [review.files]);
  const groups = useMemo(() => fileGroups(files), [files]);
  const ordered = useMemo(() => orderedFiles(groups), [groups]);
  const [filter, setFilter] = useState("");
  const [focus, setFocus] = useState<{ readonly path: string; readonly nonce: number } | null>(
    null,
  );
  const [showing, setShowing] = useState<string | null>(null);
  const folds = useFolds();

  if (ordered.length === 0) return <NothingYet detail={detail} sessions={sessions.length} />;

  const viewedOf = (file: ChangeFile) => isViewed(marks, file.path, file.fingerprint);
  const setViewed = (file: ChangeFile, viewed: boolean) =>
    viewedStore.set(markViewed(marks, file.path, file.fingerprint, viewed));
  const viewedCount = ordered.filter(viewedOf).length;
  const current = ordered.find((file) => file.path === showing) ?? ordered[0] ?? null;
  const select = (path: string) => {
    const file = ordered.find((each) => each.path === path);
    if (file !== undefined) folds.fold(path, false, viewedOf(file));
    setShowing(path);
    setFocus((was) => ({ path, nonce: (was?.nonce ?? 0) + 1 }));
  };
  const generated = ordered.some((file) => file.generated);
  const base = detail.session.baseRef ?? "the base";

  return (
    <>
      <ChangeToolbar
        range="Whole change"
        detail={`${base} to checkpoint ${review.checkpointB.ordinal}`}
        layout={layout}
        onLayoutChange={diffLayout.set}
        note={
          <>
            {sessions.length > 1 ? (
              <span className="block font-medium text-foreground">
                This workspace's change, from {sessions.length} sessions.
              </span>
            ) : null}
            {plural(ordered.length, "file", "files")} changed.
            {generated ? " Mend folds generated files." : ""}
          </>
        }
      />
      {review.worktreeChangedSinceSnapshot ? (
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
            after={<ChangeProofArtifacts changeId={changeId} />}
          />
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
  const opened = useQuery({ ...openReviewQuery(changeId, openKey), enabled: openKey !== "" });
  const slice = opened.isPending || opened.isError ? null : opened.data.slice.id;
  const review = useQuery(
    trpc.changes.reviewDiff.queryOptions(
      slice === null ? skipToken : { id: changeId, sliceId: slice },
    ),
  );
  const comments = useQuery(trpc.changes.comments.queryOptions({ id: changeId }));

  // Once per key, after its slice and the comments are read: move on from a stale slice. The key
  // lives in sessionStorage, outside React, so this is a write to it after the reads land.
  const checked = useRef<string | null>(null);
  const pinned = review.isPending || review.isError ? null : review.data;
  const commentsRead = comments.isPending ? undefined : comments.isError ? null : comments.data;
  useEffect(() => {
    if (pinned === null || commentsRead === undefined || checked.current === openKey) return;
    checked.current = openKey;
    if (opensCurrentChange(pinned, changeId, pinned.slice.id, commentsRead))
      renewReviewOpenKeyFrom(changeId, openKey);
  }, [pinned, commentsRead, changeId, openKey]);

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
 * - Mend's description and "Start tour" (PR 25): `ChangeDiffs`'s `above`, shown only while the
 *   range is the whole change; tour stops between lines through `between`.
 * - Comments (PR 24): rows between lines through `ChangeDiffs`'s `between`, the Comments and
 *   "Drafts from Mend" sections under Files in the column, Send comments in the toolbar's
 *   `actions`, and the toolbar's note ("Click a line to comment…").
 * - Land… (PR 26): the toolbar's `actions`; `#land` opens its dialog.
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
