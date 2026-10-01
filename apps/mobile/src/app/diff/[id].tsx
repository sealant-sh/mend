// The accumulated change as a plain unified diff — the git story without
// the review apparatus (plan §7.4: readable unified diffs). It reads the same
// pinned slice Review reads (the worktree's first checkpoint to the newest),
// so the two screens never disagree, and moves to a newer slice when the
// session takes a newer checkpoint; pull to refresh opens one at the current
// state. Review is the place for comments and tours — this screen only shows
// the evidence.

import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BodyPanel, SliceStatus } from "@/components/change-body";
import { BASE_LINE_H, CodeChunk, parseFiles, TOTAL_BUDGET } from "@/components/diff";
import { Panel } from "@/components/panel";
import { ScreenHeader } from "@/components/screen";
import { MonoText, UiText, useTextScale } from "@/components/typography";
import { usePinnedReview } from "@/data/review";
import { advanceFailure, changeBody } from "@/data/review-state";
import { spacing, useEvidenceTheme } from "@/theme/evidence";

export default function DiffScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const textScale = useTextScale();
  const lineH = Math.round(BASE_LINE_H * textScale);

  // Nothing is written here, so nothing holds the slice.
  const pinned = usePinnedReview(id ?? null, false);
  const review = pinned.review;
  const change = review?.change ?? null;
  const stats = (review?.files ?? []).map((file) => ({
    path: file.newPath ?? file.oldPath ?? "unknown path",
    additions: file.additions,
    deletions: file.deletions,
  }));
  const diffText = review?.patch ?? "";
  const files = useMemo(() => parseFiles(diffText), [diffText]);
  const readFacts = {
    open: { status: pinned.open.status, error: pinned.open.error },
    diff: { status: pinned.diff.status, error: pinned.diff.error },
    slice:
      review === null ? null : { fileCount: review.files.length, checkpointB: review.checkpointB },
  };
  const body = changeBody(readFacts);
  const failure = advanceFailure(readFacts);
  const retry = (step: "open" | "diff") =>
    void (step === "open" ? pinned.open.refetch() : pinned.diff.refetch());

  // Past the render budget, later files start collapsed — same discipline as
  // Review: the header with its counts is the whole story until opened.
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

  const additions = stats.reduce((sum, file) => sum + file.additions, 0);
  const deletions = stats.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      refreshControl={
        <RefreshControl
          refreshing={pinned.refreshing}
          onRefresh={pinned.refresh}
          tintColor={colors.faint}
        />
      }
      contentContainerStyle={{
        paddingTop: spacing.md,
        paddingHorizontal: 14,
        paddingBottom: spacing.xl2 + insets.bottom,
        gap: spacing.md,
      }}
    >
      <ScreenHeader
        eyebrow="diff"
        title={change === null ? "Change" : change.branch}
        meta={
          review === null
            ? body.kind === "failed"
              ? "not opened"
              : "opening the change…"
            : `checkpoint ${review.checkpointA.ordinal} → ${review.checkpointB.ordinal} · ${review.checkpointB.sha.slice(0, 7)} · ${stats.length} file${stats.length === 1 ? "" : "s"} · +${additions} −${deletions}`
        }
      />
      <SliceStatus
        review={review}
        advancing={pinned.advancing}
        heldFor={null}
        failure={failure}
        onRetry={retry}
      />
      {body.kind === "files" ? null : <BodyPanel body={body} onRetry={retry} />}
      {files.map((file) => {
        const stat = stats.find((candidate) => candidate.path === file.path);
        const collapsedHere = isCollapsed(file.path);
        return (
          <Panel key={file.path}>
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
                borderBottomWidth: collapsedHere ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: colors.faintRule,
              }}
            >
              <UiText weight="medium" size={12} numberOfLines={1} style={{ flex: 1 }}>
                {file.path}
              </UiText>
              <MonoText size={10.5} tone="faint">
                +{stat?.additions ?? 0} −{stat?.deletions ?? 0} {collapsedHere ? "▸" : "▾"}
              </MonoText>
            </Pressable>
            {!collapsedHere && (
              <View style={{ paddingVertical: 6 }}>
                <CodeChunk rows={file.rows} lineH={lineH} highlight={null} onPressLine={() => {}} />
                {file.hidden > 0 && (
                  <MonoText
                    size={10.5}
                    tone="faint"
                    style={{ paddingHorizontal: 12, paddingTop: 6 }}
                  >
                    {file.hidden} more line{file.hidden === 1 ? "" : "s"} not shown
                  </MonoText>
                )}
              </View>
            )}
          </Panel>
        );
      })}
    </ScrollView>
  );
}
