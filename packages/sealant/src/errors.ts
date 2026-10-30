import { ReaderWords, type SaysReaderWords } from "@mend/domain";
import { Schema } from "effect";

/**
 * The SDK's Promise facade throws plain `Error` subclasses (`SealantError` with
 * a stable `code`, `SealantApiError` with an HTTP `status`). This wraps them
 * back onto a typed Effect channel at the service boundary.
 */
export class SealantPlatformError
  extends Schema.TaggedError<SealantPlatformError>()("SealantPlatformError", {
    /** Stable machine-readable code carried by every SDK error. */
    code: Schema.String,
    /** HTTP status when the failure came from a control-plane response. */
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
    /**
     * The connected account's provider a refused account names (`SealantApiError.provider`:
     * `connected-account-missing`, `-invalid` or `-unsupported`), when Core gave one.
     */
    provider: Schema.optionalKey(Schema.String),
    /**
     * The message is the SDK's or Core's own text, which Mend never curated: kept for the log, and
     * withheld from any line other people read, since it can quote what a person sent (SLNT-385).
     */
    uncurated: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
  })
  implements SaysReaderWords
{
  get [ReaderWords](): string | undefined {
    return this.uncurated === true ? undefined : this.message;
  }
}

/** `error` said again in `message`, which holds its words: withheld words stay withheld. */
export const restated = (
  error: SealantPlatformError,
  message: string,
  fields: { readonly code?: string; readonly cause?: unknown } = {},
): SealantPlatformError =>
  new SealantPlatformError({
    code: fields.code ?? error.code,
    status: error.status,
    message,
    ...(error.uncurated === true ? { uncurated: true } : {}),
    cause: "cause" in fields ? fields.cause : error,
  });
