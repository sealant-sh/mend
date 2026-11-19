import { Banner } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { cn } from "@mend/ui/lib/utils";
import type { DiffLineAnnotation } from "@pierre/diffs";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, MessageSquarePlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import {
  agentIsLive,
  type ChangePassDto,
  type FollowUpDto,
  type ReviewCommentDto,
  type ReviewDiffDto,
  type SessionDetailDto,
} from "#/lib/api";
import type { ChangeFile } from "#/lib/change-files";
import { reviewDraftKey, useDraft } from "#/lib/drafts";
import { failureWords } from "#/lib/refusal";
import {
  anchorFor,
  anchorKey,
  assembleInstruction,
  commentGroups,
  commentsOf,
  countWords,
  deliveryOf,
  isDismissedDraft,
  type LineAnchor,
  lineLabel,
  parseAnchor,
  passBusy,
  passOf,
  passWords,
  placeLongWords,
  placeWords,
  sendRuleOf,
  stateWords,
  toolbarNoteWords,
} from "#/lib/review-comments";
import { harnessName } from "#/lib/session-view";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { uuidV4 } from "#/lib/uuid";

import type { LinePicking } from "./change-diffs.tsx";
import { CommentComposer, ReviewComment } from "./review-comment.tsx";
import { type ChosenSend, SendDialog } from "./send-dialog.tsx";

/** What a comment puts between a file's lines: a saved comment, or the box writing a new one. */
export type CommentMark =
  | { readonly kind: "comment"; readonly comment: ReviewCommentDto }
  | { readonly kind: "composer"; readonly anchor: LineAnchor };

/** One send as it went to the server, kept so Try again sends exactly it again. */
interface Attempt {
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string;
  readonly count: number;
}

/** A follow-up saved on the server, sent again as it was: same words, same key. */
const attemptOf = (followUp: FollowUpDto): Attempt | null =>
  followUp.idempotencyKey === null
    ? null
    : {
        commentIds: followUp.commentIds,
        instruction: followUp.instruction,
        idempotencyKey: followUp.idempotencyKey,
        count: followUp.commentIds.length,
      };

/** A column section's title with its muted fact on the right: "Comments · 2 not sent". */
function SectionTitle({ title, fact }: { readonly title: string; readonly fact: string }) {
  return (
    <h3 className="flex items-baseline justify-between gap-3 px-2 text-row font-semibold">
      {title}
      <span className="text-meta font-normal text-muted-foreground">{fact}</span>
    </h3>
  );
}

/** One comment in the column: where it sits and who wrote it, its words, where it stands. */
function ColumnRow({
  comment,
  note,
  onShow,
}: {
  readonly comment: ReviewCommentDto;
  readonly note: string | null;
  readonly onShow: (comment: ReviewCommentDto) => void;
}) {
  const who =
    comment.state === "draft"
      ? "Draft"
      : comment.authorKind === "mend"
        ? "Mend"
        : comment.authorName;
  return (
    <li>
      <button
        type="button"
        onClick={() => onShow(comment)}
        className="grid w-full rounded-chip px-2 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11"
      >
        <span className="truncate text-meta text-muted-foreground">
          {comment.file === null ? (
            "Whole change"
          ) : (
            <span className="font-mono text-2xs">{placeWords(comment)}</span>
          )}{" "}
          · {who}
        </span>
        <span className="truncate text-row">{comment.body}</span>
        {note === null ? null : <span className="text-meta text-muted-foreground">{note}</span>}
      </button>
    </li>
  );
}

/**
 * Writing a comment on the whole change, in the column: a one-line box until it is used, then the
 * composer with its note under it.
 */
function ChangeComposer({
  draftKey,
  agent,
  onSave,
  touch,
}: {
  readonly draftKey: string;
  readonly agent: string;
  readonly onSave: (body: string) => Promise<unknown>;
  readonly touch: boolean;
}) {
  const [writing, setWriting] = useState(false);
  const [body] = useDraft(draftKey);
  if (!writing && body === "")
    return (
      <button
        type="button"
        onClick={() => setWriting(true)}
        className="mx-2 flex h-9 items-center rounded-lg border border-input px-3 text-left text-row text-muted-foreground outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:h-11"
      >
        Comment on the whole change
      </button>
    );
  return (
    <div className="grid gap-2 px-2">
      <CommentComposer
        label="Comment on the whole change"
        draftKey={draftKey}
        agent={agent}
        onSave={onSave}
        onClose={() => setWriting(false)}
        compact
        touch={touch}
      />
      <p className="text-meta text-muted-foreground">
        A comment here is about the whole change, not one line.
      </p>
    </div>
  );
}

/**
 * Lines to comment on, from the keyboard: the first and last line on the new side, then the box
 * opens on them. Lines outside one changed part of the file are refused in words.
 */
function LineForm({
  file,
  first,
  onStart,
  onCancel,
}: {
  readonly file: string;
  readonly first: number;
  /** False when the lines are not inside one changed part of the file. */
  readonly onStart: (from: number, to: number) => boolean;
  readonly onCancel: () => void;
}) {
  const [from, setFrom] = useState(String(first));
  const [to, setTo] = useState(String(first));
  const [refused, setRefused] = useState(false);
  const escapeCancels = (event: { readonly key: string; preventDefault: () => void }) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };
  return (
    <form
      aria-label={`Comment on lines of ${file}`}
      onSubmit={(event) => {
        event.preventDefault();
        const start = Number(from);
        const end = to.trim() === "" ? start : Number(to);
        setRefused(
          !Number.isInteger(start) || !Number.isInteger(end) || end < start || !onStart(start, end),
        );
      }}
      className="flex flex-wrap items-end gap-3 border-b bg-band px-4 py-3 text-row lg:pl-[46px]"
    >
      <Label className="grid gap-1 text-meta font-normal text-muted-foreground">
        From line
        <Input
          type="number"
          min={1}
          autoFocus
          onKeyDown={escapeCancels}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="w-24 font-mono"
        />
      </Label>
      <Label className="grid gap-1 text-meta font-normal text-muted-foreground">
        To line
        <Input
          type="number"
          min={1}
          value={to}
          onKeyDown={escapeCancels}
          onChange={(event) => setTo(event.target.value)}
          className="w-24 font-mono"
        />
      </Label>
      <Button type="submit" variant="outline" className="max-lg:h-11">
        Write a comment
      </Button>
      <Button type="button" variant="ghost" className="max-lg:h-11" onClick={onCancel}>
        Cancel
      </Button>
      {refused ? (
        <p role="alert" className="basis-full text-meta text-destructive">
          Those lines aren't inside one changed part of this file. Comments go on lines of the
          change as it is now.
        </p>
      ) : null}
    </form>
  );
}

/** What the Change view places for comments; see `useChangeComments`. */
export interface ChangeComments {
  /** Comments and the open box between a file's lines. */
  readonly annotations: (file: ChangeFile) => ReadonlyArray<DiffLineAnnotation<CommentMark>>;
  readonly render: (mark: CommentMark) => ReactNode;
  readonly picking: LinePicking;
  /** A file header's "…": Comment on lines… */
  readonly tools: (file: ChangeFile) => ReactNode;
  /** Under a file's header: the keyboard's line form, then `also` (the tour's note). */
  readonly under: (file: ChangeFile, also: ReactNode) => ReactNode;
  /** The Comments and "Drafts from Mend" sections, under Files. */
  readonly column: ReactNode;
  /** Comments on the whole change, over the diffs. */
  readonly above: ReactNode;
  /** Your review: what Send sends, after the last file. */
  readonly after: ReactNode;
  readonly action: ReactNode;
  readonly note: ReactNode;
  readonly band: ReactNode;
  /** On a phone or in a narrow tile: the comments button and Send, at the foot of the view. */
  readonly bar: ReactNode;
  readonly dialogs: ReactNode;
  /** Open, unsent comments, for anything else in the view that counts them. */
  readonly unsent: number;
}

/** How the view lets the comments move it: show a file (and a target under it), or the top. */
export interface CommentMoves {
  readonly show: (path: string | null, target?: string) => void;
}

/**
 * Comments on a change and sending them to the agent (Doop page 4, "Mend's draft", "Send
 * comments", "Couldn't send", "Second look"): comments on a line, a range or the whole change;
 * Mend's drafts, which reach nobody until a person adds them; and Send, which gives the agent
 * every open comment not sent yet as one message, steering its running turn when it is a
 * conversation (`Choose and edit…` picks the comments and edits the words first). Comments belong
 * to the change, not to one review of it, so a second look keeps them, and their states.
 */
export function useChangeComments({
  detail,
  changeId,
  review,
  fileCount,
  viewedAll,
  comments,
  passes,
  narrow,
  phone,
  moves,
}: {
  readonly detail: SessionDetailDto;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  readonly fileCount: number;
  /** Every file is marked viewed: Your review says so. */
  readonly viewedAll: boolean;
  readonly comments: UseQueryResult<ReadonlyArray<ReviewCommentDto>, unknown>;
  readonly passes: UseQueryResult<ReadonlyArray<ChangePassDto>, unknown>;
  readonly narrow: boolean;
  readonly phone: boolean;
  readonly moves: CommentMoves;
}): ChangeComments {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const viewer = useSuspenseQuery(signedInOptions(trpc));
  const members = useQuery(trpc.organization.members.queryOptions());
  const followUp = useQuery(trpc.sessions.pendingFollowUp.queryOptions({ id: detail.session.id }));
  const agent = harnessName(detail.session.harness);
  const ownerId = detail.session.ownerUserId;
  // The roster only names people; until it answers, or if it can't, the words say "its owner".
  const roster = members.isPending || members.isError ? [] : members.data;
  const ownerName =
    ownerId === null ? null : (roster.find((member) => member.userId === ownerId)?.name ?? null);
  const rule = sendRuleOf(detail, ownerName);
  const scope = { userId: viewer.data.userId, changeId, sliceId: review.slice.id };
  const [openStored, setOpenStored] = useDraft(reviewDraftKey(scope, "open"));
  const composer = parseAnchor(openStored);
  const [lineForm, setLineForm] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [columnOpen, setColumnOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<Attempt | null>(null);
  const touch = phone;

  const all = comments.isSuccess ? comments.data : [];
  const groups = commentGroups(all);
  // Until the server says where a send stands, or if it can't, the view shows none.
  const active = followUp.isPending || followUp.isError ? null : followUp.data;
  const delivery = deliveryOf(active, changeId, failure);

  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.changes.comments.queryFilter({ id: changeId })),
      queryClient.invalidateQueries(
        trpc.sessions.pendingFollowUp.queryFilter({ id: detail.session.id }),
      ),
      queryClient.invalidateQueries(trpc.sessions.detail.queryFilter({ id: detail.session.id })),
    ]);

  const postComment =
    (target: {
      readonly oldPath: string | null;
      readonly newPath: string | null;
      readonly side: "new" | null;
      readonly startLine: number | null;
      readonly endLine: number | null;
      readonly hunkContextHash: string | null;
    }) =>
    async (body: string) => {
      const saved = await client.changes.postSliceComment.mutate({
        id: changeId,
        sliceId: review.slice.id,
        comment: { target, body },
      });
      await queryClient.invalidateQueries(trpc.changes.comments.queryFilter({ id: changeId }));
      return saved;
    };

  const send = useMutation({
    mutationFn: (attempt: Attempt) =>
      client.sessions.deliverFollowUp.mutate({
        id: detail.session.id,
        request: {
          reviewSliceId: review.slice.id,
          checkpointAId: review.checkpointA.id,
          checkpointBId: review.checkpointB.id,
          diffDigest: review.slice.diffDigest,
          commentIds: attempt.commentIds,
          instruction: attempt.instruction,
          idempotencyKey: attempt.idempotencyKey,
        },
      }),
    onMutate: (attempt) => {
      setFailure(null);
      setLastAttempt(attempt);
    },
    onSuccess: (sent) => {
      // Delivered: the agent has the message; the conversation shows it working on it.
      if (sent.status === "delivered") {
        setLastAttempt(null);
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: detail.session.id } });
      }
    },
    onError: (cause) => setFailure(failureWords(cause, "Nothing reached the agent.")),
    onSettled: () => settle(),
  });

  const sendComments = (chosen: ChosenSend) =>
    send.mutate({
      commentIds: chosen.comments.map((comment) => comment.id),
      instruction: chosen.instruction,
      idempotencyKey: `web-follow-up:${changeId}:${uuidV4()}`,
      count: chosen.comments.length,
    });
  const sendAll = () =>
    sendComments({
      comments: groups.unsent,
      instruction: assembleInstruction(
        detail.change?.branch ?? detail.session.branch,
        groups.unsent,
      ),
    });
  // Try again sends the same words under the same key, so a send that did arrive is never doubled.
  const retry = () => {
    const saved =
      delivery.kind === "failed" && delivery.followUp !== null
        ? attemptOf(delivery.followUp)
        : null;
    const again = lastAttempt ?? saved;
    if (again !== null) send.mutate(again);
    else sendAll();
  };

  // Line picking: a click or drag on the new side opens the box there, if the lines are inside
  // one changed part of the file.
  const openComposer = (anchor: LineAnchor) => setOpenStored(JSON.stringify(anchor));
  const closeComposer = () => setOpenStored("");
  const picking: LinePicking = {
    onPick: (file, start, end) => {
      const anchor = anchorFor(review.files, file.path, start, end > start ? end : null);
      if (anchor !== null) openComposer(anchor);
    },
    selected: (file) =>
      composer !== null && composer.file === file.path
        ? { start: composer.line, end: composer.endLine ?? composer.line }
        : null,
  };

  const inLines = (comment: ReviewCommentDto) =>
    comment.file !== null && comment.line !== null && (!isDismissedDraft(comment) || showDismissed);
  const annotations = (file: ChangeFile): ReadonlyArray<DiffLineAnnotation<CommentMark>> => {
    const marks: Array<DiffLineAnnotation<CommentMark>> = all
      .filter((comment) => comment.file === file.path && inLines(comment))
      .map((comment) => ({
        side: "additions",
        // A comment shows under the last of its lines.
        lineNumber: comment.endLine ?? comment.line ?? 0,
        metadata: { kind: "comment", comment },
      }));
    if (composer !== null && composer.file === file.path)
      marks.push({
        side: "additions",
        lineNumber: composer.endLine ?? composer.line,
        metadata: { kind: "composer", anchor: composer },
      });
    return marks;
  };
  const render = (mark: CommentMark): ReactNode =>
    mark.kind === "comment" ? (
      <ReviewComment comment={mark.comment} place="line" touch={touch} />
    ) : (
      <div data-composer className="border-y bg-band py-3 pr-6 pl-4 lg:pl-[112px]">
        <CommentComposer
          key={anchorKey(mark.anchor)}
          label={`Comment on ${mark.anchor.file}, ${lineLabel(mark.anchor.line, mark.anchor.endLine) === `${mark.anchor.line}` ? "line" : "lines"} ${lineLabel(mark.anchor.line, mark.anchor.endLine) ?? ""}`}
          heading={
            <p className="flex items-center gap-2 text-control">
              <b className="font-semibold">
                {roster.find((member) => member.userId === viewer.data.userId)?.name ?? "You"}
              </b>
              <span className="text-meta text-muted-foreground">
                {mark.anchor.endLine === null
                  ? `Line ${mark.anchor.line}`
                  : `Lines ${lineLabel(mark.anchor.line, mark.anchor.endLine)}`}
              </span>
            </p>
          }
          draftKey={reviewDraftKey(scope, anchorKey(mark.anchor))}
          agent={agent}
          touch={touch}
          onClose={closeComposer}
          onSave={postComment({
            oldPath: mark.anchor.oldPath,
            newPath: mark.anchor.newPath,
            side: "new",
            startLine: mark.anchor.line,
            endLine: mark.anchor.endLine ?? mark.anchor.line,
            hunkContextHash: mark.anchor.hunkContextHash,
          })}
        />
      </div>
    );

  const firstLine = (path: string): number =>
    review.files
      .find((file) => (file.newPath ?? file.oldPath) === path)
      ?.hunks.find((hunk) => hunk.newLines > 0)?.newStart ?? 1;
  const tools = (file: ChangeFile): ReactNode =>
    file.binary ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size={touch ? "icon-touch" : "icon-sm"}
              aria-label={`Actions for ${file.path}`}
              className="text-muted-foreground"
            >
              <EllipsisIcon aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" width="sm">
          <DropdownMenuItem onClick={() => setLineForm(file.path)}>
            Comment on lines…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  const under = (file: ChangeFile, also: ReactNode): ReactNode => (
    <>
      {lineForm !== file.path ? null : (
        <LineForm
          file={file.path}
          first={firstLine(file.path)}
          onCancel={() => setLineForm(null)}
          onStart={(from, to) => {
            const anchor = anchorFor(review.files, file.path, from, to > from ? to : null);
            if (anchor === null) return false;
            setLineForm(null);
            openComposer(anchor);
            moves.show(file.path, "[data-composer]");
            return true;
          }}
        />
      )}
      {also}
    </>
  );

  const showComment = (comment: ReviewCommentDto) => {
    setColumnOpen(false);
    if (isDismissedDraft(comment)) setShowDismissed(true);
    moves.show(comment.file, `[data-comment="${comment.id}"]`);
  };
  const failedIds =
    delivery.kind === "failed"
      ? new Set(delivery.followUp?.commentIds ?? lastAttempt?.commentIds ?? [])
      : new Set<string>();
  const rowNote = (comment: ReviewCommentDto): string | null => {
    if (failedIds.has(comment.id)) return "Couldn't send";
    if (comment.sentToSessionId !== null || comment.state !== "open") return stateWords(comment);
    return null;
  };

  // Mend's passes: reading the change drafts findings; suggesting drafts replacements.
  const read = passOf(passes.isSuccess ? passes.data : [], "read");
  const suggest = passOf(passes.isSuccess ? passes.data : [], "suggest");
  const settlePasses = () =>
    queryClient.invalidateQueries(trpc.changes.passes.queryFilter({ id: changeId }));
  const [passFailure, setPassFailure] = useState<string | null>(null);
  const queueRead = useMutation({
    mutationFn: () => client.changes.queueRead.mutate({ id: changeId }),
    onMutate: () => setPassFailure(null),
    onError: (cause) =>
      setPassFailure(`Mend didn't start reading. ${failureWords(cause, "Try again.")}`),
    onSettled: settlePasses,
  });
  const queueSuggest = useMutation({
    mutationFn: () => client.changes.queueSuggest.mutate({ id: changeId }),
    onMutate: () => setPassFailure(null),
    onError: (cause) =>
      setPassFailure(`Mend didn't start looking for fixes. ${failureWords(cause, "Try again.")}`),
    onSettled: settlePasses,
  });
  const reading = queueRead.isPending || passBusy(read);
  const suggesting = queueSuggest.isPending || passBusy(suggest);
  const passLines = passWords(read, suggest, new Date());

  const commentsFact =
    groups.comments.length === 0
      ? "None yet"
      : groups.unsent.length > 0
        ? `${groups.unsent.length.toLocaleString("en")} not sent`
        : `${groups.comments.filter((comment) => comment.state === "open").length.toLocaleString("en")} open`;
  const shownDrafts = showDismissed ? [...groups.drafts, ...groups.dismissedDrafts] : groups.drafts;

  const column = (
    <>
      <section aria-label="Comments" className="grid gap-2 border-t px-3 py-4">
        <SectionTitle title="Comments" fact={commentsFact} />
        {comments.isError ? (
          <p className="px-2 text-meta text-destructive">
            Mend couldn't read the comments.{" "}
            <Button
              variant="link"
              className="h-auto p-0 text-meta"
              onClick={() => void comments.refetch()}
            >
              Try again
            </Button>
          </p>
        ) : comments.isPending ? (
          <p role="status" className="px-2 text-meta text-muted-foreground">
            Reading the comments…
          </p>
        ) : groups.comments.length === 0 ? null : (
          <ul className="grid gap-0.5">
            {groups.comments.map((comment) => (
              <ColumnRow
                key={comment.id}
                comment={comment}
                note={rowNote(comment)}
                onShow={showComment}
              />
            ))}
          </ul>
        )}
        <ChangeComposer
          draftKey={reviewDraftKey(scope, "whole")}
          agent={agent}
          touch={touch}
          onSave={postComment({
            oldPath: null,
            newPath: null,
            side: null,
            startLine: null,
            endLine: null,
            hunkContextHash: null,
          })}
        />
        {rule.can || groups.unsent.length === 0 ? null : (
          <p className="mx-2 border-l-2 border-info pl-3 text-meta text-muted-foreground">
            {rule.why}
          </p>
        )}
      </section>
      <section aria-label="Drafts from Mend" className="grid gap-2 border-t px-3 py-4">
        <SectionTitle title="Drafts from Mend" fact={String(groups.drafts.length)} />
        {shownDrafts.length === 0 ? null : (
          <ul className="grid gap-0.5">
            {shownDrafts.map((comment) => (
              <ColumnRow
                key={comment.id}
                comment={comment}
                note={comment.state === "dismissed" ? "Dismissed" : null}
                onShow={showComment}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-1.5 px-2 text-meta text-muted-foreground">
          {passLines.map((line) => (
            <p key={line.text} className={cn(line.failed && "text-destructive")}>
              {line.text}
            </p>
          ))}
          {groups.drafts.length > 0 ? (
            <p>Drafts only go to {agent} if you add them to your comments.</p>
          ) : null}
          {groups.dismissedDrafts.length > 0 && !showDismissed ? (
            <p>
              You dismissed {countWords(groups.dismissedDrafts.length, "draft", "drafts")}.{" "}
              <Button
                variant="link"
                className="h-auto p-0 text-meta text-info"
                onClick={() => setShowDismissed(true)}
              >
                {groups.dismissedDrafts.length === 1 ? "Show it" : "Show them"}
              </Button>
            </p>
          ) : null}
          {read === null && suggest === null && groups.drafts.length === 0 ? (
            <p>
              Mend can read the change against what the session did and draft comments for you to
              keep or drop.
            </p>
          ) : null}
          {passFailure === null ? null : (
            <p role="alert" className="text-destructive">
              {passFailure}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 px-2">
          <Button
            variant="outline"
            size={touch ? "touch" : "sm"}
            disabled={reading || passes.isPending}
            onClick={() => queueRead.mutate()}
          >
            {reading ? "Reading…" : "Read this change"}
          </Button>
          <Button
            variant="ghost"
            size={touch ? "touch" : "sm"}
            disabled={suggesting || passes.isPending}
            onClick={() => queueSuggest.mutate()}
          >
            {suggesting ? "Looking for fixes…" : "Suggest fixes"}
          </Button>
        </div>
      </section>
    </>
  );

  // Comments on the whole change, over the diffs, where their states are changed.
  const changeLevel = all.filter(
    (comment) => comment.file === null && (!isDismissedDraft(comment) || showDismissed),
  );
  const above =
    changeLevel.length === 0 ? null : (
      <section aria-label="On the whole change" className="border-b bg-band pt-3">
        <h3 className="px-6 text-meta text-muted-foreground">On the whole change</h3>
        <div className="divide-y">
          {changeLevel.map((comment) => (
            <ReviewComment key={comment.id} comment={comment} place="change" touch={touch} />
          ))}
        </div>
      </section>
    );

  // What Send sends, after the last file: once every file is viewed this is where the eye lands.
  const toSend =
    delivery.kind === "failed" && delivery.followUp !== null
      ? commentsOf(delivery.followUp, all)
      : groups.unsent;
  const after =
    toSend.length === 0 || !rule.can ? null : (
      <section aria-label="Your review" className="border-b px-4 py-6 lg:px-11">
        <h3 className="text-lead font-semibold">Your review</h3>
        <p className="mt-1 text-prose text-muted-foreground">
          {viewedAll ? `You've viewed all ${countWords(fileCount, "file", "files")}. ` : ""}
          {agent} gets {toSend.length === 1 ? "this comment" : `these ${toSend.length} comments`} as
          one message, with the file and line for each.
        </p>
        <ul className="mt-4 max-w-[968px] divide-y border-y">
          {toSend.map((comment) => (
            <li key={comment.id} className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[200px_1fr]">
              <span className="text-meta text-muted-foreground">
                {comment.file === null ? (
                  "Whole change"
                ) : (
                  <span className="font-mono text-2xs">{placeLongWords(comment)}</span>
                )}
              </span>
              <span className="text-prose">
                {comment.body}
                {failedIds.has(comment.id) ? (
                  <span className="block text-meta text-muted-foreground">Couldn't send</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {delivery.kind === "none" && groups.unsent.length > 0 ? (
          <Button
            variant="link"
            className="mt-3 h-auto p-0 text-info"
            onClick={() => setChoosing(true)}
          >
            Choose and edit before sending…
          </Button>
        ) : null}
      </section>
    );

  const sending = send.isPending;
  const sendLabel = (short: boolean) =>
    sending
      ? "Sending…"
      : short
        ? `Send ${countWords(groups.unsent.length, "comment", "comments")}`
        : `Send ${countWords(groups.unsent.length, "comment", "comments")} to ${agent}`;
  const canSend = rule.can && groups.unsent.length > 0 && delivery.kind === "none";
  const action =
    !canSend || narrow ? null : (
      <Button disabled={sending} onClick={sendAll}>
        {sendLabel(false)}
      </Button>
    );

  const finished = !agentIsLive(detail.session, detail.currentAgent);
  const note =
    delivery.kind === "failed"
      ? `${countWords(toSend.length, "comment", "comments")} not sent`
      : rule.can
        ? toolbarNoteWords(agent, groups, finished)
        : rule.why;

  const live = agentIsLive(detail.session, detail.currentAgent);
  const bandLayout = narrow ? "stacked" : "inline";
  const bandSize = narrow ? "touch" : "sm";
  const band =
    delivery.kind === "failed" ? (
      <Banner
        tone="error"
        layout={bandLayout}
        title={
          delivery.followUp !== null
            ? `Mend couldn't send your comments. Nothing reached ${agent}.`
            : "Mend couldn't send your comments."
        }
        actions={
          rule.can ? (
            <Button
              size={bandSize}
              disabled={sending}
              onClick={retry}
              className={cn(narrow && "w-full")}
            >
              {sending ? "Sending…" : "Try again"}
            </Button>
          ) : undefined
        }
      >
        {delivery.reason === null ? "" : `${delivery.reason} `}
        {toSend.length === 1
          ? "Your comment is still here, so you can send it again."
          : `Your ${toSend.length} comments are still here, so you can send them again.`}
      </Banner>
    ) : delivery.kind === "pending" ? (
      <Banner
        tone="info"
        layout={bandLayout}
        title="Your comments are saved, not sent yet."
        actions={
          rule.can && !live ? (
            <Button
              size={bandSize}
              disabled={sending}
              onClick={() => {
                const again = attemptOf(delivery.followUp);
                if (again !== null) send.mutate(again);
              }}
              className={cn(narrow && "w-full")}
            >
              {sending ? "Sending…" : "Send now"}
            </Button>
          ) : undefined
        }
      >
        {live
          ? `${agent} is still running in its terminal, so Mend kept ${countWords(delivery.followUp.commentIds.length, "comment", "comments")} for it. Send them once it stops.`
          : `${agent} has stopped, so it can take ${delivery.followUp.commentIds.length === 1 ? "it" : "them"} now.`}
      </Banner>
    ) : delivery.kind === "delivering" ? (
      <Banner
        tone="info"
        layout={bandLayout}
        title={`Sending your comments to ${agent}…`}
        actions={
          rule.can ? (
            <Button
              variant="outline"
              size={bandSize}
              disabled={sending}
              onClick={() => {
                const again = attemptOf(delivery.followUp);
                if (again !== null) send.mutate(again);
              }}
              className={cn(narrow && "w-full")}
            >
              {sending ? "Checking…" : "Check again"}
            </Button>
          ) : undefined
        }
      >
        Mend has started the delivery and is waiting to hear that {agent} has the message.
      </Banner>
    ) : null;

  const bar = !narrow ? null : (
    <div className="flex shrink-0 gap-2 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <Button
        variant="outline"
        size="icon-touch"
        aria-label={`Comments and Mend's drafts${groups.unsent.length > 0 ? `, ${groups.unsent.length} not sent` : ""}`}
        onClick={() => setColumnOpen(true)}
      >
        <MessageSquarePlusIcon aria-hidden />
      </Button>
      {canSend ? (
        <Button size="touch" className="flex-1" disabled={sending} onClick={sendAll}>
          {sendLabel(true)}
        </Button>
      ) : null}
    </div>
  );

  const dialogs = (
    <>
      <SendDialog
        open={choosing}
        onOpenChange={setChoosing}
        comments={groups.unsent}
        branch={detail.change?.branch ?? detail.session.branch}
        agent={agent}
        onSend={sendComments}
      />
      {narrow ? (
        <Overlay
          open={columnOpen}
          onOpenChange={setColumnOpen}
          size="md"
          title="Comments"
          description={note}
          footer={null}
        >
          <div className="-mx-3">{column}</div>
        </Overlay>
      ) : null}
    </>
  );

  return {
    annotations,
    render,
    picking,
    tools,
    under,
    column,
    above,
    after,
    action,
    note,
    band,
    bar,
    dialogs,
    unsent: groups.unsent.length,
  };
}
