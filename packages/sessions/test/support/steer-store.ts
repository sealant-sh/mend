import { SessionStoppingError, AgentTurnNotFoundError, type AgentConversationRepo } from "@mend/db";
import {
  SessionMessageId,
  AgentTurnId,
  AgentTurnSteerId,
  type SessionProcessId,
} from "@mend/domain";
import {
  MessageKeyConflictError,
  TurnSteerForbiddenError,
  messageOutcome,
  type SendMessageInput,
  type MessageTurnReason,
  type SessionMessageResult,
  AgentTurn,
  AgentTurnSteer,
  ConversationTurn,
  turnSteerSender,
  type AgentProtocolControl,
} from "@mend/domain/workbench";
import { Effect } from "effect";

type SteerMethods = Pick<
  AgentConversationRepo["Service"],
  | "messageByClientId"
  | "messageById"
  | "admitSteerMessage"
  | "admitTurnMessage"
  | "withdrawMessageTurn"
  | "admitTurnSteer"
  | "steerByClientId"
  | "settleTurnSteer"
  | "queueTurnSteer"
  | "withdrawTurnSteer"
  | "recoverSendingSteers"
  | "recordProtocolControl"
  | "protocolControls"
  | "listConversationTurns"
>;

export const makeSteerStore = (
  turns: Map<AgentTurnId, AgentTurn>,
  stopping: () => boolean = () => false,
): SteerMethods => {
  const steers = new Map<AgentTurnSteerId, AgentTurnSteer>();
  const journal = new Map<SessionProcessId, Array<AgentProtocolControl>>();
  const get = (id: AgentTurnSteerId) => {
    const steer = steers.get(id);
    if (steer === undefined) throw new Error(`unknown steer ${id}`);
    return steer;
  };
  const messages = new Map<
    SessionMessageId,
    { input: SendMessageInput; reason: MessageTurnReason | null; result: SessionMessageResult }
  >();
  const readMessage = (id: SessionMessageId): SessionMessageResult => {
    const saved = messages.get(id);
    if (saved === undefined) throw new Error("message missing");
    const result = saved.result;
    if (result._tag === "Steer")
      return messageOutcome({ ...result, steer: get(result.steer.id) }, null);
    const turn = turns.get(result.turn.id);
    if (turn === undefined) throw new Error("message turn missing");
    return messageOutcome({ ...result, turn }, saved.reason);
  };
  const withdrawUntaken = (id: AgentTurnId, processId: SessionProcessId) => {
    const turn = turns.get(id);
    if (
      turn?.status !== "queued" ||
      turn.processId !== processId ||
      turn.startedAt !== null ||
      turn.providerTurnId !== null
    )
      return false;
    turns.set(id, new AgentTurn({ ...turn, status: "cancelled", endedAt: new Date() }));
    return true;
  };
  const methods: SteerMethods = {
    messageById: (id) => Effect.sync(() => readMessage(id)),
    messageByClientId: (input) =>
      Effect.suspend(() => {
        const saved =
          input.clientMessageId === null
            ? undefined
            : [...messages.values()].find(
                (row) =>
                  row.input.sender === input.sender &&
                  row.input.clientMessageId?.toLowerCase() === input.clientMessageId?.toLowerCase(),
              );
        if (saved === undefined || input.clientMessageId === null) return Effect.succeed(null);
        if (
          saved.input.sessionId !== input.sessionId ||
          saved.input.input !== input.input ||
          saved.input.intent !== input.intent
        )
          return Effect.fail(
            new MessageKeyConflictError({
              clientMessageId: input.clientMessageId,
              message: "This message key was already used for another request.",
            }),
          );
        return Effect.succeed(readMessage(saved.result.messageId));
      }),
    admitSteerMessage: (input, turnId) =>
      Effect.gen(function* () {
        const replay = yield* methods.messageByClientId(input);
        if (replay !== null) return { _tag: "Replay", result: replay };
        if (stopping()) return yield* new SessionStoppingError({ sessionId: input.sessionId });
        const turn = turns.get(turnId);
        if (turn === undefined || turn.sessionId !== input.sessionId)
          return yield* new AgentTurnNotFoundError({ turnId });
        if (turnSteerSender(turn) !== input.sender)
          return yield* new TurnSteerForbiddenError({
            turnId: turn.id,
            reason: turnSteerSender(turn) === null ? "no-sender" : "not-sender",
            message: "Only this turn's sender may steer it.",
          });
        const { steer } = yield* methods.admitTurnSteer({
          turnId: turn.id,
          author: input.sender,
          input: input.input,
          clientSteerId: null,
        });
        const messageId = SessionMessageId.make(crypto.randomUUID());
        const result = messageOutcome({ _tag: "Steer", messageId, steer }, null);
        messages.set(messageId, { input, reason: null, result });
        return { _tag: "Created", result };
      }),
    admitTurnMessage: (input, processId, reason) =>
      Effect.gen(function* () {
        const replay = yield* methods.messageByClientId(input);
        if (replay !== null) return { _tag: "Replay", result: replay };
        if (stopping()) return yield* new SessionStoppingError({ sessionId: input.sessionId });
        const turn = new AgentTurn({
          id: AgentTurnId.make(crypto.randomUUID()),
          sessionId: input.sessionId,
          processId,
          ordinal: Math.max(-1, ...[...turns.values()].map((row) => row.ordinal)) + 1,
          author: input.sender,
          input: input.input,
          status: "queued",
          providerTurnId: null,
          error: null,
          usage: null,
          createdAt: new Date(),
          startedAt: null,
          endedAt: null,
        });
        turns.set(turn.id, turn);
        const messageId = SessionMessageId.make(crypto.randomUUID());
        const result = messageOutcome({ _tag: "Turn", messageId, turn }, reason);
        messages.set(messageId, { input, reason, result });
        return { _tag: "Created", result };
      }),
    withdrawMessageTurn: (id, processId) => Effect.sync(() => withdrawUntaken(id, processId)),
    listConversationTurns: () =>
      Effect.sync(() =>
        [...turns.values()]
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map(
            (turn) =>
              new ConversationTurn({
                ...turn,
                steerSender: turnSteerSender(turn),
                steers: [...steers.values()].filter((steer) => steer.turnId === turn.id),
                fromSteer:
                  [...steers.values()].find((steer) => steer.queuedTurnId === turn.id)?.id ?? null,
              }),
          ),
      ),
    admitTurnSteer: (input) =>
      Effect.suspend((): ReturnType<SteerMethods["admitTurnSteer"]> => {
        const existing =
          input.clientSteerId === null
            ? undefined
            : [...steers.values()].find(
                (steer) =>
                  steer.author === input.author && steer.clientSteerId === input.clientSteerId,
              );
        if (existing !== undefined) return Effect.succeed({ steer: existing, created: false });
        const turn = turns.get(input.turnId);
        if (turn === undefined)
          return Effect.fail(new AgentTurnNotFoundError({ turnId: input.turnId }));
        const steer = new AgentTurnSteer({
          id: AgentTurnSteerId.make(crypto.randomUUID()),
          sessionId: turn.sessionId,
          processId: turn.processId,
          turnId: turn.id,
          author: input.author,
          input: input.input,
          clientSteerId: input.clientSteerId,
          ordinal: [...steers.values()].filter((row) => row.turnId === turn.id).length,
          delivery: { _tag: "Sending" },
          queuedTurnId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        steers.set(steer.id, steer);
        return Effect.succeed({ steer, created: true });
      }),
    steerByClientId: (author, key) =>
      Effect.sync(
        () =>
          [...steers.values()].find(
            (steer) => steer.author === author && steer.clientSteerId === key,
          ) ?? null,
      ),
    settleTurnSteer: (id, delivery) =>
      Effect.sync(() => {
        const steer = get(id);
        if (steer.delivery._tag !== "Sending") return steer;
        const settled = new AgentTurnSteer({ ...steer, delivery, updatedAt: new Date() });
        steers.set(id, settled);
        return settled;
      }),
    queueTurnSteer: (id, processId, reason) =>
      Effect.suspend(() => {
        const steer = get(id);
        if (steer.delivery._tag !== "Sending") return Effect.succeed(steer);
        if (processId === null || stopping())
          return methods.settleTurnSteer(id, {
            _tag: "NotSent",
            reason,
          });
        const turn = new AgentTurn({
          id: AgentTurnId.make(crypto.randomUUID()),
          sessionId: steer.sessionId,
          processId,
          author: steer.author,
          ordinal: Math.max(-1, ...[...turns.values()].map((entry) => entry.ordinal)) + 1,
          input: steer.input,
          status: "queued",
          providerTurnId: null,
          error: null,
          usage: null,
          createdAt: new Date(),
          startedAt: null,
          endedAt: null,
        });
        turns.set(turn.id, turn);
        const queued = new AgentTurnSteer({
          ...steer,
          delivery: { _tag: "Queued", turnId: turn.id, reason },
          queuedTurnId: turn.id,
          updatedAt: new Date(),
        });
        steers.set(id, queued);
        return Effect.succeed(queued);
      }),
    withdrawTurnSteer: (id, processId) =>
      Effect.sync(() => {
        const steer = get(id);
        const delivery = steer.delivery;
        if (delivery._tag !== "Queued" || !withdrawUntaken(delivery.turnId, processId))
          return steer;
        const withdrawn = new AgentTurnSteer({
          ...steer,
          delivery: {
            _tag: "NotSent",
            reason: delivery.reason,
          },
          queuedTurnId: null,
          updatedAt: new Date(),
        });
        steers.set(id, withdrawn);
        return withdrawn;
      }),
    recoverSendingSteers: (processId) =>
      Effect.gen(function* () {
        for (const steer of steers.values()) {
          if (processId === steer.processId)
            yield* methods.settleTurnSteer(steer.id, { _tag: "Unknown", reason: "restart" });
        }
      }),
    recordProtocolControl: (processId, control) =>
      Effect.sync(() => {
        const controls = journal.get(processId) ?? [];
        if (!controls.some((stored) => stored.ordinal === control.ordinal)) controls.push(control);
        journal.set(processId, controls);
      }),
    protocolControls: (processId) => Effect.sync(() => journal.get(processId) ?? []),
  };
  return methods;
};
