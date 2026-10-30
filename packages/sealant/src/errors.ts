import {
  ApprovedWords,
  approvedWordsOf,
  type ReaderLine,
  ReaderWords,
  said,
  type SaysReaderWords,
} from "@mend/domain";
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
    /** The whole text, for the log. */
    message: Schema.String,
    /**
     * The connected account's provider a refused account names (`SealantApiError.provider`:
     * `connected-account-missing`, `-invalid` or `-unsupported`), when Core gave one.
     */
    provider: Schema.optionalKey(Schema.String),
    /**
     * What a line other people read may say, decided where the error is built: absent, it names
     * only a reference to the log entry, since a message can quote what a person sent (SLNT-385).
     */
    said: Schema.optionalKey(ApprovedWords),
    cause: Schema.Defect(),
  })
  implements SaysReaderWords
{
  get [ReaderWords](): ApprovedWords {
    return this.said;
  }
}

/** A failure in Mend's own words: what the log holds is what a line says. */
export const curatedError = (fields: {
  readonly code: string;
  readonly status: number | null;
  readonly words: ReaderLine;
  readonly cause: unknown;
  readonly provider?: string;
}): SealantPlatformError =>
  new SealantPlatformError({
    code: fields.code,
    status: fields.status,
    message: fields.words,
    ...(fields.provider === undefined ? {} : { provider: fields.provider }),
    said: fields.words,
    cause: fields.cause,
  });

const messageOf = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * Mend's `lead` over another failure, `inner`: the log holds both, and a line says the lead and
 * the inner's words only as far as the inner's own class approved them, so no wrapper can say
 * words the failure it wraps withheld.
 */
export const ledBy = (
  lead: ReaderLine,
  inner: unknown,
  fields: {
    readonly code: string;
    readonly status?: number | null;
    readonly separator?: ReaderLine;
    readonly cause?: unknown;
  },
): SealantPlatformError => {
  const separator = fields.separator ?? said`: `;
  const words = approvedWordsOf(inner);
  return new SealantPlatformError({
    code: fields.code,
    status:
      fields.status === undefined
        ? inner instanceof SealantPlatformError
          ? inner.status
          : null
        : fields.status,
    message: `${lead}${separator}${messageOf(inner)}`,
    said:
      words === undefined
        ? { lead }
        : typeof words === "string"
          ? said`${lead}${separator}${words}`
          : { lead: said`${lead}${separator}${words.lead}` },
    cause: "cause" in fields ? fields.cause : inner,
  });
};
