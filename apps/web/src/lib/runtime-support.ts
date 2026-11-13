import {
  customImageRefusal,
  environmentRefusal,
  hostDirectoriesRefusal,
  osRefusal,
  runtimeName,
  type RuntimeSupport,
  type WorkspaceImage,
  type WorkspaceImageOs,
} from "@mend/domain";
import { useQuery } from "@tanstack/react-query";

import { clockTime } from "./session-view.ts";
import { useTRPC } from "./trpc.ts";
import { useSignedInQuery } from "./viewer.ts";
import { OS_LABELS } from "./workspace-environment.ts";

/**
 * What a settings page knows about where the viewer's organization's new sessions run, read from
 * `organization.runtime`:
 *
 * - `pending`: still reading; the page shows nothing extra.
 * - `observed`: Sealant said what that runtime supports; choices it cannot run are refused.
 * - `unchecked`: nothing is known for sure. Every choice stays open and `note` says why.
 */
export type RuntimeFacts =
  | { readonly state: "pending" }
  | {
      readonly state: "observed";
      readonly organization: string;
      readonly support: RuntimeSupport;
    }
  | { readonly state: "unchecked"; readonly note: string };

/** A line under a control: the reason a choice is unavailable, or what to do about a saved one. */
export interface RuntimeNote {
  readonly tone: "muted" | "refused";
  readonly text: string;
}

export const useRuntimeFacts = (): RuntimeFacts => {
  const trpc = useTRPC();
  const view = useQuery(trpc.organization.runtime.queryOptions(undefined, { retry: false }));
  const current = useSignedInQuery();
  if (view.isPending || current.isPending) return { state: "pending" };
  const organization = current.data?.organization.name ?? "this organization";
  if (view.isError)
    return {
      state: "unchecked",
      note: `Not checked: Mend could not read where new sessions in ${organization} run (${view.error.message}). A session that cannot start says why.`,
    };
  const { support, sessionRuntime } = view.data;
  switch (support.state) {
    case "observed":
      return { state: "observed", organization, support: support.support };
    case "not-launched": {
      const name = runtimeName(support.runtime);
      return {
        state: "unchecked",
        note: `New sessions in ${organization} are set to run on ${name}, but Sealant on this server does not launch ${name} workspaces (observed at ${clockTime(support.observedAt)}). These choices are not checked against it.`,
      };
    }
    case "unread": {
      const runtime = sessionRuntime.effective ?? sessionRuntime.serverDefault;
      const against =
        runtime === null
          ? "Not checked: Mend could not read from Sealant what this server's runtime supports"
          : `Not checked against ${runtimeName(runtime)}: Mend could not read what it supports from Sealant`;
      return {
        state: "unchecked",
        note: `${against} (${support.reason}). A session that cannot start says why.`,
      };
    }
  }
};

/** The order the pickers list OS families in. */
const OS_FAMILIES: ReadonlyArray<WorkspaceImageOs> = ["arch", "fedora", "ubuntu", "nix"];

/** The runtime's observed support, or null when nothing is known for sure. */
const supportOf = (facts: RuntimeFacts): RuntimeSupport | null =>
  facts.state === "observed" ? facts.support : null;

/** "Ubuntu or Nix", "Arch and Fedora"; null for none. */
const listed = (names: ReadonlyArray<string>, conjunction: "and" | "or"): string | null => {
  const last = names.at(-1);
  if (last === undefined) return null;
  return names.length === 1 ? last : `${names.slice(0, -1).join(", ")} ${conjunction} ${last}`;
};

/** The OS families the runtime runs, or cannot, as their labels. */
const families = (support: RuntimeSupport, runs: boolean): ReadonlyArray<string> =>
  OS_FAMILIES.filter((os) => (osRefusal(support, os) === null) === runs).map((os) => OS_LABELS[os]);

/** A picker's choice, as the pickers list them. */
interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** A choice the runtime cannot run is disabled, with Core's sentence as its tip. */
interface RestrictedChoice<T extends string> extends Choice<T> {
  readonly disabled?: boolean;
  readonly tip?: string;
}

const restrictOptions = <T extends string>(
  options: ReadonlyArray<Choice<T>>,
  refusal: (value: T) => string | null,
): ReadonlyArray<RestrictedChoice<T>> =>
  options.map((option) => {
    const reason = refusal(option.value);
    return reason === null ? option : { ...option, disabled: true, tip: reason };
  });

/** The Base choices, "Custom image" disabled where the runtime cannot build from one. */
export const restrictBases = (
  facts: RuntimeFacts,
  options: ReadonlyArray<Choice<WorkspaceImage["mode"]>>,
) => {
  const support = supportOf(facts);
  return restrictOptions(options, (mode) =>
    support === null || mode === "family" ? null : customImageRefusal(support),
  );
};

/** The OS choices, each family the runtime cannot run disabled. */
export const restrictFamilies = (
  facts: RuntimeFacts,
  options: ReadonlyArray<Choice<WorkspaceImageOs>>,
) => {
  const support = supportOf(facts);
  return restrictOptions(options, (os) => (support === null ? null : osRefusal(support, os)));
};

/** The save bar's reason for keeping Save off while the draft is refused. */
export const draftRefusalSummary = (facts: RuntimeFacts, image: WorkspaceImage): string | null => {
  const support = supportOf(facts);
  return support === null || environmentRefusal(support, image) === null
    ? null
    : `${runtimeName(support.runtime)} cannot run this environment`;
};

/**
 * What is wrong with an environment the runtime cannot run and what to do: Core's sentence, where
 * new sessions run, and the change that fixes it. `inherits` is a project on its organization's.
 */
const environmentProblem = (
  organization: string,
  support: RuntimeSupport,
  image: WorkspaceImage,
  inherits: boolean,
): string | null => {
  const sentence = environmentRefusal(support, image);
  if (sentence === null) return null;
  const runnable = listed(families(support, true), "or");
  const baseRefused =
    (image.mode === "custom" ? customImageRefusal(support) : osRefusal(support, image.os)) !== null;
  const fix = !baseRefused
    ? image.services.docker && !support.docker.supported
      ? "turn off the Docker service"
      : "turn off Screen"
    : runnable === null
      ? null
      : image.mode === "custom"
        ? `pick OS family, then ${runnable},`
        : `pick ${runnable}`;
  const runs = `New sessions in ${organization} run on ${runtimeName(support.runtime)}, so they cannot start from ${inherits ? "the environment this project inherits" : "this environment"}.`;
  const ask = `ask an owner of ${organization} to change the organization's`;
  const todo = inherits
    ? fix === null
      ? `To change it, ${ask}.`
      : `To set one for this project, ${fix} and save, or ${ask}.`
    : fix === null
      ? null
      : `${fix.charAt(0).toUpperCase()}${fix.slice(1)} and save.`;
  return [sentence, runs, todo].filter((part) => part !== null).join(" ");
};

/**
 * The lines under the Base and OS controls. A draft the runtime cannot run says what is wrong and
 * what to do under the control that holds it. Otherwise Base gives Core's reason a custom image is
 * unavailable and OS names the families the runtime runs and the ones it does not; where new
 * sessions run is said once. A runtime Mend could not check says so under Base.
 */
export const pickerNotes = (
  facts: RuntimeFacts,
  draft: WorkspaceImage,
  inherits: boolean,
): { readonly base: RuntimeNote | null; readonly os: RuntimeNote | null } => {
  if (facts.state === "pending") return { base: null, os: null };
  if (facts.state === "unchecked") return { base: { tone: "muted", text: facts.note }, os: null };
  const { organization, support } = facts;
  const where = `New sessions in ${organization} run on ${runtimeName(support.runtime)}`;
  const custom = customImageRefusal(support);
  const problem = environmentProblem(organization, support, draft, inherits);
  const refused = listed(families(support, false), "and");
  const runnable = listed(families(support, true), "and");
  const familyLine =
    draft.mode === "custom" || refused === null
      ? null
      : `${where}, which runs ${runnable ?? "no OS family"}; ${refused} ${families(support, false).length === 1 ? "is" : "are"} unavailable.`;
  const saysWhere = problem !== null || familyLine !== null;
  const base: RuntimeNote | null =
    problem !== null && draft.mode === "custom"
      ? { tone: "refused", text: problem }
      : custom === null
        ? null
        : { tone: "muted", text: saysWhere ? custom : `${where}. ${custom}` };
  if (draft.mode === "custom") return { base, os: null };
  const os: RuntimeNote | null =
    problem !== null
      ? { tone: "refused", text: problem }
      : familyLine === null
        ? null
        : { tone: "muted", text: familyLine };
  return { base, os };
};
/**
 * The organization's environment where it is read rather than edited: Core's sentence and what it
 * means for the projects that follow it. Null when the runtime runs it, or nothing is known.
 */
export const followedEnvironmentNote = (
  facts: RuntimeFacts,
  image: WorkspaceImage,
): string | null => {
  if (facts.state !== "observed") return null;
  const sentence = environmentRefusal(facts.support, image);
  return sentence === null
    ? null
    : `${sentence} New sessions in ${facts.organization} run on ${runtimeName(facts.support.runtime)}, so no project that follows this environment can start one.`;
};

/** Hot sessions on a runtime that bills idle workspaces: Core's sentence and what it means here. */
export const idleCostNote = (facts: RuntimeFacts): string | null => {
  const support = supportOf(facts);
  return support === null || !support.idleCost.charged
    ? null
    : `${support.idleCost.message} Each ready workspace runs while it waits, so each one counts.`;
};

/**
 * Why sessions in this project start without its server folders: the runtime cannot bind them,
 * or the server runs captured workspaces, which never mount them. Null when they mount.
 */
export const serverFoldersNote = (
  facts: RuntimeFacts,
  captured: boolean,
  project: string,
): string | null => {
  const refusal = facts.state === "observed" ? hostDirectoriesRefusal(facts.support) : null;
  if (facts.state === "observed" && refusal !== null)
    return `${refusal} New sessions in ${facts.organization} run on ${runtimeName(facts.support.runtime)}, so sessions in ${project} start without these folders.`;
  return captured
    ? `This server runs captured workspaces, which never mount server folders, so sessions in ${project} start without these folders.`
    : null;
};
