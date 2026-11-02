import { Schema } from "effect";

import { PageId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

// A session page's Schemas; `./session-page.ts` holds its limits and names, free of Effect, and
// re-exports these.

export class PageRef extends Schema.Class<PageRef>("PageRef")({
  id: PageId,
  sessionId: SessionId,
  title: Schema.String,
  height: Schema.Int,
  publishedAt: Timestamp,
}) {}

export const MendPageCallFailure = Schema.Struct({
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
});
export type MendPageCallFailure = typeof MendPageCallFailure.Type;

export const MendPageCall = Schema.Struct({
  attachmentId: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(MendPageCallFailure),
});
export type MendPageCall = typeof MendPageCall.Type;
