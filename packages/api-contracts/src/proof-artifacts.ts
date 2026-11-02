import { ChangeId, ProofArtifactId } from "@mend/domain";
import { ProofArtifact, proofLabel } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

export class ProofArtifactView extends Schema.Class<ProofArtifactView>("ProofArtifactView")({
  artifact: ProofArtifact,
  label: Schema.String,
  mediaPath: Schema.NullOr(Schema.String),
}) {}

export const proofArtifactView = (artifact: ProofArtifact): ProofArtifactView =>
  new ProofArtifactView({
    artifact,
    label: proofLabel(artifact, (at) => `${at.toISOString().slice(11, 16)} UTC`),
    mediaPath:
      artifact.capture._tag === "Screenshot" || artifact.capture._tag === "Video"
        ? `/api/proof-artifacts/${artifact.id}/media`
        : null,
  });

const rangeError = HttpApiSchema.WithHeaders(HttpApiSchema.Empty(416), {
  "content-range": Schema.String,
});

export const proofArtifactsGroup = HttpApiGroup.make("proofArtifacts")
  .add(
    HttpApiEndpoint.get("listForChange", "/changes/:changeId/proof-artifacts", {
      params: { changeId: ChangeId },
      success: Schema.Array(ProofArtifactView),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("byId", "/proof-artifacts/:id", {
      params: { id: ProofArtifactId },
      success: ProofArtifactView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("media", "/proof-artifacts/:id/media", {
      params: { id: ProofArtifactId },
      success: HttpApiSchema.StreamUint8Array(),
      error: [NotFound, rangeError],
    }),
  )
  .add(
    HttpApiEndpoint.head("mediaHead", "/proof-artifacts/:id/media", {
      params: { id: ProofArtifactId },
      success: HttpApiSchema.Empty(200),
      error: [NotFound, rangeError],
    }),
  )
  .middleware(AuthMiddleware);
