// Now — a sparse attention inbox (plan §6.1), fed by the LIVE workbench API:
// what is waiting for me, what runs, what recently settled. Not a kanban.
// Unfolded, Preview shows the session a row points at beside the inbox (open
// flat, where it starts on) or below it (upright, where the inbox starts
// alone). Expand gives that session the whole screen (its rail, the diff, a
// shell); Split puts a second session beside it.

import { useFocusEffect, useRouter } from "expo-router";
import { Columns2, Maximize2, Rows2 } from "lucide-react-native";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { ClearSettledButton } from "@/components/clear-settled";
import { Pane } from "@/components/pane";
import { Panel } from "@/components/panel";
import { RenameSessionModal, type RenameTarget } from "@/components/rename-session";
import { ResizableSplit } from "@/components/resizable-split";
import { Screen, ScreenHeader } from "@/components/screen";
import { SessionPane } from "@/components/session-pane";
import { SessionRow } from "@/components/session-row";
import { Eyebrow, MonoText, UiText } from "@/components/typography";
import {
  ACTIVE,
  annotationDetail,
  toSession,
  useAllSessions,
  useConfig,
  useSessionActions,
} from "@/data/live";
import { watchSession } from "@/data/notification-presence";
import { usePosture } from "@/data/use-posture";
import { spacing, useEvidenceTheme } from "@/theme/evidence";

function GroupLabel({ label, action }: { readonly label: string; readonly action?: ReactNode }) {
  const { colors } = useEvidenceTheme();
  return (
    <View
      style={{
        backgroundColor: colors.sunken,
        paddingHorizontal: 16,
        paddingVertical: 6,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <Eyebrow>{label}</Eyebrow>
      {action}
    </View>
  );
}

export default function NowScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useEvidenceTheme();
  const posture = usePosture();
  const [picked, setPicked] = useState<string | null>(null);
  // Null until the person chooses: open flat previews, upright lists.
  const [previewChoice, setPreviewChoice] = useState<boolean | null>(null);
  const preview = posture !== "compact" && (previewChoice ?? posture === "landscape");
  const config = useConfig();
  const all = useAllSessions();
  const { remove, removeSettled } = useSessionActions();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const rows = (all.data ?? []).map(({ session, project, annotation }) => ({
    dto: session,
    view: toSession(session, project.name),
    detail: annotationDetail(annotation, session.summary),
  }));

  const settled = rows.filter(({ dto }) => !ACTIVE.has(dto.status));
  const groups = [
    { label: "Needs you", items: rows.filter(({ dto }) => dto.status === "waiting") },
    {
      label: "Live",
      items: rows.filter(({ dto }) => dto.status !== "waiting" && ACTIVE.has(dto.status)),
    },
    { label: "Recently settled", items: settled.slice(0, 8) },
  ];
  const listed = groups.flatMap(({ items }) => items.map(({ dto }) => dto.id));
  // While previewing, one session is always open beside the inbox: the one picked, or the first.
  const selectedId = !preview
    ? null
    : picked !== null && listed.includes(picked)
      ? picked
      : (listed[0] ?? null);
  useFocusEffect(
    useCallback(() => (selectedId === null ? undefined : watchSession(selectedId)), [selectedId]),
  );

  const openSession = (id: string) => {
    if (!preview) {
      router.push({ pathname: "/session/[id]", params: { id } });
      return;
    }
    setPicked(id);
  };

  // The stored config has not been read off disk yet: neither panel is true
  // yet, so show the header alone rather than flash "not paired" at a phone
  // that is paired.
  if (config === null) {
    return (
      <Screen topInset>
        <ScreenHeader eyebrow="mend" title="Now" meta="reading this device" />
      </Screen>
    );
  }

  // Nothing to inbox until this phone has a machine to ask.
  if (config.url === "" || config.token === "") {
    return (
      <Screen topInset>
        <ScreenHeader eyebrow="mend" title="Now" meta="not paired" />
        <Panel>
          <View style={{ padding: 16, gap: 12 }}>
            <UiText weight="medium">Pair this phone with your machine</UiText>
            <UiText>
              On the machine running Mend, open Settings → Devices and show the pairing code. Scan
              it here and this phone gets its own token.
            </UiText>
            <MonoText tone="faint">no server · no token</MonoText>
            <EvButton label="Pair with your machine" onPress={() => router.push("/pair")} />
          </View>
        </Panel>
      </Screen>
    );
  }

  const inbox = (
    <>
      <ScreenHeader
        eyebrow="mend"
        title="Now"
        {...(posture === "compact"
          ? {}
          : {
              action: (
                <EvButton
                  size="sm"
                  variant="outline"
                  label={preview ? "Hide preview" : "Preview"}
                  onPress={() => setPreviewChoice(!preview)}
                />
              ),
            })}
        meta={
          all.isError
            ? "sessions could not be read"
            : all.isLoading
              ? "connecting…"
              : `${(groups[0]?.items.length ?? 0) === 0 ? "nothing waiting on you" : `${groups[0]?.items.length} waiting`} · ${groups[1]?.items.length ?? 0} live`
        }
      />
      {all.isError && (
        <Panel>
          <View style={{ padding: 16, gap: 10 }}>
            <MonoText tone="ink2">{all.error.message}</MonoText>
            <View style={{ flexDirection: "row" }}>
              <EvButton
                size="sm"
                variant="outline"
                label={all.isFetching ? "retrying…" : "Retry"}
                disabled={all.isFetching}
                onPress={() => void all.refetch()}
              />
            </View>
          </View>
        </Panel>
      )}
      {groups.map(({ label, items }) =>
        items.length === 0 ? null : (
          <Panel key={label}>
            <GroupLabel
              label={label}
              action={
                label === "Recently settled" ? (
                  <ClearSettledButton
                    sessionIds={settled.map(({ dto }) => dto.id)}
                    pending={removeSettled.isPending}
                    onClear={(ids) => removeSettled.mutate(ids)}
                  />
                ) : undefined
              }
            />
            {items.map(({ dto, view, detail }) => (
              <SessionRow
                key={view.id}
                session={view}
                detail={detail}
                selected={view.id === selectedId}
                onPress={() => openSession(view.id)}
                onRename={() => setRenaming({ sessionId: dto.id, label: dto.label })}
                {...(ACTIVE.has(dto.status) ? {} : { onDelete: () => remove.mutate(dto.id) })}
              />
            ))}
          </Panel>
        ),
      )}
      <RenameSessionModal target={renaming} onClose={() => setRenaming(null)} />
    </>
  );

  if (!preview) return <Screen topInset>{inbox}</Screen>;

  const landscape = posture === "landscape";
  const pane =
    selectedId === null ? (
      <MonoText tone="faint" style={{ padding: 20 }}>
        no sessions yet · start one from a project
      </MonoText>
    ) : (
      // The tab bar holds the bottom edge.
      <Pane atBottom={false}>
        <SessionPane
          key={selectedId}
          sessionId={selectedId}
          topInset={false}
          pinnedActions={[
            {
              key: "expand",
              label: "Open this session on its own",
              icon: Maximize2,
              onPress: () => router.push({ pathname: "/session/[id]", params: { id: selectedId } }),
            },
          ]}
          extraActions={[
            {
              key: "split",
              label: "Split with another session",
              icon: landscape ? Columns2 : Rows2,
              onPress: () => router.push({ pathname: "/split", params: { ids: selectedId } }),
            },
          ]}
        />
      </Pane>
    );
  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.bg }}
    >
      <ResizableSplit
        key={posture}
        sideBySide={landscape}
        label="Divider between the inbox and the session"
        first={
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingTop: spacing.md,
              paddingHorizontal: 20,
              paddingBottom: spacing.xl,
              gap: spacing.lg,
            }}
          >
            {inbox}
          </ScrollView>
        }
        second={pane}
      />
    </KeyboardAvoidingView>
  );
}
