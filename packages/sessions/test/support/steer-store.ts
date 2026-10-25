import { AgentTurnNotFoundError, type AgentConversationRepo } from "@mend/db";
import { AgentTurnId, AgentTurnSteerId, type SessionProcessId } from "@mend/domain";
import {
  AgentTurn,
  AgentTurnSteer,
  ConversationTurn,
  turnSteerSender,
  type AgentProtocolControl,
} from "@mend/domain/workbench";
import { Effect } from "effect";

type SteerMethods = Pick<
  AgentConversationRepo["Service"],
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
  const methods: SteerMethods = {
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
            message: "The session can no longer take a turn. Your words are saved.",
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
    withdrawTurnSteer: (id) =>
      Effect.sync(() => {
        const steer = get(id);
        const delivery = steer.delivery;
        if (delivery._tag !== "Queued") return steer;
        const turn = turns.get(delivery.turnId);
        if (turn?.status !== "queued") return steer;
        turns.set(turn.id, new AgentTurn({ ...turn, status: "cancelled", endedAt: new Date() }));
        const withdrawn = new AgentTurnSteer({
          ...steer,
          delivery: {
            _tag: "NotSent",
            reason: delivery.reason,
            message: "The session can no longer take a turn. Your words are saved.",
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
          if (processId === undefined || processId === steer.processId)
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
