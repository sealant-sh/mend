import { Schema, type Stream } from "effect";

/** Raw reads report no filesystem paths or underlying I/O errors. */
export class RawReadError extends Schema.TaggedError<RawReadError>()("RawReadError", {
  reason: Schema.Literals(["missing", "io", "too-large"]),
}) {}

/** One descriptor, held by the caller's scope through body consumption. */
export interface OpenRawFile {
  readonly canonicalPath: string;
  readonly size: number;
  readonly revision: string;
  readonly read: (offset: number, length: number) => Stream.Stream<Uint8Array, RawReadError>;
}
