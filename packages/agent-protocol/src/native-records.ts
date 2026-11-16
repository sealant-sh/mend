/**
 * What every reader of a provider's own conversation files shares: the error, the file, and the
 * JSONL record walk. Internal to this package; `native-history.ts` re-exports the public parts.
 */
import { Schema } from "effect";

/** A provider file cannot prove the selected native response. No approximate cutoff is used. */
export class NativeHistoryError extends Schema.TaggedError<NativeHistoryError>()(
  "NativeHistoryError",
  { message: Schema.String },
) {}

/** Private provider bytes. Callers supply only files from the authorized conversation home. */
export interface NativeHistoryFile {
  readonly relativePath: string;
  readonly content: string;
}

export type JsonObject = Readonly<Record<string, unknown>>;
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const object = (value: unknown): JsonObject | null => (isObject(value) ? value : null);
export const field = (value: unknown, key: string): unknown => object(value)?.[key];
/** Thrown only inside an `Effect.try` whose `catch` keeps a `NativeHistoryError` as it is. */
export const refuse = (message: string): never => {
  throw new NativeHistoryError({ message });
};

export interface Line {
  readonly value: JsonObject;
  readonly endByte: number;
  readonly endChar: number;
}

/**
 * Visit each record of a JSONL file in order, one parsed object at a time, so a caller that keeps
 * only what it needs never holds every record of a large transcript at once. Throws on an
 * incomplete last record, a line that is not JSON, or a record that is not an object.
 */
export const eachLine = <A>(content: string, visit: (line: Line) => A): Array<A> => {
  if (!content.endsWith("\n")) return refuse("Native history ends with an incomplete record.");
  let endChar = 0;
  let endByte = 0;
  return content
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      endChar += line.length + 1;
      endByte += Buffer.byteLength(line) + 1;
      const parsed: unknown = JSON.parse(line);
      const value = object(parsed);
      if (value === null) return refuse("Native history contains a non-object record.");
      return visit({ value, endByte, endChar });
    });
};

export const linesOf = (content: string): ReadonlyArray<Line> => eachLine(content, (line) => line);
