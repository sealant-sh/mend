import {
  gitRemoteLocation,
  RepositoryCloneUrl,
  repositoryCloneUrlIssue,
  type GitAuthMode,
} from "@mend/domain/workbench";

import type { ProjectDto } from "./dashboard-model.ts";
import { normalizeProjectName, type CwdFacts } from "./shared.ts";

/** A network origin offered for adoption, never the checkout's local path. */
export interface AdoptOffer {
  readonly source: RepositoryCloneUrl;
  readonly name: string;
  readonly modeIndex: number;
  /** Why the last attempt failed, in the server's words: the offer stays open to pick another mode. */
  readonly failure?: string;
}

/**
 * A missing or local origin does not offer adoption; cwd project matching is separate. `modeIndex`
 * is where the auth choice starts: 0 the Mend key, 1 the bridge.
 */
export const deriveAdoptOffer = (facts: CwdFacts, modeIndex = 0): AdoptOffer | null => {
  if (
    facts.repoRoot === null ||
    facts.originUrl === null ||
    repositoryCloneUrlIssue(facts.originUrl) !== null
  )
    return null;
  return {
    source: RepositoryCloneUrl.make(facts.originUrl),
    name: normalizeProjectName(facts.repoRoot.split("/").at(-1) ?? "project"),
    modeIndex,
  };
};

/**
 * The offer again after the server refused it, with the server's reason inside: the person picks
 * another auth mode and tries again instead of retyping the URL.
 */
export const refusedAdoptOffer = (offer: AdoptOffer, reason: string): AdoptOffer => ({
  ...offer,
  failure: reason,
});

/** The dashboard either reports invalid input locally or receives an adopted project. */
export type DashboardAdoptionResult =
  | { readonly kind: "invalid-source"; readonly message: string }
  | { readonly kind: "adopted"; readonly project: ProjectDto };

/** Recheck selected input at submission, before it can reach even an older server. */
export const submitDashboardAdoption = async (
  api: (
    method: "POST",
    route: "/projects",
    body: {
      readonly name: string;
      readonly source: RepositoryCloneUrl;
      readonly gitAuthMode: GitAuthMode;
    },
  ) => Promise<ProjectDto>,
  input: { readonly name: string; readonly source: string; readonly gitAuthMode: GitAuthMode },
): Promise<DashboardAdoptionResult> => {
  const issue = repositoryCloneUrlIssue(input.source);
  if (issue !== null) return { kind: "invalid-source", message: issue };
  const project = await api("POST", "/projects", {
    name: input.name,
    source: RepositoryCloneUrl.make(input.source),
    gitAuthMode: input.gitAuthMode,
  });
  return { kind: "adopted", project };
};

/**
 * What adopt says signed the clone: the transport, and the signer only when it did the work. The
 * Mend key and the bridge sign ssh; a clone over http(s) or git:// never asked either, whatever
 * the project's mode. Null for a mode this CLI does not know (an older server's).
 */
export const adoptedGitAuth = (
  source: string,
  mode: string,
): { readonly value: string; readonly note: string } | null => {
  if (mode !== "mend-key" && mode !== "bridge") return null;
  const signer = mode === "mend-key" ? "your Mend key" : "the connected `mend keys share`";
  const location = gitRemoteLocation(source);
  if (location !== null && location.scheme !== "ssh") {
    return {
      value: location.scheme,
      note: `cloned over ${location.scheme}, which ${signer} does not sign; it signs ssh remotes`,
    };
  }
  return mode === "mend-key"
    ? { value: "mend key", note: "your Mend key signed this clone" }
    : { value: "bridge", note: "signed through the connected `mend keys share`" };
};
