import { DispatchAttemptId, type SessionId, type SessionProcessId } from "@mend/domain";
import { Effect } from "effect";

import { AgentConversationRepo } from "../src/repos/agent-conversation.ts";

export const NO_PAYER = { userId: null, accountId: null, accountName: null };

/** A fresh dispatch's attempt, as the host makes one before each claim. */
export const newAttempt = () => DispatchAttemptId.make(crypto.randomUUID());

/** Claim the process's next turn and bind it to the provider turn its send started. */
export const sendNext = (
  sessionId: SessionId,
  processId: SessionProcessId,
  providerTurnId: string,
) =>
  Effect.gen(function* () {
    const repo = yield* AgentConversationRepo;
    const attempt = newAttempt();
    const claimed = yield* repo.claimNextTurn(processId, attempt);
    if (claimed === null) return yield* Effect.die("nothing to send");
    const bound = yield* repo.bindOwnSend(
      { sessionId, processId, attempt },
      providerTurnId,
      NO_PAYER,
    );
    if (bound === null) return yield* Effect.die("the send was not bound");
    return bound;
  });
