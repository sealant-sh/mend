import { Worker } from "node:worker_threads";

import {
  type SessionPageConflictError,
  SessionPagesRepo,
  type SessionPage,
  type SessionPageSessionNotFoundError,
  type SessionPageStorageError,
} from "@mend/db";
import { PageRef, clampPageHeight } from "@mend/domain/workbench";
import { Duration, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import type { Caller } from "./caller.ts";
import { PAGE_CHECK_REASONS, type PageRefusal } from "./page-check.ts";

export interface PageInput {
  readonly html: string;
  readonly title: string;
  readonly height: number;
}

export class PageRejectedError extends Schema.TaggedError<PageRejectedError>()(
  "PageRejectedError",
  {
    reason: Schema.Literals([...PAGE_CHECK_REASONS, "check-deadline", "check-failed"]),
    message: Schema.String,
  },
) {}

export class SessionPages extends Context.Service<
  SessionPages,
  {
    readonly publish: (
      caller: Caller,
      page: PageInput,
    ) => Effect.Effect<
      PageRef,
      | PageRejectedError
      | SessionPageConflictError
      | SessionPageSessionNotFoundError
      | SessionPageStorageError
    >;
  }
>()("@mend/sessions/SessionPages") {}

/** How long one page's check may run. parse5 is superlinear on deep nesting and long attribute lists. */
export const PAGE_CHECK_DEADLINE = Duration.seconds(2);

/** `page-check-worker.ts` beside this module, as tests and `node` running the source load it. */
export const PAGE_CHECK_WORKER = new URL("./page-check-worker.ts", import.meta.url);

const SIMPLER_MARKUP =
  "Simpler or flatter markup will pass: fewer nested elements, and fewer attributes on one element.";

// Off the server's thread, so a page that is slow to parse holds up no other request.
const checkPageOnWorker = (worker: URL, page: PageInput): Effect.Effect<void, PageRejectedError> =>
  Effect.callback<void, PageRejectedError>((resume) => {
    const stopped = (cause: unknown) =>
      resume(
        Effect.logWarning("The page check stopped before it answered", cause).pipe(
          Effect.andThen(
            Effect.fail(
              new PageRejectedError({
                reason: "check-failed",
                message: `Mend's check of the page's markup stopped before it finished, so the page was not published. ${SIMPLER_MARKUP}`,
              }),
            ),
          ),
        ),
      );
    let thread: Worker;
    try {
      thread = new Worker(worker, { workerData: { html: page.html, title: page.title } });
    } catch (cause) {
      stopped(cause);
      return;
    }
    thread.once("message", (refusal: PageRefusal | null) =>
      resume(refusal === null ? Effect.void : Effect.fail(new PageRejectedError(refusal))),
    );
    thread.once("error", stopped);
    thread.once("exit", (code) => stopped(`the worker exited with code ${code}`));
    return Effect.sync(() => void thread.terminate());
  }).pipe(
    Effect.timeoutOrElse({
      duration: PAGE_CHECK_DEADLINE,
      orElse: () =>
        Effect.fail(
          new PageRejectedError({
            reason: "check-deadline",
            message: `The page's markup took too long to check (over ${Duration.toSeconds(PAGE_CHECK_DEADLINE)} seconds), so the page was not published. ${SIMPLER_MARKUP}`,
          }),
        ),
    }),
  );

const refOf = (row: SessionPage): PageRef =>
  new PageRef({
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    height: row.height,
    publishedAt: row.publishedAt,
  });

export const sessionPagesLayer = (
  checkWorker: URL,
): Layer.Layer<SessionPages, never, SessionPagesRepo> =>
  Layer.effect(
    SessionPages,
    Effect.gen(function* () {
      const repo = yield* SessionPagesRepo;

      const publish = Effect.fn("SessionPages.publish")(function* (
        caller: Caller,
        page: PageInput,
      ) {
        yield* checkPageOnWorker(checkWorker, page);
        const callKey = caller.callKey ?? `unkeyed:${crypto.randomUUID()}`;
        const row = yield* repo.publish({
          sessionId: caller.sessionId,
          callKey,
          accountId: caller.accountId,
          html: page.html,
          title: page.title.trim() || "Page",
          height: clampPageHeight(page.height),
        });
        return refOf(row);
      });

      return { publish };
    }),
  );
