import { SKILL_ENTRY_FILE } from "@mend/domain/workbench";

import { projectChangers } from "./project-settings.ts";
import type { SkillSearch } from "./skill-search.ts";
import {
  type DraftFile,
  justSaved,
  rowWhen,
  skillDay,
  type SkillFacts,
  skillSize,
  withFrontMatter,
} from "./skills.ts";

/**
 * Whose skills a page shows: the person's own (`/skills`), or a project's (the project's Skills
 * tab). The list, the reading view, the editor, New skill and Remove skill take one of these, so the
 * same pieces serve both; this module holds what differs: who may change them, their links, and
 * their words. Kept apart from the components so each can be tested alone.
 */
export type SkillOwner =
  | { readonly kind: "you" }
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly projectName: string;
      /** The server's own check (`capabilities.manage`): an owner, or the person who added it. */
      readonly canChange: boolean;
      /**
       * Who may change its skills, as the subject of a sentence: "Grace Hopper, who added
       * checkout-api, and Northwind's owners".
       */
      readonly changers: string;
    };

export const YOU: SkillOwner = { kind: "you" };

// ─── Who may change a project's skills ──────────────────────────────────────

/**
 * A project as its Skills tab reads it. `manage` is the project detail's `capabilities.manage`:
 * the server allows a project skill write to the organization's owners and the person who added
 * the project, and answers `manage` by the same rule, so the page offers what the server will take.
 */
export const projectSkillOwner = (input: {
  readonly projectId: string;
  readonly projectName: string;
  readonly manage: boolean;
  readonly createdByUserId: string | null;
  readonly viewerUserId: string;
  readonly organizationName: string;
  /** The organization's members, once read: who added the project is named from them. */
  readonly members: ReadonlyArray<{ readonly userId: string; readonly name: string }>;
}): SkillOwner => {
  const changers = projectChangers({
    projectName: input.projectName,
    organizationName: input.organizationName,
    createdByUserId: input.createdByUserId,
    viewerUserId: input.viewerUserId,
    members: input.members,
  });
  return {
    kind: "project",
    projectId: input.projectId,
    projectName: input.projectName,
    canChange: input.manage,
    changers,
  };
};

/** Whether this person may create, edit and remove the owner's skills. Your own: always. */
export const canChangeSkills = (owner: SkillOwner): boolean =>
  owner.kind === "you" || owner.canChange;

/** "Grace Hopper, who added checkout-api, and Northwind's owners can change it. You can read it." */
export const whoCanChangeWords = (
  owner: Extract<SkillOwner, { kind: "project" }>,
  it: "it" | "them" = "it",
): string => `${owner.changers} can change ${it}.${owner.canChange ? "" : ` You can read ${it}.`}`;

// ─── Links ──────────────────────────────────────────────────────────────────

/** Where the owner's skills are listed: `/skills`, or the project's Skills tab. */
export const skillsHome = (owner: SkillOwner) =>
  owner.kind === "you"
    ? ({ to: "/skills" } as const)
    : ({ to: "/projects/$projectId/skills", params: { projectId: owner.projectId } } as const);

/** A skill's own address, with the file and edit search it carries. */
export const skillAt = (owner: SkillOwner, skillId: string, search: SkillSearch = {}) =>
  owner.kind === "you"
    ? ({ to: "/skills/$skillId", params: { skillId }, search } as const)
    : ({
        to: "/projects/$projectId/skills/$skillId",
        params: { projectId: owner.projectId, skillId },
        search,
      } as const);

/** Whether a skill's address asks for its editor, and this person may edit it. */
export const editing = (owner: SkillOwner, search: SkillSearch | undefined): boolean =>
  search?.edit === 1 && canChangeSkills(owner);

// ─── Words ──────────────────────────────────────────────────────────────────

const on = (at: Date, now: Date) => {
  const day = skillDay(at, now);
  return day === "just now" ? day : `on ${day}`;
};

/**
 * A project skill's revision and when it last changed: "Revision 3. Edited on 9 Nov." The server
 * doesn't say who changed it, so the line names no one. The phone says it alone.
 */
export const revisionWhen = (skill: SkillFacts, now: Date): string => {
  const revision = `Revision ${skill.revision}.`;
  if (justSaved(skill, now)) return `${revision} Saved just now.`;
  return `${revision} ${skill.revision === 1 ? "Created" : "Edited"} ${on(skill.updatedAt, now)}.`;
};

/** The first line under a project skill's name on a desk: "checkout-api's skill, revision 3. …" */
export const projectPanelWhen = (projectName: string, skill: SkillFacts, now: Date): string =>
  `${projectName}'s skill, ${revisionWhen(skill, now).replace(/^R/, "r")}`;

/** Where a project skill goes, and which wins when one of yours has its name. */
export const projectUsedWords = (projectName: string, yoursHasName: boolean): string =>
  `Every new session in ${projectName} gets it.${
    yoursHasName
      ? " You have a skill with the same name, and this one is used instead of yours here."
      : ""
  }`;

/** What a project skill's panel says after a save: which sessions get this revision. */
export const projectSavedUseWords = (projectName: string, revision: number): string =>
  `Everyone's new sessions in ${projectName} get this version. Sessions that already started keep revision ${revision - 1}.`;

/** A project list row's right-hand words: which wins over yours, or when it last changed. */
export const projectRowSide = (skill: SkillFacts, yoursHasName: boolean, now: Date): string =>
  yoursHasName ? "Used instead of yours" : rowWhen(skill, now);

/** The line over the editor: whose skill, what saving makes, and who else may change it. */
export const editorIntro = (owner: SkillOwner, revision: number): string =>
  owner.kind === "you"
    ? `Your skill, revision ${revision}. Saving makes revision ${revision + 1}. Sessions that already started keep the version they loaded.`
    : `${owner.projectName}'s skill, revision ${revision}. Saving makes revision ${revision + 1} for everyone's new sessions in ${owner.projectName}. ${owner.changers} can change it.`;

/** The toast after a save, a create or a removal. */
export const doneWords = (
  owner: SkillOwner,
  done: "Saved" | "Created" | "Added" | "Removed",
  name: string,
): string => {
  if (owner.kind === "you") return `${done} ${name}`;
  const where =
    done === "Added"
      ? `to ${owner.projectName}`
      : done === "Removed"
        ? `from ${owner.projectName}`
        : `in ${owner.projectName}`;
  return `${done} ${name} ${where}`;
};

/** Under the name in New skill, when it is one of your own skills' names. */
export const sameNameAsYours = (projectName: string): string =>
  `With the same name as yours, ${projectName}'s copy is used in ${projectName} instead of yours.`;

/** Remove skill…'s last row on a project skill that one of yours shares a name with. */
export const afterRemovalWords = (name: string): string => `Your ${name} is used here again`;

// ─── New skill on a project: a copy of one of yours ─────────────────────────

/** "1 file, 1 KB", "2 files, 4 KB": a skill to copy, as New skill lists it. */
export const copyLine = (skill: { readonly fileCount: number; readonly bytes: number }): string =>
  `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"}, ${skillSize(skill.bytes)}`;

/**
 * The files a project's copy of one of your skills starts with: all of yours, and when it takes
 * another name in the project, its SKILL.md's front matter says that name.
 */
export const copiedFiles = (
  source: {
    readonly skill: { readonly name: string; readonly description: string };
    readonly files: ReadonlyArray<DraftFile>;
  },
  name: string,
): ReadonlyArray<DraftFile> =>
  name === source.skill.name
    ? source.files
    : source.files.map((file) =>
        file.path === SKILL_ENTRY_FILE
          ? {
              path: file.path,
              contents: withFrontMatter(file.contents, name, source.skill.description),
            }
          : file,
      );
