// Review, phone-sized but whole (plan §7.4): the description leads the way
// a PR body leads a PR, the tour walks the diff from a bottom dock, comments
// anchor to a tapped line or to the change as a whole, and the open ones
// assemble into a follow-up instruction the reviewer edits before sending.
// The web review (routes/changes.$changeId.tsx) is the parity reference.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { BASE_LINE_H, CodeChunk, parseFiles, TOTAL_BUDGET, type DiffRow } from "@/components/diff";
import { Panel, PanelRow } from "@/components/panel";
import { CommentCard } from "@/components/review-comment";
import { ScreenHeader, SectionLabel } from "@/components/screen";
import { BodyText, MonoText, UiText, useTextScale } from "@/components/typography";
import {
  agentIsActive,
  canDeliverFollowUp,
  usePendingFollowUp,
  useSession,
  useSessionActions,
  type SessionChangeDto,
} from "@/data/live";
import {
  CHANGE_LEVEL_TARGET,
  resetOpenReview,
  useChangeComments,
  useChangePasses,
  useChangeTour,
  useOpenReview,
  useReviewActions,
  useReviewDiff,
  useSendReview,
  type ChangePassDto,
  type ChangeTourDto,
  type ReviewCommentDto,
  type ReviewSliceDto,
  type SliceCommentTarget,
} from "@/data/review";
import { sha256Hex } from "@/lib/sha256";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

// Diff parsing and the row renderer live in components/diff.tsx, shared with
// the plain Diff screen.

/** Estimated file-header height, for scroll-to-stop math. */
const HEADER_H = 34;

// ─── the follow-up instruction (ported verbatim from the web review) ────────

const assembleInstruction = (
  change: SessionChangeDto,
  comments: ReadonlyArray<ReviewCommentDto>,
) => {
  const points = comments
    .map((comment, index) => {
      const anchor =
        comment.file === null
          ? "the change as a whole"
          : `${comment.file}${comment.line === null ? "" : `:${comment.line}${comment.endLine === null || comment.endLine === comment.line ? "" : `-${comment.endLine}`}`}`;
      const proposal =
        comment.suggestion === null
          ? ""
          : `\n   Proposed replacement:\n${comment.suggestion
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}`;
      return `${index + 1}. ${anchor} — ${comment.body}${proposal}`;
    })
    .join("\n");
  return `This is a follow-up on your earlier work in this worktree, responding to review feedback. The branch ${change.branch} is already checked out with your work on it: keep working there, and do not start a new branch or reset it.

Review comments:
${points}

Address each point using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Report honestly what you changed and what you did not — if a point cannot or should not be done, say so plainly.`;
};

// ─── pieces ─────────────────────────────────────────────────────────────────

/**
 * What ran over this change, said out loud (one line per recorded pass):
 * "completed, drafted nothing" and "never ran" must never look the same.
 */
function PassOutcomeLine({ pass }: { readonly pass: ChangePassDto }) {
  const label = pass.kind === "suggest" ? "suggestions" : "findings";
  const at = new Date(pass.finishedAt ?? pass.startedAt).toLocaleTimeString();
  if (pass.status === "queued") {
    return (
      <MonoText size={11} tone="label">
        {label} · queued {at}
      </MonoText>
    );
  }
  if (pass.status === "running") {
    return (
      <MonoText size={11} tone="label">
        {label} · running · started {at}
      </MonoText>
    );
  }
  if (pass.status === "failed") {
    return (
      <MonoText size={11} tone="danger">
        {label} · failed {at} · {(pass.detail ?? "no detail recorded").slice(0, 160)}
      </MonoText>
    );
  }
  return (
    <MonoText size={11} tone="faint">
      {label} · completed {at} ·{" "}
      {pass.findings === null || pass.findings === 0 ? (
        "none"
      ) : (
        <MonoText size={11} tone="ink2">
          {pass.findings} draft{pass.findings === 1 ? "" : "s"} below
        </MonoText>
      )}
    </MonoText>
  );
}

/**
 * The change's description at the head of the review, the way a PR body
 * heads a PR: what the change IS (the tour's summary), how the session got
 * there (from the record), and the entry into the guided walk. The tour
 * stamps the diff it read; when the worktree moved on, say so honestly.
 */
function DescriptionCard({
  tour,
  pass,
  stale,
  inFlight,
  canCompose,
  onCompose,
  onStartTour,
}: {
  readonly tour: ChangeTourDto | null;
  readonly pass: ChangePassDto | null;
  readonly stale: boolean;
  readonly inFlight: boolean;
  readonly canCompose: boolean;
  readonly onCompose: () => void;
  readonly onStartTour: () => void;
}) {
  if (tour === null && !canCompose) return null;
  const failedDetail = pass?.status === "failed" ? (pass.detail ?? "the pass failed") : null;
  const queued = pass?.status === "queued";
  return (
    <Panel>
      <PanelRow first>
        {tour === null ? (
          <View style={{ gap: 10 }}>
            {queued ? (
              <UiText size={13} tone="muted">
                Description & tour queued
              </UiText>
            ) : inFlight ? (
              <UiText size={13} tone="muted">
                Composing the description and tour…
              </UiText>
            ) : failedDetail !== null ? (
              <UiText size={13} tone="danger">
                Description & tour failed ·{" "}
                <MonoText size={11}>{failedDetail.slice(0, 200)}</MonoText>
              </UiText>
            ) : (
              <UiText size={13} tone="muted">
                No description yet. Composed when a session settles, or on demand.
              </UiText>
            )}
            <View style={{ flexDirection: "row" }}>
              <EvButton
                size="sm"
                variant="outline"
                disabled={inFlight}
                label={
                  queued
                    ? "Queued"
                    : inFlight
                      ? "Composing…"
                      : failedDetail !== null
                        ? "Retry"
                        : "Compose description & tour"
                }
                onPress={onCompose}
              />
            </View>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <MonoText size={10.5} tone="label">
              description · composed {new Date(tour.createdAt).toLocaleTimeString()} ·{" "}
              {tour.stops.length} stop{tour.stops.length === 1 ? "" : "s"}
              {stale && (
                <MonoText size={10.5} tone="warning">
                  {" "}
                  · diff changed since
                </MonoText>
              )}
            </MonoText>
            <BodyText>{tour.summary}</BodyText>
            {tour.approach !== null && (
              <UiText size={13} tone="muted" style={{ lineHeight: 19 }}>
                <MonoText size={10.5} tone="label">
                  from the record ·{" "}
                </MonoText>
                {tour.approach}
              </UiText>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <EvButton size="sm" label="Tour this change →" onPress={onStartTour} />
              {stale && (
                <EvButton
                  size="sm"
                  variant="ghost"
                  disabled={inFlight}
                  label={inFlight ? "Recomposing…" : "Recompose"}
                  onPress={onCompose}
                />
              )}
            </View>
          </View>
        )}
      </PanelRow>
    </Panel>
  );
}

/**
 * The walking surface, docked at the thumb: stop N/M with its anchor and an
 * honest "inferred reading" when ungrounded, the narration, evidence into
 * the record, and Prev/Next/End. The anchored region is edge-marked in the
 * diff above and scrolled into view.
 */
function TourDock({
  tour,
  index,
  onGo,
  onEnd,
}: {
  readonly tour: ChangeTourDto;
  readonly index: number;
  readonly onGo: (index: number) => void;
  readonly onEnd: () => void;
}) {
  const { colors, shadow } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const stop = tour.stops[index];
  if (stop === undefined) return null;
  const anchor = `stop ${index + 1}/${tour.stops.length}${stop.file === null ? "" : ` · ${stop.file}`}${
    stop.line === null
      ? ""
      : `:${stop.line}${stop.endLine === null || stop.endLine === stop.line ? "" : `–${stop.endLine}`}`
  }${stop.grounded ? "" : " · inferred reading"}`;
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.panel,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.softRule,
        boxShadow: shadow.sm,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: insets.bottom + 10,
        gap: 6,
      }}
    >
      <MonoText size={10.5} tone="label" numberOfLines={1}>
        {anchor}
      </MonoText>
      <UiText weight="medium" size={14}>
        {stop.title}
      </UiText>
      <UiText size={13} tone="ink2" numberOfLines={6} style={{ lineHeight: 18 }}>
        {stop.narration}
      </UiText>
      {stop.evidence.map((link, evidenceIndex) => (
        <MonoText key={evidenceIndex} size={10.5} tone="faint" numberOfLines={1}>
          seq {link.sequence} · {link.excerpt}
        </MonoText>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 }}>
        <EvButton
          size="sm"
          variant="outline"
          label="← Prev"
          disabled={index === 0}
          onPress={() => onGo(index - 1)}
        />
        <EvButton
          size="sm"
          variant="outline"
          label="Next →"
          disabled={index >= tour.stops.length - 1}
          onPress={() => onGo(index + 1)}
        />
        <View style={{ flex: 1 }} />
        <EvButton size="sm" variant="ghost" label="End tour" onPress={onEnd} />
      </View>
    </View>
  );
}

/** One composer for both anchors: a tapped line, or the change as a whole. */
function CommentComposer({
  changeId,
  sliceId,
  target,
  placeholder,
  autoFocus = false,
  onDone,
}: {
  readonly changeId: string;
  readonly sliceId: string;
  readonly target: SliceCommentTarget;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
  readonly onDone?: () => void;
}) {
  const { colors } = useEvidenceTheme();
  const { comment } = useReviewActions(changeId);
  const [body, setBody] = useState("");
  const anchorPath = target.side === "old" ? target.oldPath : (target.newPath ?? target.oldPath);
  const submit = () => {
    const text = body.trim();
    if (text === "") return;
    comment.mutate(
      { sliceId, target, body: text },
      {
        onSuccess: () => {
          setBody("");
          onDone?.();
        },
      },
    );
  };
  return (
    <View style={{ gap: 8 }}>
      {anchorPath !== null && target.startLine !== null && (
        <MonoText size={10.5} tone="label" numberOfLines={1}>
          {anchorPath}:{target.startLine}
        </MonoText>
      )}
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        multiline
        autoFocus={autoFocus}
        style={{
          minHeight: 60,
          textAlignVertical: "top",
          backgroundColor: colors.bg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.rule,
          borderRadius: radius.lg,
          paddingHorizontal: 12,
          paddingVertical: 9,
          color: colors.ink,
          fontSize: 14,
        }}
      />
      {comment.isError && (
        <UiText size={12} tone="danger">
          {comment.error instanceof Error ? comment.error.message : "the comment failed to save"}
        </UiText>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        {onDone !== undefined && (
          <EvButton size="sm" variant="ghost" label="Cancel" onPress={onDone} />
        )}
        <EvButton
          size="sm"
          label={comment.isPending ? "…" : "Comment"}
          disabled={comment.isPending || body.trim() === ""}
          onPress={submit}
        />
      </View>
    </View>
  );
}

/** The plan's rule (§7.3): the user inspects and edits the instruction before sending. */
function SendReviewModal({
  change,
  comments,
  slice,
  onClose,
}: {
  readonly change: SessionChangeDto;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly slice: ReviewSliceDto;
  readonly onClose: () => void;
}) {
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const send = useSendReview(
    change.id,
    change.sessionId,
    comments.map((comment) => comment.id),
    slice,
  );
  const [instruction, setInstruction] = useState(() => assembleInstruction(change, comments));
  const [sentStatus, setSentStatus] = useState<string | null>(null);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{
            padding: 20,
            paddingTop: Platform.OS === "ios" ? 24 : insets.top + 16,
            paddingBottom: 48,
            gap: 12,
          }}
        >
          {sentStatus !== null ? (
            <>
              <UiText weight="medium" size={16}>
                {sentStatus === "delivered"
                  ? "Review delivered"
                  : "Follow-up saved for the session"}
              </UiText>
              <UiText size={13.5} tone="muted" style={{ lineHeight: 20 }}>
                {sentStatus === "delivered"
                  ? "The session accepted the instruction. The comments stay open until the work addresses them."
                  : "The instruction is pinned to this Review. Deliver it from the session once the current agent stops."}
              </UiText>
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <EvButton label="Done" onPress={onClose} />
              </View>
            </>
          ) : (
            <>
              <UiText weight="medium" size={16}>
                Send review to the session
              </UiText>
              <MonoText size={11} tone="faint">
                assembled from {comments.length} comment{comments.length === 1 ? "" : "s"} · resumes{" "}
                {change.branch}
              </MonoText>
              <UiText size={12} weight="medium" tone="label">
                Instruction — edit before sending
              </UiText>
              <TextInput
                value={instruction}
                onChangeText={setInstruction}
                multiline
                style={{
                  minHeight: 280,
                  textAlignVertical: "top",
                  backgroundColor: colors.panel,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.rule,
                  borderRadius: radius.lg,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  color: colors.ink,
                  fontSize: 13.5,
                  lineHeight: 19,
                }}
              />
              <MonoText size={10.5} tone="faint">
                assembled mechanically from your comments; edit freely — what you send is verbatim
                what the session receives
              </MonoText>
              {send.isError && (
                <UiText size={12.5} tone="danger">
                  {send.error instanceof Error ? send.error.message : "the send failed"}
                </UiText>
              )}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                <EvButton variant="ghost" label="Cancel" onPress={onClose} />
                <EvButton
                  label={send.isPending ? "Sending…" : "Send to session"}
                  disabled={send.isPending || instruction.trim() === ""}
                  onPress={() =>
                    send.mutate(instruction, {
                      onSuccess: (followUp) => setSentStatus(followUp.status),
                    })
                  }
                />
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── the screen ─────────────────────────────────────────────────────────────

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const changeId = id ?? null;
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const textScale = useTextScale();
  const queryClient = useQueryClient();
  const lineH = Math.round(BASE_LINE_H * textScale);

  // The review renders a pinned slice (plan §7.3), the same way the web
  // review does: comments and the follow-up anchor to the slice's patch and
  // digest, never to the worktree that keeps moving underneath.
  const openQuery = useOpenReview(changeId);
  const slice = openQuery.data?.slice ?? null;
  const reviewQuery = useReviewDiff(changeId, slice?.id ?? null);
  const review = reviewQuery.data ?? null;
  const change = review?.change ?? null;
  const stats = (review?.files ?? []).map((file) => ({
    path: file.newPath ?? file.oldPath ?? "unknown path",
    additions: file.additions,
    deletions: file.deletions,
  }));
  const diffText = review?.patch ?? "";
  const reviewLoading = openQuery.isLoading || reviewQuery.isLoading;
  const comments = useChangeComments(changeId).data ?? [];
  const tour = useChangeTour(changeId).data ?? null;
  const passes = useChangePasses(changeId).data ?? [];
  const { queuePass } = useReviewActions(changeId ?? "");

  const sessionId = change?.sessionId ?? null;
  const sessionDetail = useSession(sessionId).data;
  const session = sessionDetail?.session;
  const sessionActive = agentIsActive(session, sessionDetail?.currentAgent ?? null);
  const followUp = usePendingFollowUp(sessionId ?? undefined).data ?? null;
  const { deliverFollowUp } = useSessionActions();

  const files = useMemo(() => parseFiles(diffText), [diffText]);
  // Past the render budget, later files start collapsed — a header with its
  // counts is still the whole story until the reviewer opens it.
  const defaultCollapsed = useMemo(() => {
    const set = new Set<string>();
    let used = 0;
    files.forEach((file, index) => {
      if (index > 0 && used + file.rows.length > TOTAL_BUDGET) set.add(file.path);
      else used += file.rows.length;
    });
    return set;
  }, [files]);
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const isCollapsed = (path: string) => collapsedOverride[path] ?? defaultCollapsed.has(path);

  const [composerAnchor, setComposerAnchor] = useState<SliceCommentTarget | null>(null);

  // The comment anchor the server verifies: the slice file's hunk that covers
  // the tapped new-file line, carrying that hunk's context hash (web parity).
  const anchorFor = (path: string, line: number): SliceCommentTarget | null => {
    const reviewFile = (review?.files ?? []).find(
      (candidate) => (candidate.newPath ?? candidate.oldPath) === path,
    );
    if (reviewFile === undefined) return null;
    const hunk = reviewFile.hunks.find(
      (candidate) =>
        candidate.newLines > 0 &&
        line >= candidate.newStart &&
        line <= candidate.newStart + candidate.newLines - 1,
    );
    if (hunk === undefined) return null;
    return {
      oldPath: reviewFile.oldPath,
      newPath: reviewFile.newPath,
      side: "new",
      startLine: line,
      endLine: line,
      hunkContextHash: hunk.contextHash,
    };
  };
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const fileTops = useRef<Map<string, number>>(new Map());

  // The tour stamps the diff it read (sha256); hash what the phone shows and
  // say when they differ. Keyed by digest + length — a same-length rewrite is
  // caught on the next mount rather than live; the honest marker still beats
  // silently guiding through a stale map.
  const tourDigest = tour?.diffDigest ?? "";
  const staleQuery = useQuery({
    queryKey: ["change", changeId, "tour-freshness", tourDigest, diffText.length],
    enabled: tour !== null && diffText !== "",
    queryFn: () => sha256Hex(diffText) !== tourDigest,
  });
  const stale = staleQuery.data === true;

  const passOf = (kind: ChangePassDto["kind"]) => passes.find((pass) => pass.kind === kind) ?? null;
  const tourPass = passOf("tour");
  const readPass = passOf("read");
  const suggestPass = passOf("suggest");
  // Queued and running both hold the button: the pass is waiting for a worker or composing.
  const composing =
    (queuePass.isPending && queuePass.variables === "tour") ||
    tourPass?.status === "running" ||
    tourPass?.status === "queued";

  const additions = stats.reduce((sum, file) => sum + file.additions, 0);
  const deletions = stats.reduce((sum, file) => sum + file.deletions, 0);
  const openUnsent = comments.filter(
    (comment) => comment.state === "open" && comment.sentToSessionId === null,
  );
  const changeLevel = comments.filter((comment) => comment.file === null);
  const outcomeLines = passes.filter((pass) => pass.kind !== "tour");

  const goToStop = (index: number) => {
    if (tour === null) return;
    const stop = tour.stops[index];
    if (stop === undefined) return;
    setTourIndex(index);
    if (stop.file === null) return;
    const path = stop.file;
    const file = files.find((candidate) => candidate.path === path);
    const wasCollapsed = isCollapsed(path);
    if (wasCollapsed) setCollapsedOverride((previous) => ({ ...previous, [path]: false }));
    const rowIndex =
      stop.line === null ? -1 : (file?.rows.findIndex((row) => row.newLine === stop.line) ?? -1);
    // Comment cards above the stop shift this estimate; close enough to land
    // the region on screen, and the accent edge marks the exact lines.
    setTimeout(
      () => {
        const top = fileTops.current.get(path);
        if (top === undefined) return;
        const y = top + HEADER_H + (rowIndex >= 0 ? rowIndex * lineH : 0) - 120;
        scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
      },
      wasCollapsed ? 250 : 50,
    );
  };

  const activeStop = tour !== null && tourIndex !== null ? (tour.stops[tourIndex] ?? null) : null;

  if (changeId === null) return null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          refreshControl={
            <RefreshControl
              refreshing={openQuery.isRefetching || reviewQuery.isRefetching}
              onRefresh={() => {
                // Reopen the review at the current worktree — the pinned
                // slice never changes underneath the reviewer on its own.
                resetOpenReview(changeId);
                void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
              }}
            />
          }
          contentContainerStyle={{
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: 20,
            paddingBottom: spacing.xl2 + insets.bottom + (tourIndex !== null ? 220 : 0),
            gap: spacing.lg,
          }}
        >
          <ScreenHeader
            eyebrow="review"
            title={
              change === null ? "The change" : change.branch.replace(/^mend\/session\//, "session ")
            }
            meta={
              change === null
                ? "reading the worktree…"
                : `worktree vs ${change.baseSha.slice(0, 12)} · ${stats.length} file${stats.length === 1 ? "" : "s"} · +${additions} −${deletions} · ${openUnsent.length} open comment${openUnsent.length === 1 ? "" : "s"}`
            }
          />

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <EvButton
              size="sm"
              variant="outline"
              label={
                suggestPass?.status === "running"
                  ? "Running…"
                  : suggestPass?.status === "queued"
                    ? "Queued"
                    : "Suggest fixes"
              }
              disabled={
                stats.length === 0 ||
                suggestPass?.status === "running" ||
                suggestPass?.status === "queued" ||
                (queuePass.isPending && queuePass.variables === "suggest")
              }
              onPress={() => queuePass.mutate("suggest")}
            />
            <EvButton
              size="sm"
              variant="outline"
              label={
                readPass?.status === "running"
                  ? "Running…"
                  : readPass?.status === "queued"
                    ? "Queued"
                    : "Read this change"
              }
              disabled={
                readPass?.status === "running" ||
                readPass?.status === "queued" ||
                (queuePass.isPending && queuePass.variables === "read")
              }
              onPress={() => queuePass.mutate("read")}
            />
            <EvButton
              size="sm"
              label="Send review"
              disabled={openUnsent.length === 0}
              onPress={() => setSendOpen(true)}
            />
          </View>

          {queuePass.isError && (
            <MonoText size={10.5} tone="danger">
              {queuePass.error instanceof Error
                ? queuePass.error.message
                : "the pass could not be queued"}
            </MonoText>
          )}

          {review?.worktreeChangedSinceSnapshot === true && (
            <MonoText size={10.5} tone="warning">
              the worktree moved since this review opened — pull to refresh
            </MonoText>
          )}

          {outcomeLines.length > 0 && (
            <View style={{ gap: 2 }}>
              {outcomeLines.map((pass) => (
                <PassOutcomeLine key={pass.kind} pass={pass} />
              ))}
            </View>
          )}

          {followUp !== null && (
            <Panel>
              <PanelRow first>
                <View style={{ gap: 8 }}>
                  <MonoText size={10.5} tone="label">
                    follow-up · {followUp.status.replaceAll("_", " ")}
                  </MonoText>
                  <UiText size={13} tone="ink2" numberOfLines={3} style={{ lineHeight: 18 }}>
                    {followUp.instruction}
                  </UiText>
                  {followUp.deliveryError === null ? null : (
                    <MonoText size={10.5} tone="danger">
                      {followUp.deliveryError}
                    </MonoText>
                  )}
                  {deliverFollowUp.isError ? (
                    <MonoText size={10.5} tone="danger">
                      {deliverFollowUp.error.message}
                    </MonoText>
                  ) : null}
                  {session !== undefined && !sessionActive && canDeliverFollowUp(followUp) ? (
                    <View style={{ flexDirection: "row" }}>
                      <EvButton
                        size="sm"
                        variant="outline"
                        disabled={deliverFollowUp.isPending}
                        label={
                          deliverFollowUp.isPending
                            ? "delivering…"
                            : followUp.status === "delivery_failed"
                              ? "Retry delivery"
                              : "Deliver & relaunch"
                        }
                        onPress={() => deliverFollowUp.mutate(followUp)}
                      />
                    </View>
                  ) : (
                    <MonoText size={10.5} tone="faint">
                      {sessionActive
                        ? "the session is live — deliver after it stops"
                        : "deliver with mend continue from a terminal"}
                    </MonoText>
                  )}
                </View>
              </PanelRow>
            </Panel>
          )}

          <DescriptionCard
            tour={tour}
            pass={tourPass}
            stale={stale}
            inFlight={composing}
            canCompose={stats.length > 0}
            onCompose={() => queuePass.mutate("tour")}
            onStartTour={() => goToStop(0)}
          />

          {files.length === 0 && (
            <Panel>
              <PanelRow first>
                <MonoText>
                  {reviewLoading ? "loading…" : "the worktree matches its base — nothing to review"}
                </MonoText>
              </PanelRow>
            </Panel>
          )}

          {files.map((file) => {
            const fileComments = comments.filter((comment) => comment.file === file.path);
            const byLine = new Map<number, Array<ReviewCommentDto>>();
            for (const comment of fileComments) {
              if (comment.line === null) continue;
              const existing = byLine.get(comment.line);
              if (existing === undefined) byLine.set(comment.line, [comment]);
              else existing.push(comment);
            }
            const renderedLines = new Set(
              file.rows.flatMap((row) => (row.newLine === null ? [] : [row.newLine])),
            );
            const leftover = fileComments.filter(
              (comment) => comment.line === null || !renderedLines.has(comment.line),
            );
            const collapsedHere = isCollapsed(file.path);
            const stat = stats.find((candidate) => candidate.path === file.path);
            const highlight =
              activeStop !== null && activeStop.file === file.path && activeStop.line !== null
                ? { start: activeStop.line, end: activeStop.endLine ?? activeStop.line }
                : null;

            const blocks: Array<ReactNode> = [];
            if (!collapsedHere) {
              let chunk: Array<DiffRow> = [];
              let key = 0;
              const flush = () => {
                if (chunk.length === 0) return;
                blocks.push(
                  <CodeChunk
                    key={`chunk-${key}`}
                    rows={chunk}
                    lineH={lineH}
                    highlight={highlight}
                    onPressLine={(line) => setComposerAnchor(anchorFor(file.path, line))}
                  />,
                );
                key += 1;
                chunk = [];
              };
              for (const row of file.rows) {
                chunk.push(row);
                if (row.newLine === null) continue;
                const lineComments = byLine.get(row.newLine);
                const composerHere =
                  composerAnchor !== null &&
                  (composerAnchor.newPath ?? composerAnchor.oldPath) === file.path &&
                  composerAnchor.startLine === row.newLine;
                if (lineComments === undefined && !composerHere) continue;
                flush();
                for (const comment of lineComments ?? []) {
                  blocks.push(
                    <PanelRow key={comment.id}>
                      <CommentCard comment={comment} />
                    </PanelRow>,
                  );
                }
                if (composerHere && slice !== null && composerAnchor !== null) {
                  blocks.push(
                    <PanelRow key={`composer-${row.newLine}`}>
                      <CommentComposer
                        changeId={changeId}
                        sliceId={slice.id}
                        target={composerAnchor}
                        placeholder="Comment on this line…"
                        autoFocus
                        onDone={() => setComposerAnchor(null)}
                      />
                    </PanelRow>,
                  );
                }
              }
              flush();
              if (file.hidden > 0) {
                blocks.push(
                  <PanelRow key="hidden">
                    <MonoText size={10.5} tone="faint">
                      {file.hidden} more line{file.hidden === 1 ? "" : "s"} not shown
                    </MonoText>
                  </PanelRow>,
                );
              }
              for (const comment of leftover) {
                blocks.push(
                  <PanelRow key={comment.id}>
                    <CommentCard comment={comment} showAnchor />
                  </PanelRow>,
                );
              }
            }

            return (
              <View
                key={file.path}
                onLayout={(event) => fileTops.current.set(file.path, event.nativeEvent.layout.y)}
              >
                <Panel>
                  <Pressable
                    onPress={() =>
                      setCollapsedOverride((previous) => ({
                        ...previous,
                        [file.path]: !collapsedHere,
                      }))
                    }
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      backgroundColor: colors.sunken,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                    }}
                  >
                    <UiText weight="medium" size={12} numberOfLines={1} style={{ flex: 1 }}>
                      {file.path}
                    </UiText>
                    <MonoText size={10.5} tone="faint">
                      +{stat?.additions ?? 0} −{stat?.deletions ?? 0}
                      {fileComments.length > 0
                        ? ` · ${fileComments.length} comment${fileComments.length === 1 ? "" : "s"}`
                        : ""}{" "}
                      {collapsedHere ? "▸" : "▾"}
                    </MonoText>
                  </Pressable>
                  {!collapsedHere && <View style={{ paddingVertical: 6 }}>{blocks}</View>}
                </Panel>
              </View>
            );
          })}

          <SectionLabel>change-level comments</SectionLabel>
          <Panel>
            {changeLevel.map((comment, index) => (
              <PanelRow key={comment.id} first={index === 0}>
                <CommentCard comment={comment} />
              </PanelRow>
            ))}
            {slice !== null && (
              <PanelRow first={changeLevel.length === 0}>
                <CommentComposer
                  changeId={changeId}
                  sliceId={slice.id}
                  target={CHANGE_LEVEL_TARGET}
                  placeholder="Comment on the change as a whole…"
                />
              </PanelRow>
            )}
          </Panel>
        </ScrollView>

        {tour !== null && tourIndex !== null && (
          <TourDock
            tour={tour}
            index={tourIndex}
            onGo={goToStop}
            onEnd={() => setTourIndex(null)}
          />
        )}
      </View>

      {sendOpen && change !== null && slice !== null && (
        <SendReviewModal
          change={change}
          comments={openUnsent}
          slice={slice}
          onClose={() => setSendOpen(false)}
        />
      )}
    </>
  );
}
