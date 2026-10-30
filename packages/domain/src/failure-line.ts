/**
 * A failure on a line other people read (a session's line, a push, an API body, a stored reason).
 * Failure text can carry a person's words: a query error holds the row it wrote, a Node error the
 * path it read, a Schema issue the value it decoded (SLNT-385). So a failure reaches a reader only
 * in words its class approved, through `[ReaderWords]`; every other failure is withheld, logged
 * in full under a reference, and the line names that reference. A new error type is withheld until
 * its class opts in.
 */
import { Cause, Effect } from "effect";

/** The words a failure's class approved for a reader; `undefined` when this one's are not. */
export const ReaderWords: unique symbol = Symbol.for("@mend/domain/ReaderWords");

export interface SaysReaderWords {
  readonly [ReaderWords]: string | undefined;
}

export type LineFailure =
  | { readonly _tag: "Said"; readonly error: unknown; readonly words: string }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Withheld"; readonly name: string };

/** A withheld failure's line, for tests: its category, then the reference its log entry holds. */
export const WITHHELD = /(?:internal error|database operation failed) · reference [0-9a-f]{16}$/;

/** Failures a line may name as the database's, still without their words. */
const DATABASE_FAILURES: ReadonlySet<string> = new Set(["EffectDrizzleQueryError", "SqlError"]);

const nameOf = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null) return typeof failure;
  if ("_tag" in failure && typeof failure._tag === "string") return failure._tag;
  if ("name" in failure && typeof failure.name === "string") return failure.name;
  return "unknown";
};

const approvedWordsOf = (failure: unknown): string | undefined => {
  if (typeof failure !== "object" || failure === null || !(ReaderWords in failure)) {
    return undefined;
  }
  const words = failure[ReaderWords];
  return typeof words === "string" ? words : undefined;
};

/** The failure a line names, in `Cause.squash`'s order: the first failure, else the first defect. */
export const lineFailureOf = (cause: Cause.Cause<unknown>): LineFailure => {
  if (!cause.reasons.some((reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason))) {
    return { _tag: "Interrupted" };
  }
  const failure = Cause.squash(cause);
  const words = approvedWordsOf(failure);
  return words === undefined
    ? { _tag: "Withheld", name: nameOf(failure) }
    : { _tag: "Said", error: failure, words };
};

/** A failure named for a log, never quoted. */
export const failureName = (cause: Cause.Cause<unknown>): string => nameOf(Cause.squash(cause));

const newReference = Effect.sync(() =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(""),
);

/**
 * A failure as a line says it, and the reference of the log entry that holds it when its words
 * were withheld (`null` when they were said, or it was an interruption).
 */
export const failureReport = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<{ readonly words: string; readonly reference: string | null }> => {
  const failure = lineFailureOf(cause);
  switch (failure._tag) {
    case "Said":
      return Effect.succeed({ words: failure.words, reference: null });
    case "Interrupted":
      return Effect.succeed({ words: "interrupted", reference: null });
    case "Withheld":
      return Effect.gen(function* () {
        const reference = yield* newReference;
        yield* Effect.logError("a failure was withheld from a line").pipe(
          Effect.annotateLogs({ reference, failure: failure.name, cause: Cause.pretty(cause) }),
        );
        const category = DATABASE_FAILURES.has(failure.name)
          ? "database operation failed"
          : "internal error";
        return { words: `${category} · reference ${reference}`, reference };
      });
  }
};

/** A failure in the words its class approved, `interrupted`, or a reference to its log entry. */
export const failureLine = (cause: Cause.Cause<unknown>): Effect.Effect<string> =>
  failureReport(cause).pipe(Effect.map((report) => report.words));
