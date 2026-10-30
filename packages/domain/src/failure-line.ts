import { Cause, Effect, Schema } from "effect";

const ReaderLineSchema = Schema.String.pipe(Schema.brand("ReaderLine"));

export type ReaderLine = typeof ReaderLineSchema.Type;

export const said = (
  text: TemplateStringsArray,
  ...holes: ReadonlyArray<ReaderLine | number>
): ReaderLine =>
  ReaderLineSchema.make(
    text.reduce((line, part, index) => `${line}${String(holes[index - 1])}${part}`),
  );

export const mendWords = (text: string): ReaderLine => ReaderLineSchema.make(text);

export const withoutFullStop = (line: ReaderLine): ReaderLine =>
  ReaderLineSchema.make(line.replace(/\.+$/, ""));

export interface Led {
  readonly lead: ReaderLine;
}

export const ApprovedWords = Schema.Union([
  ReaderLineSchema,
  Schema.Struct({ lead: ReaderLineSchema }),
]);

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

export const WITHHELD = / · reference [0-9a-f]{16}$/;

const DATABASE_FAILURES: ReadonlySet<string> = new Set(["EffectDrizzleQueryError", "SqlError"]);

const nameOf = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null) return typeof failure;
  if ("_tag" in failure && typeof failure._tag === "string") return failure._tag;
  if ("name" in failure && typeof failure.name === "string") return failure.name;
  return "unknown";
};

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

export const failureLine = (cause: Cause.Cause<unknown>): Effect.Effect<ReaderLine> =>
  failureReport(cause).pipe(Effect.map((report) => report.words));
