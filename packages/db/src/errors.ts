import { Schema } from "effect";

export class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError",
  {
    issueId: Schema.String,
  },
) {}

/**
 * Another request held the change's Review lock past `lockTimeoutSeconds`
 * (`ReviewSlicesRepo.withChangeLock`): nothing was opened, and it can be asked again.
 */
export class ReviewChangeBusyError extends Schema.TaggedError<ReviewChangeBusyError>()(
  "ReviewChangeBusyError",
  {
    changeId: Schema.String,
    lockTimeoutSeconds: Schema.Int,
  },
) {}
