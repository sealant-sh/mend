import {
  CurrentUser,
  MendApi,
  NotFound,
  PreviewNotOpenable,
  PreviewOpening,
  PreviewsUnavailable,
} from "@mend/api-contracts";
import { PreviewPreparationsRepo, PreviewsRepo } from "@mend/db";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { PreviewSetupConfig } from "../preview-config.ts";
import { previewExchangeUrl } from "../preview-host.ts";
import { PreviewIdentity } from "../preview-identity.ts";
import { readPreviewOpen } from "../preview-open.ts";
import { PREVIEW_ROOT, refusalAnswer } from "../preview-requests.ts";

const NO_CREDENTIAL =
  "Opening a preview needs a sign-in or a paired device, and this request carried neither.";
const LOOPBACK =
  "Previews on this Mend server are served at *.localhost, which only the Mend machine reaches. The operator can serve them on the tailnet or a domain (mend server setup --preview-tailnet or --preview-domain).";

export const PreviewsGroupLive = HttpApiBuilder.group(MendApi, "previews", (handlers) =>
  handlers.handle("open", ({ params }) =>
    Effect.gen(function* () {
      const caller = yield* CurrentUser;
      const notFound = new NotFound({ id: params.id });
      const view = yield* (yield* PreviewsRepo).resolveById(params.id);
      if (view === null || view.preview.state === "removed") return yield* notFound;
      yield* (yield* ProjectAccess)
        .project(view.preview.projectId)
        .pipe(Effect.mapError(() => notFound));
      const credential = caller.credential;
      if (credential === undefined) {
        return yield* new PreviewNotOpenable({ reason: "no-credential", message: NO_CREDENTIAL });
      }
      const snapshot = yield* (yield* PreviewsRepo).gatewaySnapshot(params.id);
      const preparation = yield* (yield* PreviewPreparationsRepo).latestForWorktree(
        view.preview.worktreeId,
      );
      const open = yield* readPreviewOpen(
        (yield* PreviewSetupConfig).setup,
        view,
        snapshot?.resolution ?? null,
        preparation,
      );
      if (open._tag === "Refused") {
        return yield* new PreviewNotOpenable({ reason: open.reason, message: open.message });
      }
      if (open.routing.mode === "loopback-http") {
        return yield* new PreviewNotOpenable({ reason: "loopback", message: LOOPBACK });
      }
      const issued = yield* (yield* PreviewIdentity)
        .issueTicket({ previewId: view.preview.id, opener: { userId: caller.user.id, credential } })
        .pipe(
          Effect.catchTags({
            PreviewNotFound: () => Effect.fail(notFound),
            PreviewUnavailable: (error) =>
              Effect.fail(new PreviewsUnavailable({ message: refusalAnswer(error).body })),
            PreviewPoolFull: (error) =>
              Effect.fail(new PreviewsUnavailable({ message: refusalAnswer(error).body })),
          }),
        );
      return new PreviewOpening({ url: previewExchangeUrl(issued, PREVIEW_ROOT) });
    }),
  ),
);
