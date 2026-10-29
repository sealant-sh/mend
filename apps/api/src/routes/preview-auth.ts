import { Auth } from "@mend/auth";
import { PreviewId } from "@mend/domain";
import { Effect, Option, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { PreviewIdentity } from "../preview-identity.ts";
import {
  answer,
  parsePreviewPath,
  type PreviewAnswer,
  queryOf,
  redirect,
  refusalAnswer,
  strictQuery,
} from "../preview-requests.ts";

const toResponse = (reply: PreviewAnswer) =>
  HttpServerResponse.text(reply.body, { status: reply.status, headers: reply.headers });

export const answerPreviewAuth = (input: {
  readonly method: string;
  readonly target: string;
  readonly cookie: string | undefined;
}) =>
  Effect.gen(function* () {
    if (input.method !== "GET") return answer(405, "Method not allowed.", { allow: "GET" });
    const query = strictQuery(queryOf(input.target), ["preview", "path"]);
    const preview = query?.get("preview") ?? "";
    const path = parsePreviewPath(query?.get("path") ?? "/");
    if (query === null || preview === "" || path === null) return answer(400, "Bad request.");
    const previewId = PreviewId.make(preview);
    const auth = yield* Auth;
    const session = yield* auth.getSession(
      new Headers(input.cookie === undefined ? {} : { cookie: input.cookie }),
    );
    const credential = Option.isSome(session) ? session.value.credential : undefined;
    if (Option.isNone(session) || credential === undefined) {
      const back = `/preview-auth?preview=${encodeURIComponent(previewId)}&path=${encodeURIComponent(path)}`;
      return redirect(302, `/login?next=${encodeURIComponent(back)}`);
    }
    const identity = yield* PreviewIdentity;
    return yield* identity
      .issueTicket({ previewId, opener: { userId: session.value.user.id, credential } })
      .pipe(
        Effect.match({
          onFailure: refusalAnswer,
          onSuccess: (issued) =>
            redirect(
              302,
              `${issued.origin}/__mend/auth?ticket=${encodeURIComponent(Redacted.value(issued.ticket))}&path=${encodeURIComponent(path)}`,
            ),
        }),
      );
  });

export const PreviewAuthRoutes = HttpRouter.use((router) =>
  router.add("*", "/api/preview-auth", (request) =>
    answerPreviewAuth({
      method: request.method,
      target: request.url,
      cookie: request.headers["cookie"],
    }).pipe(Effect.map(toResponse)),
  ),
);
