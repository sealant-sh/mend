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
import { PageEntry } from "@/components/page-entry";
import { ComposerDock, usePaneEdges } from "@/components/pane";
import { SessionPullRequest } from "@/components/pull-request-card";
import { TaskCard } from "@/components/task-card";
import { MonoText, UiText } from "@/components/typography";
import {
  ownImages,
  useAgentConversation,
  useAgentConversationActions,
  useMessageSender,
} from "@/data/agent-conversation";
import { composerReadiness, readinessHint } from "@/data/composer";
import {
  conversationRows,
  steerDeliveryWords,
  type SteerView,
  type TurnView,
} from "@/data/conversation-rows";
import { useComposerAttachments } from "@/data/image-attach";
import { useConversationWait, useOrganizationMembers, useSession, useViewerId } from "@/data/live";
import { pageCallFailureOf, pageOfItem, withPagesInPlace } from "@/data/pages";
import {
  pullRequestCards,
  withPullRequests,
  type ConversationRowWithPullRequests as Row,
} from "@/data/pull-requests";
import { KEY_USED, NOT_LOADED, UNCONFIRMED, type MessageOutcome } from "@/data/session-message";
import { readsWaiting } from "@/data/shared-workspace";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

/** One message from a person. */
const TurnRow = memo(function TurnRow({ view }: { readonly view: TurnView }) {
  const { colors } = useEvidenceTheme();
  const members = useOrganizationMembers().data;
  // Whose login paid, when it was not the sender's (docs/adr/0013).
  const payerLine = useMemo(
    () =>
      turnPayerLine(
        view.turn,
        new Map((members ?? []).map((member) => [member.userId, member.name])),
      ),
    [view.turn, members],
  );
  if (isHarnessTurn(view.turn)) {
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
  return <PersonMessage view={view} error={view.error} line={payerLine} />;
});

/** A person's words and images, with an optional error inside and a quiet line under them. */
function PersonMessage({
  view,
  error,
  line,
}: {
  readonly view: Pick<TurnView, "text" | "images">;
  readonly error: string | null;
  readonly line: string | null;
}) {
  const { colors } = useEvidenceTheme();
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "85%", alignItems: "flex-end", gap: 4 }}>
      <View
        style={{
          backgroundColor: colors.wash,
          borderRadius: radius.xl,
          borderBottomRightRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 8,
        }}
      >
        <TurnImages images={view.images} />
        {view.text === "" ? null : (
          <UiText size={15} style={{ lineHeight: 21 }}>
            {view.text}
          </UiText>
        )}
        {error === null ? null : (
          <MonoText tone="danger" size={10.5}>
            {error}
          </MonoText>
        )}
      </View>
      {line === null ? null : (
        <MonoText tone="faint" size={10.5}>
          {line}
        </MonoText>
      )}
    </View>
  );
}

/** Words a person sent into a running turn, with who sent them and what became of them. */
const SteerRow = memo(function SteerRow({ view }: { readonly view: SteerView }) {
  const members = useOrganizationMembers().data;
  const viewerId = useViewerId();
  const { author, delivery } = view.steer;
  const who =
    author === viewerId
      ? "you"
      : ((members ?? []).find((member) => member.userId === author)?.name ?? "a member");
  return (
    <PersonMessage
      view={view}
      error={null}
      line={`${who} steered · ${steerDeliveryWords(delivery)}`}
    />
  );
});

function ItemRow({ item }: { readonly item: AgentItemDto }) {
  const { colors } = useEvidenceTheme();
  const page = pageOfItem(item);
  if (page !== null) {
    return <PageEntry page={page} />;
  }
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

  const pageFailure = pageCallFailureOf(item);
  const failure = itemFailed(item) || pageFailure !== null;
  const text = pageFailure ?? item.text;
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
      {text === null || text === "" ? null : (
        <MonoText tone="faint" size={10.5} numberOfLines={4}>
          {text}
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
}: {
  readonly sessionId: string;
  readonly entry: Row;
  readonly responding: boolean;
  readonly onRespond: (requestId: string, response: AgentRequestResponse) => void;
}) {
  switch (entry.kind) {
    case "pull-request":
      return <SessionPullRequest sessionId={sessionId} card={entry.card} />;
    case "turn":
      return <TurnRow view={entry.view} />;
    case "steer":
      return <SteerRow view={entry.view} />;
    case "item":
      return <ItemRow item={entry.item} />;
    case "request":
      return <RequestRow request={entry.request} responding={responding} onRespond={onRespond} />;
  }
}

/** What Mend said about the last send, quietly: the receipt's own sentence as it came. */
function MessageOutcomeLine({ outcome }: { readonly outcome: MessageOutcome }) {
  const { colors } = useEvidenceTheme();
  let line: { readonly words: string; readonly tone: "ink2" | "danger" | "warning" } | null = null;
  if (outcome._tag === "Answered") line = { words: outcome.explanation, tone: "ink2" };
  else if (outcome._tag === "Refused") line = { words: outcome.words, tone: "danger" };
  else if (outcome._tag === "KeyUsed") {
    line = { words: `${outcome.words} · ${KEY_USED}`, tone: "warning" };
  } else if (outcome._tag === "Unconfirmed") line = { words: UNCONFIRMED, tone: "warning" };
  if (line === null) return null;
  return (
    <View style={{ alignItems: "center", paddingVertical: 4, backgroundColor: colors.sunken }}>
      <MonoText tone={line.tone} size={11} numberOfLines={4}>
        {line.words}
      </MonoText>
    </View>
  );
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
  const message = useMessageSender(sessionId);
  const sending = message.outcome._tag === "Sending";
  const images = useComposerAttachments(sessionId, {
    images: message.draft.images,
    add: message.addImage,
    remove: message.removeImage,
  });
  const listRef = useRef<LegendListRef>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const keyboard = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const data = conversation.data ?? EMPTY_CONVERSATION;
  const entries = useMemo(
    () => withPagesInPlace(buildAgentConversation(conversation.data ?? EMPTY_CONVERSATION)),
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
    () => withPullRequests(conversationRows(entries, ownImages), cards),
    [entries, cards],
  );
  const openTurn = openTurnOf(data.turns);
  const activity = conversationActivity(data);
  const readiness = composerReadiness({
    draft: message.draft.text,
    attachments: images.attachments,
    starting,
  });
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

  const send = async () => {
    if (!message.ready || !readiness.canSend || sending) return;
    if (!(await message.send())) return;
    // Following the end already keeps a reader who is there; one who scrolled back and sends wants
    // to see what they sent.
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
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
  } else if (message.unreadable) {
    composerHint = NOT_LOADED;
  } else if (composerHint === null && active && rows.length === 0 && !conversation.isLoading) {
    composerHint = "ready for your first message";
  }

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
        // LegendList's web build spreads this style onto a DOM element, where `paddingHorizontal`
        // is not a CSS property and the rows would meet the screen's edges.
        contentContainerStyle={{
          paddingLeft: 16,
          paddingRight: 16,
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
          <MessageOutcomeLine outcome={message.outcome} />
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
              disabled={starting || sending || !message.ready}
              onChosen={images.attach}
            />
            <ComposerField>
              <AttachmentStrip
                attachments={images.attachments}
                onRemove={images.remove}
                onRetry={images.retry}
              />
              <ComposerTextInput
                value={message.draft.text}
                onChangeText={message.setText}
                placeholder="Message the session…"
                editable={message.ready && !sending}
              />
            </ComposerField>
            {openTurn !== undefined && (
              <EvButton
                variant="ghost"
                label={interrupt.isPending ? "…" : "Stop"}
                disabled={interrupt.isPending}
                onPress={() => interrupt.mutate(openTurn.id)}
              />
            )}
            <EvButton
              label={sending ? "Sending…" : "Send"}
              onPress={() => void send()}
              disabled={!message.ready || !readiness.canSend || sending}
            />
          </View>
        </ComposerDock>
      )}
    </View>
  );
}
