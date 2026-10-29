import { Schema } from "effect";

import { PageId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

export const MEND_MCP_SERVER = "mend";

export const HTML_RENDER_TOOL = "html_render";

export const PAGE_LIMITS = {
  htmlChars: 512_000,
  titleChars: 200,
  minHeight: 80,
  maxHeight: 2000,
} as const;

const JSON_ESCAPE_MAX_BYTES = 6;
const MCP_ENVELOPE_BYTES = 64 * 1024;

export const PAGE_REQUEST_MAX_BYTES =
  PAGE_LIMITS.htmlChars * JSON_ESCAPE_MAX_BYTES + MCP_ENVELOPE_BYTES;

export const clampPageHeight = (height: number): number =>
  Math.min(PAGE_LIMITS.maxHeight, Math.max(PAGE_LIMITS.minHeight, height));

export class PageRef extends Schema.Class<PageRef>("PageRef")({
  id: PageId,
  sessionId: SessionId,
  title: Schema.String,
  height: Schema.Int,
  publishedAt: Timestamp,
}) {}

/** How long a minted frame URL serves the page. */
export const PAGE_FRAME_TTL_MS = 30 * 60 * 1000;
/** A client reuses a frame URL only while at least this much of its life is left. */
export const PAGE_FRAME_MIN_URL_LIFE_MS = 5 * 60 * 1000;

export const pageItemProviderId = (id: PageId): string => `mend-page:${id}`;

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

export const MEND_PAGE_CALL_FIELD = "mendPageCall";
