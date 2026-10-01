// One session on an unfolded screen. Open flat: a rail of the sessions worth a tap, the
// conversation, and — when asked for — the change's diff or a shell on the other side of the
// crease. Upright: the conversation above, the diff or the shell below, or the conversation alone
// at full height. Diff and Shell in the session's header open and close the other side; nothing
// opens a shell until a person asks for one.

import { useRouter } from "expo-router";
import { Columns2, Inbox, Rows2, X } from "lucide-react-native";
import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { DiffPane } from "@/components/diff-pane";
import { Pane } from "@/components/pane";
import { ResizableSplit } from "@/components/resizable-split";
import { SessionPane, type Companion } from "@/components/session-pane";
import { TerminalPane } from "@/components/terminal-pane";
import { MonoText, UiText } from "@/components/typography";
import { findLastMatching } from "@/data/collections";
import { toneOf, useAllSessions, useSession, useSessionActions } from "@/data/live";
import { initialsOf, railSessions } from "@/data/rail";
import { radius, useEvidenceTheme } from "@/theme/evidence";

export const companionOf = (param: string | undefined): Companion | null =>
  param === "terminal" || param === "diff" ? param : null;

/** The sessions worth a tap, as two-letter buttons with their status dot. */
function SessionRail({
  currentId,
  onSwitch,
}: {
  readonly currentId: string;
  readonly onSwitch: (sessionId: string) => void;
}) {
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const all = useAllSessions();
  const sessions = railSessions(
    (all.data ?? []).map(({ session }) => session),
    currentId,
  );
  const dot = (status: string) =>
    ({
      live: colors.accent,
      waiting: colors.amber,
      observed: colors.greenDot,
      breakage: colors.red,
      pending: colors.faint,
    })[toneOf(status)];
  return (
    <View
      style={{
        width: 64,
        backgroundColor: colors.sunken,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: colors.softRule,
      }}
    >
      <ScrollView
        contentContainerStyle={{
          alignItems: "center",
          gap: 14,
          paddingTop: 12,
          paddingBottom: 12 + insets.bottom,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Now"
          onPress={() => router.navigate("/")}
          style={{ width: 44, height: 36, alignItems: "center", justifyContent: "center" }}
        >
          <Inbox size={20} color={colors.ink2} strokeWidth={1.8} />
        </Pressable>
        {sessions.map((session) => {
          const current = session.id === currentId;
          return (
            <Pressable
              key={session.id}
              accessibilityRole="button"
              accessibilityLabel={session.label ?? session.harness}
              accessibilityState={{ selected: current }}
              onPress={() => {
                if (!current) onSwitch(session.id);
              }}
              style={{ alignItems: "center", gap: 5 }}
            >
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: radius.lg,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: current ? colors.wash : colors.panel,
                  borderWidth: current ? 1 : StyleSheet.hairlineWidth,
                  borderColor: current ? colors.accent : colors.rule,
                }}
              >
                <UiText weight="semibold" size={13} tone={current ? "accent" : "ink"}>
                  {initialsOf(session)}
                </UiText>
              </View>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: dot(session.status),
                }}
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** The other side's title strip: what it shows, and how to close it. */
function CompanionFrame({
  title,
  action,
  onClose,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { colors } = useEvidenceTheme();
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 14,
          paddingVertical: 6,
          backgroundColor: colors.sunken,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.softRule,
        }}
      >
        <MonoText size={11} tone="label" style={{ flex: 1 }}>
          {title}
        </MonoText>
        {action}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          hitSlop={10}
          onPress={onClose}
          style={{ padding: 4 }}
        >
          <X size={16} color={colors.ink2} strokeWidth={2} />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

/** The worktree's shell beside the conversation: the open one, or a button that opens one. */
function ShellCompanion({
  sessionId,
  onClose,
}: {
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const detail = useSession(sessionId);
  const { openShell, stopShell } = useSessionActions();
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = detail.data?.session;
  const running = session !== undefined && ["running", "waiting", "idle"].includes(session.status);
  const shell = findLastMatching(
    detail.data?.processes ?? [],
    (process) => process.kind === "shell" && process.exitedAt === null,
  );
  const processId = shell?.id ?? opened;

  const confirmStop = () => {
    if (processId === null) return;
    Alert.alert(
      "Stop this shell?",
      "This ends the shell process. Closing the pane only detaches.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop shell",
          style: "destructive",
          onPress: () =>
            stopShell.mutate(processId, {
              onSuccess: () => {
                setOpened(null);
                onClose();
              },
            }),
        },
      ],
    );
  };

  let body: ReactNode;
  if (processId !== null) {
    body = <TerminalPane key={processId} sessionId={sessionId} processId={processId} />;
  } else {
    body = (
      <View style={{ padding: 16, gap: 10, alignItems: "flex-start" }}>
        <MonoText tone="faint" size={11.5}>
          {running
            ? "no shell open in this worktree"
            : "the session's workspace is not running · resume it to open a shell"}
        </MonoText>
        {running ? (
          <EvButton
            size="sm"
            variant="outline"
            label={openShell.isPending ? "opening…" : "Open a shell"}
            disabled={openShell.isPending}
            onPress={() => {
              setError(null);
              openShell.mutate(sessionId, {
                onSuccess: (process) => setOpened(process.id),
                onError: (cause) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
              });
            }}
          />
        ) : null}
        {error === null ? null : (
          <MonoText tone="danger" size={11} numberOfLines={3}>
            {error}
          </MonoText>
        )}
      </View>
    );
  }
  return (
    <CompanionFrame
      title={processId === null ? "terminal" : "terminal · shell"}
      onClose={onClose}
      action={
        processId === null ? null : (
          <Pressable disabled={stopShell.isPending} onPress={confirmStop} hitSlop={8}>
            <MonoText tone="danger" size={11}>
              {stopShell.isPending ? "stopping…" : "Stop"}
            </MonoText>
          </Pressable>
        )
      }
    >
      {body}
    </CompanionFrame>
  );
}

export function SessionWorkspace({
  sessionId,
  mode,
  posture,
  initialCompanion,
}: {
  readonly sessionId: string;
  readonly mode?: string | undefined;
  readonly posture: "landscape" | "upright";
  readonly initialCompanion: Companion | null;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useEvidenceTheme();
  const [companion, setCompanion] = useState<Companion | null>(initialCompanion);
  const changeId = useSession(sessionId).data?.change?.id ?? null;
  const close = () => setCompanion(null);
  const landscape = posture === "landscape";

  let side: ReactNode = null;
  if (companion === "terminal") {
    side = <ShellCompanion key={sessionId} sessionId={sessionId} onClose={close} />;
  } else if (companion === "diff") {
    side = (
      <CompanionFrame title="diff · the whole change" onClose={close}>
        {changeId === null ? (
          <MonoText tone="faint" size={11.5} style={{ padding: 16 }}>
            no change yet
          </MonoText>
        ) : (
          <DiffPane changeId={changeId} />
        )}
      </CompanionFrame>
    );
  }

  const conversation = (
    <Pane atBottom={landscape || side === null}>
      <SessionPane
        key={sessionId}
        sessionId={sessionId}
        {...(mode === undefined ? {} : { mode })}
        topInset={false}
        companion={{
          open: companion,
          toggle: (next) => setCompanion((current) => (current === next ? null : next)),
        }}
        extraActions={[
          {
            key: "split",
            label: "Split with another session",
            icon: landscape ? Columns2 : Rows2,
            onPress: () => router.push({ pathname: "/split", params: { ids: sessionId } }),
          },
        ]}
      />
    </Pane>
  );

  // Open flat, the rail and the conversation end at the crease; drag the divider for more.
  const main = (
    <View style={{ flex: 1, flexDirection: "row" }}>
      {landscape ? (
        <SessionRail
          currentId={sessionId}
          // The same screen shows the other session: the rail and the other side stay put, only
          // the conversation (and what the other side shows) changes. A new screen would slide in.
          onSwitch={(id) => router.setParams({ id })}
        />
      ) : null}
      <View style={{ flex: 1 }}>{conversation}</View>
    </View>
  );
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, paddingTop: insets.top, backgroundColor: colors.bg }}
    >
      {side === null ? (
        main
      ) : (
        <ResizableSplit
          key={posture}
          sideBySide={landscape}
          label="Divider between the conversation and the other side"
          first={main}
          second={
            <View style={{ flex: 1, backgroundColor: colors.panel }}>
              <Pane atBottom>{side}</Pane>
            </View>
          }
        />
      )}
    </KeyboardAvoidingView>
  );
}
