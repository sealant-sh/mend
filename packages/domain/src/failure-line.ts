/**
 * A failure on a line other people read (a session's line, a push, an API body, a stored reason).
 * Failure text can carry a person's words: a query error holds the row it wrote, a Node error the
 * path it read, a Schema issue the value it decoded (SLNT-385). So a line is a `ReaderLine`, which
 * only a failure's approved words, a reference to its log entry, or Mend's own sentence make; a
 * failure's raw text is a plain string and does not typecheck where a line is written. A failure
 * reaches a reader only in words its class approved, through `[ReaderWords]`; every other failure
 * is withheld, logged in full under a reference, and the line names that reference.
 */
import { Cause, Effect, Schema } from "effect";

const ReaderLineSchema = Schema.String.pipe(Schema.brand("ReaderLine"));

/** Words a reader may see. */
export type ReaderLine = typeof ReaderLineSchema.Type;

/** Mend's own sentence: the template's text is Mend's, and every hole is a line or a count. */
export const said = (
  text: TemplateStringsArray,
  ...holes: ReadonlyArray<ReaderLine | number>
): ReaderLine =>
  ReaderLineSchema.make(
    text.reduce((line, part, index) => `${line}${String(holes[index - 1])}${part}`),
  );

/**
 * Text Mend vouches for, said as it is: a name, an id, a harness, a command from the project's
 * config, a summary an agent's run gave, or a platform message whose code Mend curated. Never
 * an error's message it has not read.
 */
export const mendWords = (text: string): ReaderLine => ReaderLineSchema.make(text);

/** `line` without the full stop it ends on, for a sentence that goes on after it. */
export const withoutFullStop = (line: ReaderLine): ReaderLine =>
  ReaderLineSchema.make(line.replace(/\.+$/, ""));

/** What a failure's class approves when it leads another failure: its lead, the rest withheld. */
export interface Led {
  readonly lead: ReaderLine;
}

/** A field for an error class whose reader words are decided where it is built. */
export const ApprovedWords = Schema.Union([
  ReaderLineSchema,
  Schema.Struct({ lead: ReaderLineSchema }),
]);

/**
 * What a failure's class approves for a reader: all of its words, only Mend's lead (the rest
 * withheld under a reference), or nothing.
 */
export type ApprovedWords = typeof ApprovedWords.Type | undefined;

/** The words a failure's class approved for a reader; `undefined` when this one's are not. */
export const ReaderWords: unique symbol = Symbol.for("@mend/domain/ReaderWords");

export interface SaysReaderWords {
  readonly [ReaderWords]: ApprovedWords;
}

export type LineFailure =
  | { readonly _tag: "Said"; readonly error: unknown; readonly words: ReaderLine }
  | {
      readonly _tag: "Led";
      readonly error: unknown;
      readonly lead: ReaderLine;
      readonly name: string;
    }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Withheld"; readonly name: string };

/** A line whose failure's words were withheld, ending on the reference of its log entry. */
export const WITHHELD = / · reference [0-9a-f]{16}$/;

const DATABASE_FAILURES: ReadonlySet<string> = new Set(["EffectDrizzleQueryError", "SqlError"]);

const nameOf = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null) return typeof failure;
  if ("_tag" in failure && typeof failure._tag === "string") return failure._tag;
  if ("name" in failure && typeof failure.name === "string") return failure.name;
  return "unknown";
};

/** What `failure`'s class approves; nothing unless it opted in. */
export const approvedWordsOf = (failure: unknown): ApprovedWords => {
  if (typeof failure !== "object" || failure === null || !(ReaderWords in failure)) {
    return undefined;
  }
  const words = failure[ReaderWords];
  return Schema.is(ApprovedWords)(words) ? words : undefined;
};

/** The failure a line names, in `Cause.squash`'s order: the first failure, else the first defect. */
export const lineFailureOf = (cause: Cause.Cause<unknown>): LineFailure => {
  if (!cause.reasons.some((reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason))) {
    return { _tag: "Interrupted" };
  }
  const failure = Cause.squash(cause);
  const words = approvedWordsOf(failure);
  if (words === undefined) return { _tag: "Withheld", name: nameOf(failure) };
  return typeof words === "string"
    ? { _tag: "Said", error: failure, words }
    : { _tag: "Led", error: failure, lead: words.lead, name: nameOf(failure) };
};

export const failureName = (cause: Cause.Cause<unknown>): string => nameOf(Cause.squash(cause));

const newReference = Effect.sync(() =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(""),
);

const withheld = (cause: Cause.Cause<unknown>, name: string) =>
  Effect.gen(function* () {
    const reference = yield* newReference;
    yield* Effect.logError("a failure was withheld from a line").pipe(
      Effect.annotateLogs({ reference, failure: name, cause: Cause.pretty(cause) }),
    );
    return reference;
  });

/**
 * A failure as a line says it, and the reference of the log entry that holds it when any of its
 * words were withheld (`null` when they were all said, or it was an interruption).
 */
export const failureReport = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<{ readonly words: ReaderLine; readonly reference: string | null }> => {
  const failure = lineFailureOf(cause);
  switch (failure._tag) {
    case "Said":
      return Effect.succeed({ words: failure.words, reference: null });
    case "Interrupted":
      return Effect.succeed({ words: said`interrupted`, reference: null });
    case "Led":
      return withheld(cause, failure.name).pipe(
        Effect.map((reference) => ({
          words: said`${failure.lead} · reference ${mendWords(reference)}`,
          reference,
        })),
      );
    case "Withheld":
      return withheld(cause, failure.name).pipe(
        Effect.map((reference) => ({
          words: DATABASE_FAILURES.has(failure.name)
            ? said`database operation failed · reference ${mendWords(reference)}`
            : said`internal error · reference ${mendWords(reference)}`,
          reference,
        })),
      );
  }
};

/**
 * A failure in the words its class approved, its lead and a reference, `interrupted`, or a
 * reference to its log entry.
 */
export const failureLine = (cause: Cause.Cause<unknown>): Effect.Effect<ReaderLine> =>
  failureReport(cause).pipe(Effect.map((report) => report.words));
