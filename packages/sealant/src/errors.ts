import { Schema } from "effect";

/**
 * The SDK's Promise facade throws plain `Error` subclasses (`SealantError` with
 * a stable `code`, `SealantApiError` with an HTTP `status`). This wraps them
 * back onto a typed Effect channel at the service boundary.
 */
export class SealantPlatformError extends Schema.TaggedErrorClass<SealantPlatformError>()(
  "SealantPlatformError",
  {
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
    cause: Schema.Defect(),
  },
) {}
