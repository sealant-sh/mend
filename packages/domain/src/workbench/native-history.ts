import { Schema } from "effect";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const NativeId = Schema.String.check(Schema.isPattern(/\S/));
const MessageId = Schema.String.check(Schema.isUUID());

/** Provider identity through the selected completed response, inclusive. No time estimates. */
export const NativeTurnCutoff = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("codex"),
    threadId: NativeId,
    throughTurnId: NativeId,
    historyMode: Schema.Literals(["legacy", "paginated"]),
  }),
  Schema.Struct({
    provider: Schema.Literal("claude"),
    sessionId: NativeId,
    throughMessageId: MessageId,
  }),
]);
export type NativeTurnCutoff = typeof NativeTurnCutoff.Type;

/** Native evidence observed by the adapter at completion, before another turn is dispatched. */
export const NativeHistoryObservation = Schema.Struct({
  cutoff: NativeTurnCutoff,
  providerVersion: NativeId,
});
export type NativeHistoryObservation = typeof NativeHistoryObservation.Type;

const conversationPath = (value: string): boolean =>
  !value.split("/").some((part) => part === ".." || part === "." || part === "") &&
  (/^\.codex\/(?:sessions|archived_sessions)\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9T:_.-]+\.jsonl$/.test(
    value,
  ) ||
    /^\.claude\/projects\/[^/]+\/[a-f0-9-]{36}\.jsonl$/.test(value));

/** A digest of an allowlisted conversation file, relative to its private provider home. */
export const NativeFileRef = Schema.Struct({
  relativePath: Schema.String.check(Schema.makeFilter(conversationPath)),
  sha256: Digest,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type NativeFileRef = typeof NativeFileRef.Type;

/** Immutable seed files live in Mend storage, independently of the source session's lifetime. */
export const NativeSeedId = Schema.String.pipe(Schema.brand("NativeSeedId"));
export type NativeSeedId = typeof NativeSeedId.Type;

export const NativeHistorySeed = Schema.Struct({
  id: NativeSeedId,
  format: Schema.Literal(1),
  providerVersion: NativeId,
  cutoff: NativeTurnCutoff,
  selectedFile: NativeFileRef,
  manifestDigest: Digest,
  files: Schema.Array(NativeFileRef),
});
export type NativeHistorySeed = typeof NativeHistorySeed.Type;
