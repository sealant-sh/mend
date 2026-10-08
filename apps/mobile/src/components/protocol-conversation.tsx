import { LegendList } from "@legendapp/list/react-native";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  agentTaskOf,
  answersComplete,
  buildAgentConversation,
  composeAnswers,
  conversationActivity,
  EMPTY_CONVERSATION,
  isHarnessTurn,
  itemFailed,
  itemName,
  openTurnOf,
  recordedAnswers as recordedAnswersOf,
  requestAsk,
  requestDetailText,
  requestName,
  requestOutcome,
  toggleChoice,
  turnPayerLine,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentRequestResponse,
  type AnswerChoices,
  type WrittenAnswers,
} from "@mend/agent-conversation";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";

import { EvButton } from "@/components/button";
import {
  AttachButton,
  AttachmentStrip,
  ComposerField,
  ComposerTextInput,
  TurnImages,
} from "@/components/composer";
import { MendMarkdown } from "@/components/markdown";
import { ComposerDock, usePaneEdges } from "@/components/pane";
import { SessionPullRequest } from "@/components/pull-request-card";
import { TaskCard } from "@/components/task-card";
import { MonoText, UiText } from "@/components/typography";
import {
  useAgentConversation,
  useAgentConversationActions,
  useTurnSender,
} from "@/data/agent-conversation";
import { findLastMatching } from "@/data/collections";
import { composerReadiness, readinessHint, storedImages, type Attachment } from "@/data/composer";
import { useComposerAttachments } from "@/data/image-attach";
import { useConversationWait, useOrganizationMembers, useSession } from "@/data/live";
import { hasUnrecordedSend, reconcileConversation, type TurnView } from "@/data/pending-turns";
import {
  pullRequestCards,
  withPullRequests,
  type ConversationRowWithPullRequests as Row,
} from "@/data/pull-requests";
import { readsWaiting } from "@/data/shared-workspace";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

/**
 * One message from a person. A send from this phone shows at once, faded while it goes up, and
 * stays where it is — marked, with Retry and Edit — when the machine refused it.
 */
const TurnRow = memo(function TurnRow({
  view,
  onRetry,
  onEdit,
}: {
  readonly view: TurnView;
  readonly onRetry: (clientId: string) => void;
  readonly onEdit: (clientId: string) => void;
}) {
  const { colors } = useEvidenceTheme();
  const { clientId } = view;
  const members = useOrganizationMembers().data;
  // Whose login paid, when it was not the sender's (docs/adr/0013).
  const payerLine = useMemo(
    () =>
      view.turn === null
        ? null
        : turnPayerLine(
            view.turn,
            new Map((members ?? []).map((member) => [member.userId, member.name])),
          ),
    [view.turn, members],
  );
  if (view.turn !== null && isHarnessTurn(view.turn)) {
    // Nobody sent this one: the agent opened it to answer a background task that ended.
    return (
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: colors.rule,
          paddingLeft: 11,
          paddingVertical: 2,
        }}
      >
        <MonoText tone="faint" size={11}>
          the agent continued · {view.text}
        </MonoText>
      </View>
    );
  }
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "85%", alignItems: "flex-end", gap: 4 }}>
      <View
        style={{
          backgroundColor: colors.wash,
          borderRadius: radius.xl,
          borderBottomRightRadius: 6,
          borderLeftWidth: view.delivery === "failed" ? 2 : 0,
          borderLeftColor: view.delivery === "failed" ? colors.red : "transparent",
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 8,
          opacity: view.delivery === "sending" ? 0.6 : 1,
        }}
      >
        <TurnImages images={view.images} />
        {view.text === "" ? null : (
          <UiText size={15} style={{ lineHeight: 21 }}>
            {view.text}
          </UiText>
        )}
        {view.delivery !== "failed" && view.error !== null ? (
          <MonoText tone="danger" size={10.5}>
            {view.error}
          </MonoText>
        ) : null}
      </View>
      {view.delivery === "sending" ? (
        <MonoText tone="faint" size={10.5}>
          sending…
        </MonoText>
      ) : null}
      {payerLine === null ? null : (
        <MonoText tone="faint" size={10.5}>
          {payerLine}
        </MonoText>
      )}
      {view.delivery === "failed" && clientId !== null ? (
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <MonoText tone="danger" size={10.5} numberOfLines={3}>
            not sent · {view.error ?? "the machine did not answer"}
          </MonoText>
          <View style={{ flexDirection: "row", gap: 4 }}>
            <EvButton size="sm" variant="ghost" label="Edit" onPress={() => onEdit(clientId)} />
            <EvButton size="sm" variant="outline" label="Retry" onPress={() => onRetry(clientId)} />
          </View>
        </View>
      ) : null}
    </View>
  );
});

function ItemRow({ item }: { readonly item: AgentItemDto }) {
  const { colors } = useEvidenceTheme();
  const task = agentTaskOf(item);
  if (task !== null) {
    return <TaskCard task={task} />;
  }
  if (item.kind === "assistant-message" && item.text !== null) {
    return (
      <View style={{ paddingHorizontal: 2 }}>
        <MendMarkdown>{item.text}</MendMarkdown>
      </View>
    );
  }
  if (item.kind === "reasoning") {
    return (
      <MonoText tone="faint" size={11} numberOfLines={3} style={{ paddingHorizontal: 2 }}>
        {item.text ?? item.title ?? "reasoning"}
        {item.status === "in-progress" ? " ▍" : ""}
      </MonoText>
    );
  }
  if (item.kind === "plan" && item.text !== null) {
    return (
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: colors.rule,
          paddingLeft: 11,
          paddingVertical: 2,
        }}
      >
        <MendMarkdown>{item.text}</MendMarkdown>
      </View>
    );
  }

  const failure = itemFailed(item);
  return (
    <View
      style={{
        backgroundColor: colors.sunken,
        borderRadius: radius.md,
        borderLeftWidth: failure ? 2 : 0,
        borderLeftColor: failure ? colors.red : "transparent",
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 3,
      }}
    >
      <MonoText tone={failure ? "danger" : "ink2"} size={11.5}>
        {itemName(item)}
        {item.status === "in-progress" ? " ▍" : ""}
      </MonoText>
      {item.text === null || item.text === "" ? null : (
        <MonoText tone="faint" size={10.5} numberOfLines={4}>
          {item.text}
        </MonoText>
      )}
    </View>
  );
}

function RequestRow({
  request,
  responding,
  onRespond,
}: {
  readonly request: AgentRequestDto;
  readonly responding: boolean;
  readonly onRespond: (requestId: string, response: AgentRequestResponse) => void;
}) {
  const { colors } = useEvidenceTheme();
  const [selected, setSelected] = useState<AnswerChoices>({});
  const [written, setWritten] = useState<WrittenAnswers>({});
  const pending = request.status === "pending";
  const questions = request.questions ?? [];
  const ask = requestAsk(request);
  const expectsAnswers = ask !== "decision";
  const hasQuestions = ask === "answers";
  const detail = requestDetailText(request.detail);
  const recordedAnswers = recordedAnswersOf(request);

  const toggle = (questionId: string, label: string, multiSelect: boolean) => {
    setSelected((current) => toggleChoice(current, questionId, label, multiSelect));
  };
  const answer = () => {
    onRespond(request.id, { answers: composeAnswers(questions, selected, written) });
  };
  const canAnswer = answersComplete(questions, selected, written);
  let answerLabel = hasQuestions ? "Send answer" : "Continue";
  if (responding) {
    answerLabel = "Sending…";
  }
  let pendingAction = null;
  if (pending && expectsAnswers && hasQuestions) {
    pendingAction = (
      <EvButton
        size="sm"
        label={answerLabel}
        disabled={!canAnswer || responding}
        onPress={answer}
      />
    );
  } else if (pending && expectsAnswers) {
    pendingAction = (
      <MonoText tone="danger" size={11}>
        The provider did not include a question. Stop and resume the session.
      </MonoText>
    );
  } else if (pending) {
    pendingAction = (
      <>
        <EvButton
          size="sm"
          label="Allow once"
          disabled={responding}
          onPress={() => onRespond(request.id, { decision: "accept" })}
        />
        <EvButton
          size="sm"
          variant="outline"
          label="Allow for session"
          disabled={responding}
          onPress={() => onRespond(request.id, { decision: "accept-for-session" })}
        />
        <EvButton
          size="sm"
          variant="ghost"
          label="Decline"
          disabled={responding}
          onPress={() => onRespond(request.id, { decision: "decline" })}
        />
      </>
    );
  }

  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.rule,
        borderLeftWidth: 2,
        borderLeftColor: pending ? colors.amber : colors.rule,
        borderRadius: radius.lg,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ gap: 2 }}>
        <UiText weight="medium">{requestName(request)}</UiText>
        {!pending && (
          <MonoText tone="faint" size={10.5}>
            {requestOutcome(request)}
          </MonoText>
        )}
        {detail === null ? null : (
          <MonoText tone="muted" size={11}>
            {detail}
          </MonoText>
        )}
        {recordedAnswers.map((recorded) => (
          <View key={recorded.question} style={{ paddingTop: 4 }}>
            <UiText tone="muted" size={11.5}>
              {recorded.question}
            </UiText>
            <MonoText tone="ink2" size={11}>
              {recorded.answers.join(", ")}
            </MonoText>
          </View>
        ))}
      </View>

      {pending && hasQuestions
        ? questions.map((question) => (
            <View key={question.id} style={{ gap: 7 }}>
              <UiText weight="medium" size={12.5}>
                {question.header ?? question.question}
              </UiText>
              {question.header === null ? null : (
                <UiText tone="muted" size={12.5}>
                  {question.question}
                </UiText>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {question.options.map((option) => {
                  const chosen = selected[question.id]?.includes(option.label) ?? false;
                  return (
                    <Pressable
                      key={option.label}
                      onPress={() => toggle(question.id, option.label, question.multiSelect)}
                      style={{
                        borderWidth: 1,
                        borderColor: chosen ? colors.accent : colors.rule,
                        backgroundColor: chosen ? colors.wash : colors.panel,
                        borderRadius: radius.lg,
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        maxWidth: "100%",
                      }}
                    >
                      <UiText tone={chosen ? "accent" : "ink2"} size={12}>
                        {option.label}
                      </UiText>
                      {option.description === null ? null : (
                        <UiText tone="faint" size={11}>
                          {option.description}
                        </UiText>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={written[question.id] ?? ""}
                onChangeText={(value) =>
                  setWritten((current) => ({ ...current, [question.id]: value }))
                }
                placeholder="Write an answer"
                placeholderTextColor={colors.faint}
                multiline
                style={{
                  minHeight: 38,
                  maxHeight: 100,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.rule,
                  borderRadius: radius.lg,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  color: colors.ink,
                  backgroundColor: colors.bg,
                  fontSize: 14,
                }}
              />
            </View>
          ))
        : null}

      {pendingAction === null ? null : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>{pendingAction}</View>
      )}
    </View>
  );
}

function ConversationRow({
  sessionId,
  entry,
  responding,
  onRespond,
  onRetry,
  onEdit,
}: {
  readonly sessionId: string;
  readonly entry: Row;
  readonly responding: boolean;
  readonly onRespond: (requestId: string, response: AgentRequestResponse) => void;
  readonly onRetry: (clientId: string) => void;
  readonly onEdit: (clientId: string) => void;
}) {
  switch (entry.kind) {
    case "pull-request":
      return <SessionPullRequest sessionId={sessionId} card={entry.card} />;
    case "turn":
      return <TurnRow view={entry.view} onRetry={onRetry} onEdit={onEdit} />;
    case "item":
      return <ItemRow item={entry.item} />;
    case "request":
      return <RequestRow request={entry.request} responding={responding} onRespond={onRespond} />;
  }
}

export function ProtocolConversation({
  sessionId,
  active,
  starting = false,
  summary,
}: {
  readonly sessionId: string;
  readonly active: boolean;
  /** The session is still provisioning — the composer can't deliver yet. */
  readonly starting?: boolean;
  readonly summary: string | null;
}) {
  const { colors } = useEvidenceTheme();
  const pane = usePaneEdges();
  const conversation = useAgentConversation(sessionId, true, active);
  const { respond, interrupt } = useAgentConversationActions(sessionId);
  const sender = useTurnSender(sessionId);
  const images = useComposerAttachments(sessionId);
  const listRef = useRef<LegendListRef>(null);
  const [draft, setDraft] = useState("");
  const [composerHeight, setComposerHeight] = useState(64);
  // Stop was pressed while the message it would stop was still on its way.
  const [stopWaiting, setStopWaiting] = useState(false);
  const keyboard = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const data = conversation.data ?? EMPTY_CONVERSATION;
  const entries = useMemo(
    () => buildAgentConversation(conversation.data ?? EMPTY_CONVERSATION),
    [conversation.data],
  );
  const sessionRead = useSession(sessionId).data;
  // What holds the next sender's turn, as both people see it (docs/adr/0016, decision 6): shown
  // to every reader, steering or not; read only while someone is live in the executor and
  // control is shared, and re-read on a timer while this phone's composer is live.
  const readsWait = readsWaiting(sessionRead?.session);
  const waitRead = useConversationWait(sessionId, active, readsWait).data ?? null;
  const waiting = readsWait ? waitRead : null;
  const landings = sessionRead?.landings;
  const cards = useMemo(() => pullRequestCards(landings ?? []), [landings]);
  const rows = useMemo(
    () => withPullRequests(reconcileConversation(entries, sender.pending), cards),
    [entries, sender.pending, cards],
  );
  const openTurn = openTurnOf(data.turns);
  // A send the conversation has not read back yet already has the agent busy: the working line
  // and Stop show from the tap, not from the next poll.
  const sendOnItsWay = hasUnrecordedSend(entries, sender.pending);
  const activity = conversationActivity(data) ?? (sendOnItsWay ? "working" : null);
  const readiness = composerReadiness({ draft, attachments: images.attachments, starting });
  // A sticky composer floats over the list's end; in a pane it sits below it.
  const bottomPad = pane.sticky
    ? (keyboard.isVisible ? keyboard.height : pane.bottom) +
      (active ? composerHeight + spacing.xs : spacing.md)
    : spacing.md;
  const onRespond = useCallback(
    (requestId: string, response: AgentRequestResponse) => {
      respond.mutate({ requestId, response });
    },
    [respond],
  );

  const send = () => {
    if (!readiness.canSend) return;
    sender.send(draft, storedImages(images.attachments));
    setDraft("");
    images.clear();
    // Following the end already keeps a reader who is there; one who scrolled back and sends
    // wants to see what they sent.
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  };

  const stop = () => {
    if (openTurn !== undefined) {
      interrupt.mutate(openTurn.id);
      return;
    }
    const recorded = new Set(data.turns.map((turn) => turn.id));
    const latest = findLastMatching(
      sender.pending,
      (turn) =>
        turn.status === "sending" ||
        (turn.status === "sent" && turn.turnId !== null && !recorded.has(turn.turnId)),
    );
    if (latest === undefined) return;
    if (latest.turnId !== null) {
      interrupt.mutate(latest.turnId);
      return;
    }
    setStopWaiting(true);
    const stopWhenRecorded = async () => {
      const turnId = await sender.turnIdOf(latest.clientId);
      setStopWaiting(false);
      if (turnId !== null) interrupt.mutate(turnId);
    };
    void stopWhenRecorded();
  };

  const onRetry = (clientId: string) => sender.retry(clientId);
  const onEdit = (clientId: string) => {
    const failed = sender.pending.find((turn) => turn.clientId === clientId);
    if (failed === undefined) return;
    setDraft((current) => (current.trim() === "" ? failed.text : `${failed.text}\n${current}`));
    images.restore(
      failed.images.map(
        (image, index): Attachment => ({
          id: `${clientId}:${index}`,
          uri: image.uri,
          name: image.name,
          phase: { kind: "stored", path: image.path, bytes: 0 },
        }),
      ),
    );
    sender.discard(clientId);
  };

  const actionError = respond.error ?? interrupt.error;
  let emptyMessage: string | null = summary ?? "no conversation recorded";
  if (conversation.isLoading) {
    emptyMessage = "reading the conversation…";
  } else if (conversation.isError) {
    emptyMessage = conversation.error.message;
  } else if (active) {
    // The composer strip carries the live hint — it must track the keyboard
    // and the session's real phase, which a list empty-state cannot.
    emptyMessage = null;
  }
  // One line, one truth: the same phase the header's status word shows.
  let composerHint: string | null = readinessHint(readiness, images.attachments.length);
  if (active && starting) {
    composerHint = "starting up — the conversation opens when the agent is ready…";
  } else if (composerHint === null && active && rows.length === 0 && !conversation.isLoading) {
    composerHint = "ready for your first message";
  }
  const canStop = openTurn !== undefined || sendOnItsWay;

  return (
    <View style={{ flex: 1 }}>
      <LegendList
        ref={listRef}
        data={rows}
        keyExtractor={(entry) => entry.key}
        getItemType={(entry) =>
          entry.kind === "item" ? `${entry.kind}:${entry.item.kind}` : entry.kind
        }
        renderItem={({ item }) => (
          <ConversationRow
            sessionId={sessionId}
            entry={item}
            responding={respond.isPending}
            onRespond={onRespond}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        )}
        estimatedItemSize={76}
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
          waiting === null && !(active && activity !== null) ? null : (
            <View style={{ paddingHorizontal: 2, paddingTop: 4, gap: 4 }}>
              {waiting === null ? null : (
                <MonoText tone="ink2" size={11.5}>
                  {waiting.line}
                </MonoText>
              )}
              {active && activity !== null ? (
                <MonoText tone="faint" size={11.5}>
                  {activity === "waiting" ? "waiting for your answer" : "working…"}
                </MonoText>
              ) : null}
            </View>
          )
        }
        ListEmptyComponent={
          emptyMessage === null ? null : <MonoText tone="faint">{emptyMessage}</MonoText>
        }
      />
      {active && (
        <ComposerDock>
          {actionError instanceof Error ? (
            <View
              style={{ alignItems: "center", paddingVertical: 4, backgroundColor: colors.sunken }}
            >
              <MonoText tone="danger" size={11} numberOfLines={2}>
                {actionError.message}
              </MonoText>
            </View>
          ) : null}
          {composerHint === null ? null : (
            <View
              style={{ alignItems: "center", paddingVertical: 4, backgroundColor: colors.sunken }}
            >
              <MonoText
                tone={!readiness.canSend && readiness.reason === "failed" ? "danger" : "faint"}
                size={11}
              >
                {composerHint}
              </MonoText>
            </View>
          )}
          <View
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 6,
              paddingLeft: 4,
              paddingRight: 10,
              paddingTop: 8,
              paddingBottom: keyboard.isVisible ? 8 : pane.bottom + 4,
              backgroundColor: colors.panel,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.softRule,
            }}
          >
            <AttachButton
              room={images.room}
              held={images.attachments.length}
              disabled={starting}
              onChosen={images.attach}
            />
            <ComposerField>
              <AttachmentStrip
                attachments={images.attachments}
                onRemove={images.remove}
                onRetry={images.retry}
              />
              <ComposerTextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Message the session…"
              />
            </ComposerField>
            {canStop && (
              <EvButton
                variant="ghost"
                label={interrupt.isPending || stopWaiting ? "…" : "Stop"}
                disabled={interrupt.isPending || stopWaiting}
                onPress={stop}
              />
            )}
            <EvButton label="Send" onPress={send} disabled={!readiness.canSend} />
          </View>
        </ComposerDock>
      )}
    </View>
  );
}
