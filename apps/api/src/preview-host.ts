import { isUpgradeTicket } from "@mend/db";
import type { PreviewId } from "@mend/domain";
import { Effect, Redacted, type Scope } from "effect";

import {
  type PreviewAccessEnded,
  PreviewConfig,
  PreviewIdentity,
  PreviewNoIdentity,
  PreviewNotFound,
  PreviewUnavailable,
  type PreviewViewer,
} from "./preview-identity.ts";
import {
  answer,
  browserAdmits,
  type BrowserHead,
  isDocumentNavigation,
  mustNotForward,
  parsePreviewPath,
  PREVIEW_ROOT,
  type PreviewAnswer,
  type PreviewPath,
  queryOf,
  redirect,
  refusalAnswer,
  strictQuery,
} from "./preview-requests.ts";
import {
  grantCookieOf,
  type PreviewOrigin,
  type PreviewRouting,
  reachedPreviewOrigin,
  readGrantCookie,
  setGrantCookie,
} from "./preview-routing.ts";

export interface PreviewRequestHead {
  readonly method: string;
  readonly target: string;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
}

const EXCHANGE = "/__mend/auth";
const COOKIE_CHECK = "/__mend/signed-in";

const isRefusal = (
  error: unknown,
): error is PreviewNoIdentity | PreviewNotFound | PreviewUnavailable =>
  error instanceof PreviewNoIdentity ||
  error instanceof PreviewNotFound ||
  error instanceof PreviewUnavailable;

const signInAt = (appUrl: string, previewId: PreviewId, path: PreviewPath) =>
  `${appUrl}/preview-auth?preview=${encodeURIComponent(previewId)}&path=${encodeURIComponent(path)}`;

const valuesOf = (head: PreviewRequestHead, name: string) =>
  head.headers.flatMap(([field, value]) => (field.toLowerCase() === name ? [value] : []));

const browserOf = (head: PreviewRequestHead): BrowserHead => ({
  method: head.method,
  upgrade: valuesOf(head, "upgrade").length > 0,
  origins: valuesOf(head, "origin"),
  fetchSite: valuesOf(head, "sec-fetch-site")[0],
  fetchMode: valuesOf(head, "sec-fetch-mode")[0],
  fetchDest: valuesOf(head, "sec-fetch-dest")[0],
});

const exchange = (head: PreviewRequestHead, routing: PreviewRouting, origin: PreviewOrigin) =>
  Effect.gen(function* () {
    if (head.method !== "GET") return answer(405, "Method not allowed.", { allow: "GET" });
    const query = strictQuery(queryOf(head.target), ["ticket", "path"]);
    const ticket = query?.get("ticket") ?? "";
    const path = parsePreviewPath(query?.get("path") ?? "/");
    if (query === null || !isUpgradeTicket(ticket) || path === null) {
      return answer(400, "Bad request.");
    }
    const identity = yield* PreviewIdentity;
    return yield* identity.exchangeTicket({ origin, ticket: Redacted.make(ticket) }).pipe(
      Effect.match({
        onFailure: refusalAnswer,
        onSuccess: (issued) =>
          redirect(303, `${COOKIE_CHECK}?path=${encodeURIComponent(path)}`, {
            "set-cookie": setGrantCookie(grantCookieOf(routing, origin), issued.grant),
          }),
      }),
    );
  });

const checkCookieKept = (
  head: PreviewRequestHead,
  routing: PreviewRouting,
  origin: PreviewOrigin,
) => {
  if (head.method !== "GET") return answer(405, "Method not allowed.", { allow: "GET" });
  const query = strictQuery(queryOf(head.target), ["path"]);
  const path = parsePreviewPath(query?.get("path") ?? "/");
  if (query === null || path === null) return answer(400, "Bad request.");
  const grant = readGrantCookie(valuesOf(head, "cookie"), grantCookieOf(routing, origin).name);
  if (grant === "repeated") return answer(400, "Bad request.");
  return grant === null
    ? answer(
        400,
        "This browser did not keep the preview's sign-in cookie. Allow cookies for this site, then open the preview again.",
      )
    : redirect(303, path);
};

export const servePreviewRequest = <E, R>(
  head: PreviewRequestHead,
  write: (admitted: PreviewViewer) => Effect.Effect<undefined, E, R>,
): Effect.Effect<
  PreviewAnswer | null,
  E | PreviewAccessEnded,
  Exclude<R, Scope.Scope> | PreviewIdentity | PreviewConfig
> =>
  Effect.gen(function* () {
    if (head.method === "CONNECT") return answer(405, "Method not allowed.");
    const { appUrl, routing } = yield* PreviewConfig;
    if (routing === null) return answer(503, "Previews are unavailable right now.");
    const hosts = valuesOf(head, "host");
    if (hosts.length !== 1) return answer(400, "Bad request.");
    const origin = reachedPreviewOrigin(routing, hosts[0] ?? "");
    if (origin === null) return answer(404, "No such preview.");
    const browser = browserOf(head);
    if (!browserAdmits(browser, origin)) return answer(403, "Refused.");
    const pathname = URL.parse(head.target, origin)?.pathname ?? "";
    if (pathname === EXCHANGE) return yield* exchange(head, routing, origin);
    if (pathname === COOKIE_CHECK) return checkCookieKept(head, routing, origin);
    if (mustNotForward(pathname)) return answer(404, "No such preview path.");
    const grant = readGrantCookie(valuesOf(head, "cookie"), grantCookieOf(routing, origin).name);
    if (grant === "repeated") return answer(400, "Bad request.");
    const identity = yield* PreviewIdentity;
    return yield* identity.withViewer({ origin, grant }, write).pipe(
      Effect.as(null),
      Effect.catchIf(isRefusal, (refused) =>
        Effect.succeed(
          refused._tag === "PreviewNoIdentity" &&
            refused.previewId !== null &&
            isDocumentNavigation(browser)
            ? redirect(
                302,
                signInAt(appUrl, refused.previewId, parsePreviewPath(head.target) ?? PREVIEW_ROOT),
              )
            : refusalAnswer(refused),
        ),
      ),
    );
  });
