import {
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

/** The adopt offer's auth choices, in the order ←→ cycles them; `modeIndex` points in here. */
export const ADOPT_MODE_ORDER: ReadonlyArray<GitAuthMode> = ["mend-key", "bridge"];

/**
 * A missing or local origin does not offer adoption; cwd project matching is separate. The auth
 * choice starts on the user's saved mode (`mend keys mode`), the Mend key when it is unknown.
 */
export const deriveAdoptOffer = (
  facts: CwdFacts,
  savedMode: GitAuthMode | null = null,
): AdoptOffer | null => {
  if (
    facts.repoRoot === null ||
    facts.originUrl === null ||
    repositoryCloneUrlIssue(facts.originUrl) !== null
  )
    return null;
  return {
    source: RepositoryCloneUrl.make(facts.originUrl),
    name: normalizeProjectName(facts.repoRoot.split("/").at(-1) ?? "project"),
    modeIndex: Math.max(0, ADOPT_MODE_ORDER.indexOf(savedMode ?? "mend-key")),
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

/** The project's configured Git auth mode; no claim about a clone's actual transport or signer. */
export const configuredGitAuth = (
  mode: string,
): { readonly value: string; readonly note: string } | null => {
  if (mode !== "mend-key" && mode !== "bridge") return null;
  return mode === "mend-key"
    ? { value: "mend key", note: "configured for SSH remotes" }
    : { value: "bridge", note: "configured to use `mend keys share` for SSH remotes" };
};
