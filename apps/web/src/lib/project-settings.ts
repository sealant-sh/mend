/**
 * A project's settings pages (route PRs 52 to 57, Doop "Settings · Project · checkout-api · …"):
 * who may change what, and the sentences each page says about it. Every page reads the project
 * detail's `capabilities`, the server's own answer, so a page offers only what the server will
 * take; everyone else reads the page, and it names who can change it (docs/adr/0025: a project's
 * settings are changed by its creator or an owner). Pure, so each sentence is tested without a
 * server.
 */

import { namesList } from "./organization-general.ts";
import { dayOf } from "./organization.ts";
import { nameIssue } from "./projects.ts";
import { refusalTagOf } from "./refusal.ts";

/** Someone on the organization's roster, as these pages name them. */
export interface ProjectPerson {
  readonly userId: string;
  readonly name: string;
  /** Left out where only names are needed: such a person is never counted as an owner. */
  readonly role?: "owner" | "member";
}

/** What every project settings page knows about who is looking and who the project belongs to. */
export interface ProjectPeople {
  readonly projectName: string;
  readonly organizationName: string;
  /** The account that added the project; null for a project from before Mend kept it. */
  readonly createdByUserId: string | null;
  readonly viewerUserId: string;
  /** The organization's roster, once read; empty until then, and the sentences say it generally. */
  readonly members: ReadonlyArray<ProjectPerson>;
}

const nameOf = (people: ProjectPeople, userId: string | null): string | null => {
  if (userId === null) return null;
  const name = people.members.find((member) => member.userId === userId)?.name.trim() ?? "";
  return name === "" ? null : name;
};

/**
 * Who may change a project's settings (`capabilities.manage`: the organization's owners and the
 * person who added the project), as the subject of a sentence: "Grace Hopper, who added
 * checkout-api, and Northwind's owners".
 */
export const projectChangers = (people: ProjectPeople): string => {
  const owners = `${people.organizationName}'s owners`;
  if (people.createdByUserId !== null && people.createdByUserId === people.viewerUserId) {
    return `You and ${owners}`;
  }
  const creator = nameOf(people, people.createdByUserId);
  return creator === null
    ? `The person who added ${people.projectName} and ${owners}`
    : `${creator}, who added ${people.projectName}, and ${owners}`;
};

/**
 * The line a page shows to someone who can only read it: "Grace Hopper, who added checkout-api,
 * and Northwind's owners can change these settings. You can read them."
 */
export const readOnlyLine = (people: ProjectPeople): string =>
  `${projectChangers(people)} can change these settings. You can read them.`;

/** The organization's owners by name, for a sentence; "an owner of Northwind" before they're read. */
const ownersWords = (people: ProjectPeople): string => {
  const owners = people.members
    .filter((member) => member.role === "owner" && member.name.trim() !== "")
    .map((member) => (member.userId === people.viewerUserId ? "you" : member.name));
  return owners.length === 0 ? `an owner of ${people.organizationName}` : namesList(owners);
};

/** Who the project is visible to, from the viewer's side: "Only you", "Only Grace Hopper". */
export const privateLabel = (people: ProjectPeople): string => {
  if (people.createdByUserId === people.viewerUserId) return "Only you";
  const creator = nameOf(people, people.createdByUserId);
  return creator === null ? "Only the person who added it" : `Only ${creator}`;
};

/**
 * The Visible to row's description: who sees the project now, and who may change that. Only the
 * organization's owners change a project's visibility (`capabilities.changeVisibility`).
 */
export const visibilityLine = (
  visibility: "private" | "shared",
  people: ProjectPeople,
  canChange: boolean,
): string => {
  const who =
    visibility === "shared"
      ? `Everyone in ${people.organizationName} can see its sessions and start their own.`
      : people.createdByUserId === people.viewerUserId
        ? "Only you can see it and its sessions."
        : `${privateLabel(people)} can see it and its sessions.`;
  if (canChange) {
    return visibility === "shared"
      ? `${who} Making it private ends other people's ready workspaces; their sessions keep running until they end.`
      : who;
  }
  return `${who} Only ${ownersWords(people)} can change this.`;
};

/**
 * The Repository row's description: who added the project and when, and where it came from.
 * "Ada Lovelace added the project on 2 March, and Mend cloned it then."
 */
export const repositoryLine = (
  project: { readonly originUrl: string | null; readonly createdAt: Date },
  people: ProjectPeople,
  now: Date = new Date(),
): string => {
  const day = dayOf(project.createdAt, now);
  const who =
    people.createdByUserId !== null && people.createdByUserId === people.viewerUserId
      ? "You"
      : (nameOf(people, people.createdByUserId) ?? "Someone");
  return project.originUrl === null
    ? `${who} created the project in Mend on ${day}. It has no repository to clone.`
    : `${who} added the project on ${day}, and Mend cloned it then.`;
};

/** The name field's state: what the person typed against the saved name. */
export interface ProjectNameDraft {
  /** Whether Save and Discard show. */
  readonly changed: boolean;
  /** Why Mend won't send it, beside the field; null when it may be sent. */
  readonly problem: string | null;
}

/**
 * Whether a typed name differs from the saved one, and what the name rules say about it: the same
 * rules and words as adding a project, against the organization's other projects.
 */
export const projectNameDraft = (
  saved: string,
  typed: string,
  others: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  projectId: string,
  organizationName: string,
): ProjectNameDraft => {
  const name = typed.trim();
  const changed = name !== saved;
  return {
    changed,
    problem: changed
      ? nameIssue(
          name,
          others.filter((project) => project.id !== projectId),
          organizationName,
        )
      : null,
  };
};

/**
 * What a refused rename says, beside the field. The server words a refused name itself (taken,
 * not allowed, the scratch project's); a project this person may not rename, or one removed
 * meanwhile, reads as missing.
 */
export const renameRefusal = (cause: unknown, projectName: string): string => {
  const tag = refusalTagOf(cause);
  const message = cause instanceof Error && cause.message !== "" ? cause.message : null;
  if (tag === "StoreFailure" && message !== null) return message;
  if (tag === "NotFound") return `Mend couldn't find ${projectName}. Someone may have removed it.`;
  if (tag === "RemovalInProgress") return `${projectName} is being removed, so it keeps its name.`;
  return `Mend didn't rename ${projectName}. ${message ?? "Check your connection and try again."}`;
};

/**
 * Who may remove the project, for someone who can't (`capabilities.remove`: an owner, or the
 * person who added a private project).
 */
export const whoRemoves = (visibility: "private" | "shared", people: ProjectPeople): string => {
  const owners = ownersWords(people);
  if (visibility === "shared") return `Only ${owners} can remove it.`;
  const creator = nameOf(people, people.createdByUserId);
  return `Only ${creator ?? "the person who added it"} or ${owners} can remove it.`;
};
