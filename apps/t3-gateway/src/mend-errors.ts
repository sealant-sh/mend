import * as Schema from "effect/Schema";

/** Mend no longer accepts the device token: the device was revoked or its person deactivated. */
export class MendDeviceRefused extends Schema.TaggedError<MendDeviceRefused>()(
  "MendDeviceRefused",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Mend refused the device token on ${this.operation}.`;
  }
}

/** Mend did not answer, or answered something the gateway cannot read. */
export class MendUnavailable extends Schema.TaggedError<MendUnavailable>()("MendUnavailable", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Number),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.status === null
      ? `Mend did not answer ${this.operation}.`
      : `Mend answered ${this.operation} with ${this.status}.`;
  }
}

/** Mend has no such thing, or the person may not see it: a 404 on a read. */
export class MendNotFound extends Schema.TaggedError<MendNotFound>()("MendNotFound", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `Mend found nothing for ${this.operation}.`;
  }
}
