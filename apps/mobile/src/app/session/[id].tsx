// One session as a conversation. Protocol agents render the durable authored
// turns, ordered items, and agent-to-human requests. Older PTY sessions keep
// their transcript projection and raw TTY composer.

import { LegendList } from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { MendMarkdown } from "@/components/markdown";
import { ProtocolConversation } from "@/components/protocol-conversation";
import { StatusWord } from "@/components/status";
import { DisplayTitle, MonoText, UiText } from "@/components/typography";
import { findLastMatching } from "@/data/collections";
import {
  agentIsActive,
  canDeliverFollowUp,
  loadConfig,
  toneOf,
  usePendingFollowUp,
  useSession,
  useSessionActions,
  useTranscript,
  type TranscriptEventDto,
} from "@/data/live";
import { useTtySocket, type TtyTarget } from "@/data/tty-socket";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

interface FeedEntry {
  readonly key: string;
  readonly event: TranscriptEventDto;
}

const sameEvent = (a: TranscriptEventDto, b: TranscriptEventDto): boolean =>
  a.kind === b.kind &&
  a.text === b.text &&
  a.name === b.name &&
  a.command === b.command &&
  a.output === b.output;

const EventRow = memo(
  function EventRow({ event }: { readonly event: TranscriptEventDto }) {
    const { colors } = useEvidenceTheme();
    if (event.kind === "user" && event.text !== null) {
      return (
        <View
          style={{
            alignSelf: "flex-end",
            maxWidth: "85%",
            backgroundColor: colors.wash,
            borderRadius: radius.xl,
            borderBottomRightRadius: 6,
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <UiText size={15} style={{ lineHeight: 21 }}>
            {event.text}
          </UiText>
        </View>
      );
    }
    if (event.kind === "assistant" && event.text !== null) {
      return (
        <View style={{ paddingHorizontal: 2 }}>
          <MendMarkdown>{event.text}</MendMarkdown>
        </View>
      );
    }
    if (event.kind === "reasoning" && event.text !== null) {
      return (
        <MonoText tone="faint" size={11} numberOfLines={2} style={{ paddingHorizontal: 2 }}>
          {event.text}
        </MonoText>
      );
    }
    if (event.kind === "tool") {
      return (
        <View
          style={{
            backgroundColor: colors.sunken,
            borderRadius: radius.md,
            paddingHorizontal: 12,
            paddingVertical: 8,
            gap: 3,
          }}
        >
          <MonoText size={11.5} style={{ color: colors.ink2 }}>
            {event.command === null ? (event.name ?? "tool") : `$ ${event.command}`}
          </MonoText>
          {event.output !== null && event.output !== "" && (
            <MonoText tone="faint" size={10.5} numberOfLines={3}>
              {event.output}
            </MonoText>
          )}
        </View>
      );
    }
    return null;
  },
  (prev, next) => sameEvent(prev.event, next.event),
);

function PtyConversation({
  sessionId,
  active,
  summary,
  pickUp,
}: {
  readonly sessionId: string;
  readonly active: boolean;
  readonly summary: string | null;
  /**
   * Cross-mode pickup (claude and codex): the composer IS the pickup — the
   * first send hands the session off to structured mode with the typed
   * message as its opening turn. Reading stays instant either way.
   */
  readonly pickUp?: {
    readonly start: (prompt: string) => void;
    readonly pending: boolean;
    readonly error: string | null;
  };
}) {
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const transcript = useTranscript(sessionId, active);
  const [draft, setDraft] = useState("");
  const [pendingSends, setPendingSends] = useState<
    ReadonlyArray<{ readonly id: number; readonly text: string }>
  >([]);
  const pendingSeq = useRef(0);
  const [working, setWorking] = useState(false);
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInvalidate = useRef(0);
  const [base, setBase] = useState<{ url: string; token: string } | null>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const transcriptRef = useRef<(() => Promise<unknown>) | null>(null);
  transcriptRef.current = transcript.refetch;

  useEffect(() => {
    void loadConfig().then((config) => setBase({ url: config.url, token: config.token }));
    return () => {
      if (workingTimer.current !== null) {
        clearTimeout(workingTimer.current);
      }
    };
  }, []);

  const onBinary = useCallback(() => {
    setWorking(true);
    if (workingTimer.current !== null) {
      clearTimeout(workingTimer.current);
    }
    workingTimer.current = setTimeout(() => setWorking(false), 2_500);
    const now = Date.now();
    if (now - lastInvalidate.current > 1_000) {
      lastInvalidate.current = now;
      void transcriptRef.current?.();
    }
  }, []);
  const ttyTarget = useMemo<TtyTarget>(() => ({ kind: "session", id: sessionId }), [sessionId]);
  const tty = useTtySocket({
    serverUrl: base?.url ?? null,
    token: base?.token ?? null,
    target: ttyTarget,
    enabled: active,
    onBinary,
  });
  const send = () => {
    const text = draft.trim();
    if (text === "") {
      return;
    }
    if (pickUp !== undefined) {
      if (pickUp.pending) {
        return;
      }
      pickUp.start(text);
      pendingSeq.current += 1;
      setPendingSends((current) => [...current, { id: pendingSeq.current, text }]);
      setDraft("");
      return;
    }
    if (!tty.send(text)) {
      return;
    }
    setTimeout(() => void tty.send("\r"), 100);
    pendingSeq.current += 1;
    setPendingSends((current) => [...current, { id: pendingSeq.current, text }]);
    setWorking(true);
    setDraft("");
  };
  const keyboard = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const bottomPad =
    (keyboard.isVisible ? keyboard.height : insets.bottom) +
    (active ? composerHeight + spacing.xs : spacing.md);
  const serverEvents = transcript.data?.events ?? [];

  useEffect(() => {
    if (pendingSends.length === 0) {
      return;
    }
    const tail = new Set(
      serverEvents
        .slice(-12)
        .filter((event) => event.kind === "user")
        .map((event) => (event.text ?? "").trim()),
    );
    setPendingSends((current) => current.filter((pending) => !tail.has(pending.text)));
  }, [serverEvents.length]);

  const feed = useMemo<ReadonlyArray<FeedEntry>>(
    () => [
      ...serverEvents.map((event, index) => ({ key: `s${index}`, event })),
      ...pendingSends.map((pending) => ({
        key: `p${pending.id}`,
        event: {
          kind: "user",
          text: pending.text,
          name: null,
          command: null,
          output: null,
        },
      })),
    ],
    [serverEvents, pendingSends],
  );
  let emptyMessage = summary ?? "no conversation recorded";
  if (transcript.isLoading) {
    emptyMessage = "reading the conversation…";
  } else if (active) {
    emptyMessage = "provisioning, the conversation appears as the agent starts…";
  }

  return (
    <View style={{ flex: 1 }}>
      <LegendList
        data={feed}
        keyExtractor={(entry) => entry.key}
        getItemType={(entry) => entry.event.kind}
        renderItem={({ item }) => <EventRow event={item.event} />}
        estimatedItemSize={72}
        drawDistance={500}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={{
          animated: true,
          on: { dataChange: true, itemLayout: true, layout: true },
        }}
        maintainVisibleContentPosition={{ data: true, size: true }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: spacing.xs,
          paddingBottom: bottomPad,
          gap: 10,
        }}
        ListFooterComponent={
          working && active ? (
            <MonoText tone="faint" size={11.5} style={{ paddingHorizontal: 2, paddingTop: 4 }}>
              working…
            </MonoText>
          ) : null
        }
        ListEmptyComponent={<MonoText tone="faint">{emptyMessage}</MonoText>}
      />
      {(active || pickUp !== undefined) && (
        <KeyboardStickyView
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
          {pickUp !== undefined && pickUp.pending && (
            <View
              style={{ alignItems: "center", paddingVertical: 4, backgroundColor: colors.sunken }}
            >
              <MonoText tone="faint" size={11}>
                picking up the session…
              </MonoText>
            </View>
          )}
          {pickUp !== undefined && pickUp.error !== null && !pickUp.pending && (
            <View
              style={{ alignItems: "center", paddingVertical: 4, backgroundColor: colors.sunken }}
            >
              <MonoText tone="faint" size={11}>
                {pickUp.error}
              </MonoText>
            </View>
          )}
          {pickUp === undefined && !tty.canSend && (
            <Pressable
              onPress={tty.retryNow}
              style={{
                alignItems: "center",
                paddingVertical: 4,
                backgroundColor: colors.sunken,
              }}
            >
              <MonoText tone="faint" size={11}>
                {tty.phase === "reconnecting"
                  ? "reconnecting… tap to retry now"
                  : "connecting to the session…"}
              </MonoText>
            </Pressable>
          )}
          <View
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 8,
              paddingHorizontal: 10,
              paddingTop: 8,
              paddingBottom: keyboard.isVisible ? 8 : insets.bottom + 4,
              backgroundColor: colors.panel,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.softRule,
            }}
          >
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={
                pickUp === undefined
                  ? "Message the session…"
                  : "Message the session — continues here in structured mode"
              }
              placeholderTextColor={colors.faint}
              multiline
              style={{
                flex: 1,
                minHeight: 40,
                maxHeight: 120,
                backgroundColor: colors.bg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.rule,
                borderRadius: radius.lg,
                paddingHorizontal: 13,
                paddingVertical: 9,
                color: colors.ink,
                fontSize: 15,
              }}
            />
            <EvButton
              label="Send"
              onPress={send}
              disabled={pickUp === undefined ? !tty.canSend : pickUp.pending}
            />
          </View>
        </KeyboardStickyView>
      )}
    </View>
  );
}

export default function SessionScreen() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const router = useRouter();
  const { colors } = useEvidenceTheme();
  const insets = useSafeAreaInsets();
  const detail = useSession(id);
  const session = detail.data?.session;
  const change = detail.data?.change ?? null;
  const currentAgent = detail.data?.currentAgent ?? null;
  const agentActive = agentIsActive(session, currentAgent);
  // Only the owner steers unless they share control (docs/adr/0003). A server from before
  // organizations sends no control view; everything stays available there.
  const steer = detail.data?.control?.steer ?? true;
  const canStop = detail.data?.control?.stop ?? true;
  const canOpenShell =
    session !== undefined && ["running", "waiting", "idle"].includes(session.status);
  const protocol =
    currentAgent === null ? mode === "protocol" : currentAgent.kind === "agent-protocol";
  const followUp = usePendingFollowUp(id).data ?? null;
  const { resume, stop, openShell, deliverFollowUp, handoff } = useSessionActions();
  const [shellError, setShellError] = useState<string | null>(null);
  // Cross-mode pickup: claude and codex sessions continue here in structured
  // mode; other harnesses keep the raw terminal composer.
  const canPickUp = steer && (session?.harness === "claude" || session?.harness === "codex");

  const openTerminal = () => {
    if (session === undefined) {
      return;
    }
    const attach = (processId: string) =>
      router.push({
        pathname: "/terminal/[id]",
        params: { id: session.id, process: processId },
      });
    const reusable = findLastMatching(
      detail.data?.processes ?? [],
      (process) => process.kind === "shell" && process.exitedAt === null,
    );
    if (reusable !== undefined) {
      attach(reusable.id);
      return;
    }
    setShellError(null);
    openShell.mutate(session.id, {
      onSuccess: (process) => attach(process.id),
      onError: (error) => setShellError(error instanceof Error ? error.message : String(error)),
    });
  };
  let conversation = (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
      <MonoText tone="faint">loading session…</MonoText>
    </View>
  );
  if (session !== undefined) {
    conversation = protocol ? (
      <ProtocolConversation
        sessionId={session.id}
        active={agentActive && steer}
        starting={session.status === "starting"}
        summary={session.summary}
      />
    ) : (
      <PtyConversation
        sessionId={session.id}
        active={agentActive}
        summary={session.summary}
        {...(canPickUp
          ? {
              pickUp: {
                start: (prompt: string) =>
                  handoff.mutate({ sessionId: session.id, to: "protocol", prompt }),
                pending: handoff.isPending,
                error:
                  handoff.error === null
                    ? null
                    : handoff.error instanceof Error
                      ? handoff.error.message
                      : String(handoff.error),
              },
            }
          : {})}
      />
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View
          style={{
            paddingTop: insets.top + 4,
            paddingHorizontal: 16,
            paddingBottom: spacing.xs,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <DisplayTitle style={{ fontSize: 18, lineHeight: 23, letterSpacing: -0.3 }}>
              {session?.harness ?? "…"}
            </DisplayTitle>
            <View style={{ flex: 1 }} />
            {session !== undefined && (
              <StatusWord tone={toneOf(session.status)} word={session.status} />
            )}
          </View>
          {session !== undefined && (
            <MonoText tone="faint" size={10.5} numberOfLines={1}>
              worktree{" "}
              {session.branch.replace(/^mend\/session\//, "session ").replace(/^mend\/(wt\/)?/, "")}{" "}
              · base {session.baseRef ?? session.baseSha.slice(0, 12)}
            </MonoText>
          )}
          {session !== undefined && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {change !== null && (
                <EvButton
                  size="sm"
                  label="Review"
                  onPress={() =>
                    router.push({ pathname: "/review/[id]", params: { id: change.id } })
                  }
                />
              )}
              {change !== null && (
                <EvButton
                  size="sm"
                  variant="outline"
                  label="Diff"
                  onPress={() => router.push({ pathname: "/diff/[id]", params: { id: change.id } })}
                />
              )}
              {steer && !agentActive && followUp !== null && canDeliverFollowUp(followUp) && (
                <EvButton
                  size="sm"
                  label={deliverFollowUp.isPending ? "delivering…" : "Deliver follow-up"}
                  disabled={deliverFollowUp.isPending}
                  onPress={() => deliverFollowUp.mutate(followUp)}
                />
              )}
              {steer && !agentActive && (
                <EvButton
                  size="sm"
                  variant={change === null && followUp === null ? "primary" : "outline"}
                  label={resume.isPending ? "resuming…" : "Resume"}
                  onPress={() => resume.mutate({ sessionId: session.id, harness: null })}
                />
              )}
              {steer && canOpenShell && (
                <EvButton
                  size="sm"
                  variant="outline"
                  label={openShell.isPending ? "opening…" : "Shell"}
                  disabled={openShell.isPending}
                  onPress={openTerminal}
                />
              )}
              <View style={{ flex: 1 }} />
              {agentActive && canStop && (
                <EvButton
                  size="sm"
                  variant="ghost"
                  label={stop.isPending ? "…" : "Stop session"}
                  onPress={() => stop.mutate(session.id)}
                />
              )}
            </View>
          )}
          {steer ? null : (
            <MonoText tone="faint" size={11} numberOfLines={2}>
              only the owner steers this session · you can read it and review the change
            </MonoText>
          )}
          {shellError === null ? null : (
            <MonoText tone="danger" size={11} numberOfLines={2}>
              {shellError}
            </MonoText>
          )}
        </View>
        {conversation}
      </View>
    </>
  );
}
