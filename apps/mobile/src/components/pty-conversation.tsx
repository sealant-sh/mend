// A PTY session as a conversation: the transcript the record projects, and a composer that types
// into the agent's terminal. Claude and Codex sessions pick up here in structured mode: the first
// send hands the session off with the typed message as its opening turn.

import { LegendList } from "@legendapp/list/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";

import { EvButton } from "@/components/button";
import { ComposerField, ComposerTextInput } from "@/components/composer";
import { MendMarkdown } from "@/components/markdown";
import { ComposerDock, usePaneEdges } from "@/components/pane";
import { SessionPullRequest } from "@/components/pull-request-card";
import { MonoText, UiText } from "@/components/typography";
import { loadConfig, useSession, useTranscript, type TranscriptEventDto } from "@/data/live";
import { newestPullRequest } from "@/data/pull-requests";
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

export function PtyConversation({
  sessionId,
  active,
  summary,
  pickUp,
  typing = true,
  readOnlyLine = null,
}: {
  readonly sessionId: string;
  readonly active: boolean;
  readonly summary: string | null;
  /**
   * Whether this account types in the terminal: only the owner does, even while control is
   * shared (docs/adr/0013). Without it there is no composer.
   */
  readonly typing?: boolean;
  /**
   * Shown where the composer would be, for a steerer who does not type here: why, and, once the
   * agent has ended, why they do not resume it either (docs/adr/0013).
   */
  readonly readOnlyLine?: string | null;
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
  const pane = usePaneEdges();
  const transcript = useTranscript(sessionId, active);
  const pullRequest = newestPullRequest(useSession(sessionId).data?.landings ?? []);
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
  // The composer types into the terminal: the owner's, or the pickup that hands it off.
  const composing = pickUp !== undefined || (active && typing);
  const docked = composing || readOnlyLine !== null;
  const bottomPad = pane.sticky
    ? (keyboard.isVisible ? keyboard.height : pane.bottom) +
      (docked ? composerHeight + spacing.xs : spacing.md)
    : spacing.md;
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
          <>
            {/* A terminal transcript carries no times: the newest pull request closes it. */}
            {pullRequest === undefined ? null : (
              <SessionPullRequest sessionId={sessionId} card={pullRequest} />
            )}
            {working && active ? (
              <MonoText tone="faint" size={11.5} style={{ paddingHorizontal: 2, paddingTop: 4 }}>
                working…
              </MonoText>
            ) : null}
          </>
        }
        ListEmptyComponent={<MonoText tone="faint">{emptyMessage}</MonoText>}
      />
      {!composing && docked && (
        <ComposerDock>
          <View
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            style={{
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: pane.bottom + 10,
              backgroundColor: colors.panel,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.softRule,
            }}
          >
            <UiText size={13} tone="ink2">
              {readOnlyLine}
            </UiText>
          </View>
        </ComposerDock>
      )}
      {composing && (
        <ComposerDock>
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
              paddingBottom: keyboard.isVisible ? 8 : pane.bottom + 4,
              backgroundColor: colors.panel,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.softRule,
            }}
          >
            <ComposerField>
              <ComposerTextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={
                  pickUp === undefined
                    ? "Message the session…"
                    : "Message the session — continues here in structured mode"
                }
              />
            </ComposerField>
            <EvButton
              label="Send"
              onPress={send}
              disabled={pickUp === undefined ? !tty.canSend : pickUp.pending}
            />
          </View>
        </ComposerDock>
      )}
    </View>
  );
}
