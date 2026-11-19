import { describe, expect, it } from "vitest";

import {
  canChangeSkills,
  copiedFiles,
  copyLine,
  doneWords,
  editing,
  editorIntro,
  projectPanelWhen,
  projectRowSide,
  projectSavedUseWords,
  projectSkillOwner,
  projectUsedWords,
  revisionWhen,
  skillAt,
  skillsHome,
  whoCanChangeWords,
  YOU,
} from "./project-skills";
import { nameIssue } from "./skills";

const MEMBERS = [
  { userId: "grace", name: "Grace Hopper" },
  { userId: "ada", name: "Ada Lovelace" },
  { userId: "dorothy", name: "Dorothy Vaughan" },
];

const ownerFor = (input: {
  readonly manage: boolean;
  readonly viewer: string;
  readonly creator?: string | null;
  readonly members?: ReadonlyArray<{ readonly userId: string; readonly name: string }>;
}) =>
  projectSkillOwner({
    projectId: "p1",
    projectName: "checkout-api",
    manage: input.manage,
    createdByUserId: input.creator === undefined ? "grace" : input.creator,
    viewerUserId: input.viewer,
    organizationName: "Northwind",
    members: input.members ?? MEMBERS,
  });

const project = (owner: ReturnType<typeof ownerFor>) => {
  if (owner.kind !== "project") throw new Error("expected a project owner");
  return owner;
};

const skill = (revision: number, updatedAt: string) => ({
  name: "commit-messages",
  description: "Write commit messages the way checkout-api's maintainers expect.",
  revision,
  updatedAt: new Date(updatedAt),
});
const NOW = new Date("2026-11-18T12:00:00Z");

describe("who may change a project's skills", () => {
  it("follows the project's manage capability, the server's own check", () => {
    // An owner who didn't add it, the person who added it, and a member who did neither.
    expect(canChangeSkills(ownerFor({ manage: true, viewer: "ada" }))).toBe(true);
    expect(canChangeSkills(ownerFor({ manage: true, viewer: "grace" }))).toBe(true);
    expect(canChangeSkills(ownerFor({ manage: false, viewer: "dorothy" }))).toBe(false);
  });

  it("always lets you change your own", () => {
    expect(canChangeSkills(YOU)).toBe(true);
  });

  it("names the person who added it and the organization's owners", () => {
    const reader = project(ownerFor({ manage: false, viewer: "dorothy" }));
    expect(whoCanChangeWords(reader)).toBe(
      "Grace Hopper, who added checkout-api, and Northwind's owners can change it. You can read it.",
    );
    const owner = project(ownerFor({ manage: true, viewer: "ada" }));
    expect(whoCanChangeWords(owner)).toBe(
      "Grace Hopper, who added checkout-api, and Northwind's owners can change it.",
    );
  });

  it("says you when you added it", () => {
    expect(whoCanChangeWords(project(ownerFor({ manage: true, viewer: "grace" })), "them")).toBe(
      "You and Northwind's owners can change them.",
    );
  });

  it("says it generally while the members aren't read, or when the person has left", () => {
    const unread = project(ownerFor({ manage: false, viewer: "dorothy", members: [] }));
    expect(unread.changers).toBe("The person who added checkout-api and Northwind's owners");
    const unknown = project(ownerFor({ manage: false, viewer: "dorothy", creator: null }));
    expect(unknown.changers).toBe("The person who added checkout-api and Northwind's owners");
  });
});

describe("links", () => {
  const owner = ownerFor({ manage: true, viewer: "grace" });

  it("lists a project's skills on its tab, and yours on /skills", () => {
    expect(skillsHome(YOU)).toEqual({ to: "/skills" });
    expect(skillsHome(owner)).toEqual({
      to: "/projects/$projectId/skills",
      params: { projectId: "p1" },
    });
  });

  it("opens a project's skill under the project", () => {
    expect(skillAt(owner, "s1", { edit: 1 })).toEqual({
      to: "/projects/$projectId/skills/$skillId",
      params: { projectId: "p1", skillId: "s1" },
      search: { edit: 1 },
    });
  });

  it("opens the editor only for someone who may change it", () => {
    expect(editing(owner, { edit: 1 })).toBe(true);
    expect(editing(ownerFor({ manage: false, viewer: "dorothy" }), { edit: 1 })).toBe(false);
    expect(editing(owner, {})).toBe(false);
  });
});

describe("words", () => {
  it("says the revision and when it changed, naming no one", () => {
    expect(revisionWhen(skill(3, "2026-11-09T10:00:00Z"), NOW)).toBe(
      "Revision 3. Edited on 9 Nov.",
    );
    expect(projectPanelWhen("checkout-api", skill(1, "2026-11-18T11:59:40Z"), NOW)).toBe(
      "checkout-api's skill, revision 1. Created just now.",
    );
    expect(projectPanelWhen("checkout-api", skill(4, "2026-11-18T11:59:40Z"), NOW)).toBe(
      "checkout-api's skill, revision 4. Saved just now.",
    );
  });

  it("says this one is used instead of yours when you have one of its name", () => {
    expect(projectUsedWords("checkout-api", false)).toBe(
      "Every new session in checkout-api gets it.",
    );
    expect(projectUsedWords("checkout-api", true)).toBe(
      "Every new session in checkout-api gets it. You have a skill with the same name, and this one is used instead of yours here.",
    );
    expect(projectRowSide(skill(2, "2026-11-10T10:00:00Z"), true, NOW)).toBe(
      "Used instead of yours",
    );
    expect(projectRowSide(skill(2, "2026-11-10T10:00:00Z"), false, NOW)).toBe("Edited 10 Nov");
  });

  it("says which sessions get a saved revision", () => {
    expect(projectSavedUseWords("checkout-api", 4)).toBe(
      "Everyone's new sessions in checkout-api get this version. Sessions that already started keep revision 3.",
    );
  });

  it("says over the editor whose skill it is and who else may change it", () => {
    const owner = ownerFor({ manage: true, viewer: "ada" });
    expect(editorIntro(owner, 3)).toBe(
      "checkout-api's skill, revision 3. Saving makes revision 4 for everyone's new sessions in checkout-api. Grace Hopper, who added checkout-api, and Northwind's owners can change it.",
    );
    expect(editorIntro(YOU, 1)).toMatch(/^Your skill, revision 1\. Saving makes revision 2\./);
  });

  it("says where in the toasts", () => {
    const owner = ownerFor({ manage: true, viewer: "ada" });
    expect(doneWords(owner, "Added", "flaky-test-hunting")).toBe(
      "Added flaky-test-hunting to checkout-api",
    );
    expect(doneWords(owner, "Saved", "commit-messages")).toBe(
      "Saved commit-messages in checkout-api",
    );
    expect(doneWords(owner, "Removed", "commit-messages")).toBe(
      "Removed commit-messages from checkout-api",
    );
    expect(doneWords(YOU, "Saved", "commit-messages")).toBe("Saved commit-messages");
  });

  it("names the project when a name is taken there", () => {
    expect(nameIssue("stripe-idempotency", ["stripe-idempotency"], "checkout-api")).toBe(
      "checkout-api already has a skill named stripe-idempotency. Pick another name.",
    );
    expect(nameIssue("stripe-idempotency", ["stripe-idempotency"])).toBe(
      "You already have a skill named stripe-idempotency. Pick another name.",
    );
  });
});

describe("a copy of one of yours", () => {
  const source = {
    skill: { name: "flaky-test-hunting", description: "How to chase a flaky test." },
    files: [
      {
        path: "SKILL.md",
        contents:
          "---\nname: flaky-test-hunting\ndescription: How to chase a flaky test.\n---\n\n# Flaky",
      },
      { path: "references/ci-logs.md", contents: "Seeds: 1182" },
    ],
  };

  it("keeps every file as it is under the same name", () => {
    expect(copiedFiles(source, "flaky-test-hunting")).toEqual(source.files);
  });

  it("says the new name in SKILL.md's front matter, and only there", () => {
    const copied = copiedFiles(source, "flaky-tests");
    expect(copied[0]?.contents).toBe(
      "---\nname: flaky-tests\ndescription: How to chase a flaky test.\n---\n\n# Flaky",
    );
    expect(copied[1]).toEqual(source.files[1]);
  });

  it("lists each with its files and size", () => {
    expect(copyLine({ fileCount: 1, bytes: 1200 })).toBe("1 file, 1 KB");
    expect(copyLine({ fileCount: 2, bytes: 4096 })).toBe("2 files, 4 KB");
  });
});
