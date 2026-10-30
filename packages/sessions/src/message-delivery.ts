import {
  turnSteerSender,
  MessageTargetAmbiguousError,
  type AgentTurn,
  type MessageChoice,
  type MessageSettings,
  type SendMessageInput,
} from "@mend/domain/workbench";
import { Effect } from "effect";

export const chooseMessageDelivery = (
  input: SendMessageInput,
  settings: MessageSettings,
  turns: ReadonlyArray<AgentTurn>,
): Effect.Effect<MessageChoice, MessageTargetAmbiguousError> => {
  if (input.intent === "queue") return Effect.succeed({ _tag: "Turn", reason: "queue-requested" });
  if (!settings.sendSteersRunningTurn)
    return Effect.succeed({ _tag: "Turn", reason: "steering-off" });
  const candidates = turns.filter(
    (turn) =>
      turn.sessionId === input.sessionId &&
      turn.status === "running" &&
      turnSteerSender(turn) === input.sender,
  );
  if (candidates.length > 1)
    return Effect.fail(
      new MessageTargetAmbiguousError({
        sessionId: input.sessionId,
        message: "Several of your turns are running in this session. Send as a new turn instead.",
      }),
    );
  const turn = candidates[0];
  return Effect.succeed(
    turn === undefined
      ? { _tag: "Turn", reason: "no-own-running-turn" }
      : { _tag: "Steer", turnId: turn.id },
  );
};
