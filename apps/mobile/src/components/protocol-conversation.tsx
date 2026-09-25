import { LegendList } from "@legendapp/list/react-native";
import {
  answersComplete,
  buildAgentConversation,
  composeAnswers,
  conversationActivity,
  EMPTY_CONVERSATION,
  itemFailed,
  itemName,
  openTurnOf,
  recordedAnswers as recordedAnswersOf,
  requestAsk,
  requestDetailText,
  requestName,
  requestOutcome,
  toggleChoice,
  type AgentConversationEntry,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentRequestResponse,
  type AgentTurnDto,
  type AnswerChoices,
  type WrittenAnswers,
} from "@mend/agent-conversation";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EvButton } from "@/components/button";
import { MendMarkdown } from "@/components/markdown";
import { MonoText, UiText } from "@/components/typography";
import { useAgentConversation, useAgentConversationActions } from "@/data/agent-conversation";
import { radius, spacing, useEvidenceTheme } from "@/theme/evidence";

function TurnRow({ turn }: { readonly turn: AgentTurnDto }) {
  const { colors } = useEvidenceTheme();
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
        {turn.input}
      </UiText>
      {turn.error === null ? null : (
        <MonoText tone="danger" size={10.5} style={{ paddingTop: 4 }}>
          {turn.error}
        </MonoText>
      )}
    </View>
  );
}

function ItemRow({ item }: { readonly item: AgentItemDto }) {
  const { colors } = useEvidenceTheme();
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
  entry,
  responding,
  onRespond,
}: {
  readonly entry: AgentConversationEntry;
  readonly responding: boolean;
  readonly onRespond: (requestId: string, response: AgentRequestResponse) => void;
}) {
  switch (entry.kind) {
    case "turn":
      return <TurnRow turn={entry.turn} />;
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
  const insets = useSafeAreaInsets();
  const conversation = useAgentConversation(sessionId, true, active);
  const { submit, respond, interrupt } = useAgentConversationActions(sessionId);
  const [draft, setDraft] = useState("");
  const [composerHeight, setComposerHeight] = useState(64);
  const keyboard = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const entries = useMemo(
    () => buildAgentConversation(conversation.data ?? EMPTY_CONVERSATION),
    [conversation.data],
  );
  const openTurn = openTurnOf(conversation.data?.turns ?? []);
  const activity = conversationActivity(conversation.data ?? EMPTY_CONVERSATION);
  const bottomPad =
    (keyboard.isVisible ? keyboard.height : insets.bottom) +
    (active ? composerHeight + spacing.xs : spacing.md);
  const onRespond = useCallback(
    (requestId: string, response: AgentRequestResponse) => {
      respond.mutate({ requestId, response });
    },
    [respond],
  );
  const send = () => {
    const text = draft.trim();
    if (text === "") {
      return;
    }
    submit.mutate(text, {
      onSuccess: () => setDraft((current) => (current.trim() === text ? "" : current)),
    });
  };
  const actionError = submit.error ?? respond.error ?? interrupt.error;
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
  let composerHint: string | null = null;
  if (active && starting) {
    composerHint = "starting up — the conversation opens when the agent is ready…";
  } else if (active && entries.length === 0 && !conversation.isLoading) {
    composerHint = "ready for your first message";
  }

  return (
    <View style={{ flex: 1 }}>
      <LegendList
        data={entries}
        keyExtractor={(entry) => entry.key}
        getItemType={(entry) =>
          entry.kind === "item" ? `${entry.kind}:${entry.item.kind}` : entry.kind
        }
        renderItem={({ item }) => (
          <ConversationRow entry={item} responding={respond.isPending} onRespond={onRespond} />
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
          active && activity !== null ? (
            <MonoText tone="faint" size={11.5} style={{ paddingHorizontal: 2, paddingTop: 4 }}>
              {activity === "waiting" ? "waiting for your answer" : "working…"}
            </MonoText>
          ) : null
        }
        ListEmptyComponent={
          emptyMessage === null ? null : <MonoText tone="faint">{emptyMessage}</MonoText>
        }
      />
      {active && (
        <KeyboardStickyView
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: 0 }}
        >
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
              <MonoText tone="faint" size={11}>
                {composerHint}
              </MonoText>
            </View>
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
              placeholder="Message the session…"
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
            {openTurn !== undefined && (
              <EvButton
                variant="ghost"
                label={interrupt.isPending ? "…" : "Stop"}
                disabled={interrupt.isPending}
                onPress={() => interrupt.mutate(openTurn.id)}
              />
            )}
            <EvButton
              label={submit.isPending ? "Sending…" : "Send"}
              onPress={send}
              disabled={submit.isPending || draft.trim() === ""}
            />
          </View>
        </KeyboardStickyView>
      )}
    </View>
  );
}
