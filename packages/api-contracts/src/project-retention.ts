import { ProjectId } from "@mend/domain";
import { Schema } from "effect";

export class ProjectNameConflict extends Schema.TaggedError<ProjectNameConflict>()(
  "ProjectNameConflict",
  { name: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ProjectRetentionForbidden extends Schema.TaggedError<ProjectRetentionForbidden>()(
  "ProjectRetentionForbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class ProjectRestoreUnavailable extends Schema.TaggedError<ProjectRestoreUnavailable>()(
  "ProjectRestoreUnavailable",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class PurgeNotConfirmed extends Schema.TaggedError<PurgeNotConfirmed>()(
  "PurgeNotConfirmed",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class ProjectPurgeIncomplete extends Schema.TaggedError<ProjectPurgeIncomplete>()(
  "ProjectPurgeIncomplete",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ProjectPurgeReport extends Schema.Class<ProjectPurgeReport>("ProjectPurgeReport")({
  id: ProjectId,
  purged: Schema.Literal(true),
}) {}

export class ProjectRemovalReport extends Schema.Class<ProjectRemovalReport>(
  "ProjectRemovalReport",
)({
  removed: Schema.Literal(true),
  leftover: Schema.Null,
  retained: Schema.Literal(true),
  message: Schema.String,
}) {}
