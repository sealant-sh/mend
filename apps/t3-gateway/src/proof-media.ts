import { ProofArtifactId } from "@mend/domain";

/** Reserved before worktree resolution: these absolute paths never name filesystem files. */
export const PROOF_MEDIA_PATH_PREFIX = "/mend-proof";

type ProofMediaPath =
  | { readonly kind: "outside" }
  | { readonly kind: "invalid" }
  | { readonly kind: "proof"; readonly artifactId: ProofArtifactId; readonly fileName: string };

/** Accept only a canonical artifact UUID and one of Mend's two retained media formats. */
export const parseProofMediaPath = (path: string): ProofMediaPath => {
  if (path !== PROOF_MEDIA_PATH_PREFIX && !path.startsWith(`${PROOF_MEDIA_PATH_PREFIX}/`))
    return { kind: "outside" };
  const fileName = path.slice(PROOF_MEDIA_PATH_PREFIX.length + 1);
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|mp4)$/.exec(
    fileName,
  );
  const id = match?.[1];
  return id === undefined || match?.[0] !== fileName
    ? { kind: "invalid" }
    : { kind: "proof", artifactId: ProofArtifactId.make(id), fileName };
};
