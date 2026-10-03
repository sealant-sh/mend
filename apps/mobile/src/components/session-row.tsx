// One session as a pressable panel row: mono provenance line (harness ·
// project), the instruction in human language, a dot+word status. Takes a
// plain view struct — the live adapter (`toSession`) produces it. When the
// caller wires actions, sliding the row left reveals rename and (for a
// settled session) delete; delete asks twice, in place. A change with a pull request shows it
// last, in cobalt because it is a way out: tapping it opens GitHub, not the session.

import { GitPullRequest, Pencil, Trash2 } from "lucide-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { openPullRequest } from "@/components/pull-request-card";
import type { StatusTone } from "@/components/status";
import { StatusWord } from "@/components/status";
import { MonoText, UiText } from "@/components/typography";
import { pullRequestFact, type ChangePullRequestDto } from "@/data/pull-requests";
import { useEvidenceTheme } from "@/theme/evidence";

export interface SessionRowView {
  readonly id: string;
  readonly harness: string;
  /** The model the session was started with; null when not recorded. */
  readonly model: string | null;
  /** Display label — the project's name, not its id. */
  readonly projectId: string;
  readonly title: string;
  readonly statusWord: string;
  readonly statusTone: StatusTone;
}

const ACTION_WIDTH = 76;

function SwipeAction({
  label,
  icon,
  background,
  color,
  onPress,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly background: string;
  readonly color: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        width: ACTION_WIDTH,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: background,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      {icon}
      <MonoText size={10} style={{ color }}>
        {label}
      </MonoText>
    </Pressable>
  );
}

export function SessionRow({
  session,
  detail = null,
  first = false,
  selected = false,
  onPress,
  onRename,
  onDelete,
  pullRequest = null,
}: {
  readonly session: SessionRowView;
  /** Optional mono second line: change stats, last progress, settle summary. */
  readonly detail?: string | null;
  readonly first?: boolean;
  /** The session open beside the list on an unfolded screen. */
  readonly selected?: boolean;
  readonly onPress?: () => void;
  /** Reveal a rename action on slide-left. */
  readonly onRename?: () => void;
  /** Reveal a delete action on slide-left — pass only for settled sessions. */
  readonly onDelete?: () => void;
  /** The change's newest pull request, from the list's annotation. */
  readonly pullRequest?: ChangePullRequestDto | null;
}) {
  const { colors } = useEvidenceTheme();
  const swipeable = useRef<SwipeableMethods | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const row = (
    <Pressable
      {...(onPress ? { onPress } : {})}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          paddingLeft: selected ? 14 : 16,
          paddingRight: 16,
          paddingVertical: 12,
          gap: 4,
          backgroundColor: pressed ? colors.sunken : selected ? colors.wash : colors.panel,
          borderLeftWidth: selected ? 2 : 0,
          borderLeftColor: colors.accent,
        },
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <MonoText tone="faint" size={11}>
          {session.harness}
          {session.model === null ? "" : ` · ${session.model}`} · {session.projectId}
        </MonoText>
        <StatusWord tone={session.statusTone} word={session.statusWord} size={11} />
      </View>
      <UiText weight="medium" size={14.5} numberOfLines={2}>
        {session.title}
      </UiText>
      {detail === null ? null : (
        <MonoText tone="muted" size={11.5}>
          {detail}
        </MonoText>
      )}
      {pullRequest === null ? null : (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open pull request ${pullRequest.number} on GitHub`}
          hitSlop={8}
          onPress={() => openPullRequest(pullRequest.url)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-start",
            maxWidth: "100%",
            paddingTop: 2,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <GitPullRequest size={12} color={colors.accent} strokeWidth={1.8} />
          <MonoText tone="accent" size={11.5}>
            {pullRequestFact(pullRequest)}
          </MonoText>
          {(pullRequest.title ?? null) === null ? null : (
            <MonoText tone="faint" size={11.5} numberOfLines={1} style={{ flexShrink: 1 }}>
              {pullRequest.title}
            </MonoText>
          )}
        </Pressable>
      )}
    </Pressable>
  );

  const border = first
    ? {}
    : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.faintRule };

  if (onRename === undefined && onDelete === undefined) {
    return <View style={border}>{row}</View>;
  }

  return (
    <View style={border}>
      <Swipeable
        ref={swipeable}
        friction={2}
        rightThreshold={32}
        overshootRight={false}
        onSwipeableWillClose={() => setDeleteArmed(false)}
        renderRightActions={() => (
          <View style={{ flexDirection: "row" }}>
            {onRename !== undefined && (
              <SwipeAction
                label="Rename"
                icon={<Pencil size={16} color={colors.ink} strokeWidth={1.8} />}
                background={colors.sunken}
                color={colors.ink}
                onPress={() => {
                  swipeable.current?.close();
                  onRename();
                }}
              />
            )}
            {onDelete !== undefined && (
              <SwipeAction
                label={deleteArmed ? "Really?" : "Delete"}
                icon={<Trash2 size={16} color="#ffffff" strokeWidth={1.8} />}
                background={colors.red}
                color="#ffffff"
                onPress={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  swipeable.current?.close();
                  onDelete();
                }}
              />
            )}
          </View>
        )}
      >
        {row}
      </Swipeable>
    </View>
  );
}
