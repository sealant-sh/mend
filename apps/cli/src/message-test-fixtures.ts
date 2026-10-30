import {
  AgentTurnId,
  AgentTurnSteerId,
  SessionId,
  SessionMessageId,
  SessionProcessId,
} from "@mend/domain";
import {
  AgentTurn,
  AgentTurnSteer,
  messageOutcome,
  type AgentTurnSteerDelivery,
  SessionMessageResult,
} from "@mend/domain/workbench";
import { Schema } from "effect";

export const messageKey = "f19a49d0-7ab8-4cf7-8969-9775145c8149";
export const messageSessionId = SessionId.make("session-1234");
export const messageTurn = new AgentTurn({
  id: AgentTurnId.make("turn-1234"),
  sessionId: messageSessionId,
  processId: SessionProcessId.make("process-1234"),
  ordinal: 0,
  author: "user-1",
  input: "  Keep the words.\n",
  status: "queued",
  providerTurnId: null,
  error: null,
  usage: null,
  createdAt: new Date(0),
  startedAt: null,
  endedAt: null,
});
const messageId = SessionMessageId.make("c9dab604-c239-4827-a6b3-8da108d00828");

export const turnReceipt = (status: AgentTurn["status"] = "queued"): SessionMessageResult =>
  messageOutcome(
    { _tag: "Turn", messageId, turn: new AgentTurn({ ...messageTurn, status }) },
    "queue-requested",
  );

export const steerReceipt = (delivery: AgentTurnSteerDelivery): SessionMessageResult =>
  messageOutcome(
    {
      _tag: "Steer",
      messageId,
      steer: new AgentTurnSteer({
        id: AgentTurnSteerId.make("d662262a-b147-4f97-a8e5-c225f0a41502"),
        sessionId: messageSessionId,
        processId: messageTurn.processId,
        turnId: messageTurn.id,
        ordinal: 0,
        author: "user-1",
        input: messageTurn.input,
        delivery,
        clientSteerId: null,
        queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    },
    null,
  );

export const encodeReceipt = Schema.encodeSync(SessionMessageResult);
