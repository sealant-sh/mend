import * as Effect from "effect/Effect";

import type { GatedMend } from "./device-gate.ts";

/** Restore Local's association from Mend without allocating a checkout during project reads. */
export const readProjectWithLocal = (
  mend: Pick<GatedMend, "projectDetail" | "findLocalWorktree">,
  token: string,
  projectId: string,
) =>
  Effect.gen(function* () {
    const detail = yield* mend.projectDetail(token, projectId);
    const localWorktree = yield* mend
      .findLocalWorktree(token, projectId)
      .pipe(Effect.catchTag("MendNotFound", () => Effect.succeed(null)));
    return { ...detail, localWorktree };
  });
