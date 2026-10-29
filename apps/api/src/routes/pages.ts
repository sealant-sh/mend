import { CurrentUser, MendApi, NotFound, PageFrame, PageViewRefused } from "@mend/api-contracts";
import { SessionPagesRepo } from "@mend/db";
import {
  isPageViewTarget,
  PAGE_VIEW_PATH,
  PAGE_VIEW_TOKEN_PARAM,
  requestPathOf,
} from "@mend/network";
import { Effect, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { pageDocument } from "../page-document.ts";
import { PageViewTokens } from "../page-view-tokens.ts";
import { routedPath } from "../request-budgets.ts";

export const PagesGroupLive = HttpApiBuilder.group(MendApi, "pages", (handlers) =>
  handlers
    .handle("listForSession", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        return yield* (yield* SessionPagesRepo).listForSession(params.id).pipe(Effect.orDie);
      }),
    )
    .handle("frame", ({ params, query }) =>
      Effect.gen(function* () {
        const page = yield* (yield* SessionPagesRepo).refById(params.id).pipe(Effect.orDie);
        if (page === null) return yield* new NotFound({ id: params.id });
        yield* (yield* ProjectAccess)
          .session(page.sessionId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        const caller = yield* CurrentUser;
        const issued = yield* (yield* PageViewTokens).issue({
          pageId: page.id,
          accountId: caller.user.id,
          appearance: query.appearance,
        });
        const url = `${PAGE_VIEW_PATH}?${new URLSearchParams({ [PAGE_VIEW_TOKEN_PARAM]: Redacted.value(issued.token) })}`;
        return new PageFrame({ url, expiresAt: issued.expiresAt });
      }),
    ),
);

// The router also matches this route spelt in another case, with doubled slashes, with
// percent-escapes or with a `;` suffix, and every header policy keys on the exact path, so only
// that spelling serves.
export const PageViewGroupLive = HttpApiBuilder.group(MendApi, "pageView", (handlers) =>
  handlers.handle("view", ({ query }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isPageViewTarget(request.url)) return yield* new PageViewRefused();
      const grant = yield* (yield* PageViewTokens).read(Redacted.make(query.view));
      if (grant === null) return yield* new PageViewRefused();
      const page = yield* (yield* SessionPagesRepo).byId(grant.pageId).pipe(Effect.orDie);
      if (page === null) return yield* new PageViewRefused();
      yield* (yield* ProjectAccess)
        .sessionAs(grant.accountId, page.sessionId)
        .pipe(Effect.mapError(() => new PageViewRefused()));
      return HttpServerResponse.text(pageDocument(page.html, grant.appearance), {
        contentType: "text/html; charset=utf-8",
      });
    }),
  ),
);

export const routesToPageView = (request: HttpServerRequest.HttpServerRequest): boolean =>
  routedPath(requestPathOf(request.url)).replace(/\/+$/, "") === PAGE_VIEW_PATH;
