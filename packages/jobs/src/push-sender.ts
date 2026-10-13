import { type ProjectId, type SessionId } from "@mend/domain";
import { Effect, Redacted, Schema } from "effect";
import * as Context from "effect/Context";

/** A phone notification; transport credentials stay redacted until final I/O. */
export interface PushMessage {
  readonly token: Redacted.Redacted<string>;
  readonly title: string;
  readonly body: string;
  readonly data: { readonly sessionId: SessionId; readonly projectId: ProjectId };
}

/** Safe transport diagnostics: never carries tokens, message contents or provider bodies. */
export class PushSendError extends Schema.TaggedErrorClass<PushSendError>()("PushSendError", {
  reason: Schema.Literals(["request", "rejected", "response"]),
  status: Schema.optionalKey(Schema.Number),
}) {
  /** A bounded diagnostic suitable for the notifier warning log. */
  override get message(): string {
    return `Push delivery failed: ${this.reason}${this.status === undefined ? "" : ` (${this.status})`}`;
  }
}

/** Delivers notifications once and reports only tokens the provider says are unavailable. */
export class PushSender extends Context.Service<
  PushSender,
  {
    readonly send: (
      messages: ReadonlyArray<PushMessage>,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, PushSendError>;
  }
>()("@mend/jobs/PushSender") {}
