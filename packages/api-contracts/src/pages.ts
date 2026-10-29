import { PageId, SessionId, Timestamp } from "@mend/domain";
import { PageRef } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

export const PageAppearance = Schema.Literals(["light", "dark"]);
export type PageAppearance = typeof PageAppearance.Type;

// A t3code client reuses a frame URL only while more than five minutes of it are left (its
// `HtmlRenderFrame`).
export const PAGE_FRAME_TTL_MS = 30 * 60 * 1000;

export class PageFrame extends Schema.Class<PageFrame>("PageFrame")({
  url: Schema.String,
  expiresAt: Timestamp,
}) {}

export class PageViewRefused extends Schema.TaggedError<PageViewRefused>()(
  "PageViewRefused",
  {},
  { httpApiStatus: 404 },
) {}

export const pagesGroup = HttpApiGroup.make("pages")
  .add(
    HttpApiEndpoint.get("listForSession", "/sessions/:id/pages", {
      params: { id: SessionId },
      success: Schema.Array(PageRef),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("frame", "/pages/:id/frame", {
      params: { id: PageId },
      query: { appearance: PageAppearance },
      success: PageFrame,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

export const pageViewGroup = HttpApiGroup.make("pageView").add(
  HttpApiEndpoint.get("view", "/page-view", {
    query: { view: Schema.String },
    success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" })),
    error: PageViewRefused,
  }),
);
