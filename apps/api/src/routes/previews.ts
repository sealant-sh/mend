import {
  CurrentUser,
  MendApi,
  NotFound,
  PreviewNotOpenable,
  PreviewOpening,
  PreviewsUnavailable,
} from "@mend/api-contracts";
import { PreviewPreparationsRepo, PreviewsRepo } from "@mend/db";
import { canManageProject } from "@mend/domain/workbench";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { PreviewSetupConfig } from "../preview-config.ts";
import { previewExchangeUrl } from "../preview-host.ts";
import { PreviewIdentity } from "../preview-identity.ts";
import { readPreviewOpen } from "../preview-open.ts";
import { PREVIEW_ROOT, refusalAnswer } from "../preview-requests.ts";
import { ProjectPreviews } from "../project-previews.ts";

const NO_CREDENTIAL =
  "Opening a preview needs a sign-in or a paired device, and this request carried neither.";
const LOOPBACK =
  "Previews on this Mend server are served at *.localhost, which only the Mend machine reaches. The operator can serve them on the tailnet or a domain (mend server setup --preview-tailnet or --preview-domain).";

export const PreviewsGroupLive = HttpApiBuilder.group(MendApi, "previews", (handlers) =>
  handlers
    .handle("project", ({ params }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        const project = yield* access.project(params.id);
        const viewer = yield* access.viewer();
        const read = yield* (yield* ProjectPreviews).read(params.id);
        return { ...read, canManage: viewer !== null && canManageProject(project, viewer) };
      }),
    )
    .handle("startProject", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).manageProject(params.id);
        const caller = yield* CurrentUser;
        return {
          ...(yield* (yield* ProjectPreviews).start(params.id, caller.user.id)),
          canManage: true,
        };
      }),
    )
    .handle("useProject", ({ params, payload }) =>
      Effect.gen(function* () {
        const access = yield* ProjectAccess;
        yield* access.manageProject(params.id);
        if (payload._tag === "Worktree") {
          const worktree = yield* access.worktree(payload.worktreeId);
          if (worktree.projectId !== params.id)
            return yield* new NotFound({ id: payload.worktreeId });
        }
        return { ...(yield* (yield* ProjectPreviews).use(params.id, payload)), canManage: true };
      }),
    )
    .handle("open", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const notFound = new NotFound({ id: params.id });
        const view = yield* (yield* PreviewsRepo).resolveById(params.id);
        if (view === null || view.preview.state !== "kept") return yield* notFound;
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
          .issueTicket({
            previewId: view.preview.id,
            opener: { userId: caller.user.id, credential },
          })
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
