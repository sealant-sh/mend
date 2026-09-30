// Two sessions on one screen: side by side open flat, one above the other upright. Each side is
// the session's whole conversation with its own composer; the side last touched is the one on
// screen for notifications and wears the accent edge. Drag the divider to give one side more
// room. An empty side lists the sessions to put there. Folded, the split shows one side at a time.

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Maximize2, X } from "lucide-react-native";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Pane } from "@/components/pane";
import { Panel } from "@/components/panel";
import { ResizableSplit } from "@/components/resizable-split";
import { SessionPane } from "@/components/session-pane";
import { SessionRow } from "@/components/session-row";
import { MonoText, UiText } from "@/components/typography";
import { ACTIVE, annotationDetail, toSession, useAllSessions } from "@/data/live";
import { watchSession } from "@/data/notification-presence";
import { SPLIT_MAX, splitIdsOf, splitParam, withoutSession, withSession } from "@/data/split";
import { usePosture } from "@/data/use-posture";
import { radius, useEvidenceTheme } from "@/theme/evidence";

function IconButton({
  label,
  onPress,
  children,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.55 : 1 })}
    >
      {children}
    </Pressable>
  );
}

/** The sessions an empty side can hold: the ones not already in the split. */
function SessionPicker({
  exclude,
  onPick,
}: {
  readonly exclude: ReadonlyArray<string>;
  readonly onPick: (id: string) => void;
}) {
  const all = useAllSessions();
  const rows = (all.data ?? [])
    .filter(({ session }) => !exclude.includes(session.id))
    .map(({ session, project, annotation }) => ({
      dto: session,
      view: toSession(session, project.name),
      detail: annotationDetail(annotation, session.summary),
    }));
  const active = rows.filter(({ dto }) => ACTIVE.has(dto.status));
  const settled = rows.filter(({ dto }) => !ACTIVE.has(dto.status)).slice(0, 8);
  const shown = [...active, ...settled];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <UiText weight="medium">Put a session on this side</UiText>
      {all.isLoading ? <MonoText tone="faint">reading sessions…</MonoText> : null}
      {all.isError ? <MonoText tone="danger">{all.error.message}</MonoText> : null}
      {!all.isLoading && shown.length === 0 ? (
        <MonoText tone="faint">no other sessions</MonoText>
      ) : null}
      {shown.length === 0 ? null : (
        <Panel>
          {shown.map(({ view, detail }, index) => (
            <SessionRow
              key={view.id}
              session={view}
              detail={detail}
              first={index === 0}
              onPress={() => onPick(view.id)}
            />
          ))}
        </Panel>
      )}
    </ScrollView>
  );
}

export default function SplitScreen() {
  const { ids } = useLocalSearchParams<{ ids?: string }>();
  const sessionIds = splitIdsOf(ids);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useEvidenceTheme();
  const posture = usePosture();
  const landscape = posture === "landscape";
  const [touched, setTouched] = useState<string | null>(null);
  const focused =
    touched !== null && sessionIds.includes(touched) ? touched : (sessionIds[0] ?? null);
  useFocusEffect(
    useCallback(() => (focused === null ? undefined : watchSession(focused)), [focused]),
  );

  const setIds = (next: ReadonlyArray<string>) => router.setParams({ ids: splitParam(next) });

  const slots: Array<string | null> =
    sessionIds.length < SPLIT_MAX ? [...sessionIds, null] : sessionIds;
  // Folded there is room for one side: the focused one, or the empty side's list.
  const shownSlots = posture === "compact" ? [focused ?? null] : slots;

  const tile = (id: string | null, atBottom: boolean) => {
    if (id === null) {
      return (
        <SessionPicker
          exclude={sessionIds}
          onPick={(picked) => {
            setIds(withSession(sessionIds, picked));
            setTouched(picked);
          }}
        />
      );
    }
    return (
      <Pane atBottom={atBottom}>
        <SessionPane
          key={id}
          sessionId={id}
          topInset={false}
          direct={2}
          pinnedActions={[
            {
              key: "expand",
              label: "Open this session on its own",
              icon: Maximize2,
              onPress: () => router.push({ pathname: "/session/[id]", params: { id } }),
            },
            {
              key: "remove",
              label: "Take this session out of the split",
              icon: X,
              onPress: () => setIds(withoutSession(sessionIds, id)),
            },
          ]}
        />
      </Pane>
    );
  };

  // The side last touched wears the accent edge and counts as on screen for notifications.
  const frame = (id: string | null, atBottom: boolean) => (
    <View
      key={id ?? "empty"}
      onTouchStart={() => {
        if (id !== null) setTouched(id);
      }}
      style={{
        flex: 1,
        borderWidth: 1.5,
        borderColor:
          id !== null && id === focused && shownSlots.length > 1 ? colors.accent : "transparent",
        backgroundColor: id === null ? colors.bg : colors.panel,
      }}
    >
      {tile(id, atBottom)}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.bg }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
            backgroundColor: colors.sunken,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.softRule,
          }}
        >
          <MonoText size={11} tone="label" style={{ flex: 1 }} numberOfLines={1}>
            split · {sessionIds.length} session{sessionIds.length === 1 ? "" : "s"}
            {posture === "compact"
              ? " · unfold to see both"
              : sessionIds.length === SPLIT_MAX
                ? " · drag the divider"
                : ""}
          </MonoText>
          {posture === "compact" && sessionIds.length === SPLIT_MAX
            ? sessionIds.map((id, index) => (
                <Pressable
                  key={id}
                  onPress={() => setTouched(id)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: radius.md,
                    backgroundColor: id === focused ? colors.wash : colors.panel,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: id === focused ? colors.accent : colors.rule,
                  }}
                >
                  <MonoText size={11} tone={id === focused ? "accent" : "ink2"}>
                    {index + 1}
                  </MonoText>
                </Pressable>
              ))
            : null}
          <IconButton label="Close the split" onPress={() => router.back()}>
            <X size={16} color={colors.ink2} strokeWidth={2} />
          </IconButton>
        </View>
        {shownSlots.length === 1 ? (
          frame(shownSlots[0] ?? null, true)
        ) : (
          <ResizableSplit
            key={posture}
            sideBySide={landscape}
            label="Divider between the two sessions"
            first={frame(shownSlots[0] ?? null, landscape)}
            second={frame(shownSlots[1] ?? null, true)}
          />
        )}
      </KeyboardAvoidingView>
    </>
  );
}
