import { BoatFailure } from "@mend/domain/workbench";
import { Schema } from "effect";

/**
 * The SDK's Promise facade throws plain `Error` subclasses (`SealantError` with
 * a stable `code`, `SealantApiError` with an HTTP `status`). This wraps them
 * back onto a typed Effect channel at the service boundary.
 */
export class SealantPlatformError extends Schema.TaggedError<SealantPlatformError>()(
  "SealantPlatformError",
  {
    /** Stable machine-readable code carried by every SDK error. */
    code: Schema.String,
    /** HTTP status when the failure came from a control-plane response. */
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
    /**
     * The connected account's provider a refused account names (`SealantApiError.provider`:
     * `connected-account-missing`, `-invalid` or `-unsupported`), when sealant gave one.
     */
    provider: Schema.optionalKey(Schema.String),
    /**
     * Why Boat refused, or did not answer, the call that failed a Boat workspace (`SealantBoatError`,
     * sealant 0.40.0-next.872): Boat's reason as a kind, with its code and request id for the log.
     */
    boat: Schema.optionalKey(BoatFailure),
    cause: Schema.Defect(),
  },
) {}
