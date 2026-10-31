import { describe, expect, it } from "vitest";

import { OrganizationId } from "../ids.ts";
import type { ProjectTenancy, Viewer } from "./organization.ts";
import { type ResourceAct, resourceActRefusal } from "./resource-access.ts";

const org = OrganizationId.make("org-a");
const person = (userId: string, role: Viewer["role"]): Viewer => ({
  userId,
  organizationId: org,
  role,
});

const shared: ProjectTenancy = {
  organizationId: org,
  visibility: "shared",
  createdByUserId: "maria",
};
const creator = person("maria", "member");
const owner = person("olga", "owner");
const member = person("tom", "member");

const acts: ReadonlyArray<{ readonly name: string; readonly act: ResourceAct }> = [
  { name: "read", act: { kind: "read" } },
  { name: "add", act: { kind: "add", replaces: null } },
  { name: "replace tom's", act: { kind: "add", replaces: { addedBy: "tom" } } },
  { name: "replace ana's", act: { kind: "add", replaces: { addedBy: "ana" } } },
  { name: "remove tom's", act: { kind: "remove-definition", addedBy: "tom" } },
  { name: "remove ana's", act: { kind: "remove-definition", addedBy: "ana" } },
  { name: "use in tom's worktree", act: { kind: "use", changeOwner: "tom" } },
  { name: "use in maria's worktree", act: { kind: "use", changeOwner: "maria" } },
  { name: "use in an unowned worktree", act: { kind: "use", changeOwner: null } },
];

// Any member who can see the project reads and adds; a definition is replaced or removed by the
// person who added it or a manager (the creator or an owner); a worktree's choice is its change
// owner's, a manager's never.
const managing = ["read", "add", "replace tom's", "replace ana's", "remove tom's", "remove ana's"];
const table: ReadonlyArray<{
  readonly name: string;
  readonly actor: Viewer;
  readonly allowed: ReadonlyArray<string>;
}> = [
  { name: "the creator", actor: creator, allowed: [...managing, "use in maria's worktree"] },
  { name: "an owner", actor: owner, allowed: managing },
  {
    name: "a member",
    actor: member,
    allowed: ["read", "add", "replace tom's", "remove tom's", "use in tom's worktree"],
  },
];

describe("who may do what with a project's resources", () => {
  for (const row of table) {
    for (const { name, act } of acts) {
      const expected = row.allowed.includes(name);
      it(`${row.name} · ${name} · ${expected ? "allowed" : "refused"}`, () => {
        expect(resourceActRefusal(shared, row.actor, act) === null).toBe(expected);
      });
    }
  }

  it("refuses everything in a project the person cannot see", () => {
    const hidden: ProjectTenancy = { ...shared, visibility: "private" };
    expect(resourceActRefusal(hidden, member, { kind: "read" })).toBe(
      "is not a project you can see",
    );
    expect(resourceActRefusal(hidden, owner, { kind: "add", replaces: null })).not.toBeNull();
  });

  it("names whose act a member was refused", () => {
    expect(resourceActRefusal(shared, member, { kind: "remove-definition", addedBy: "ana" })).toBe(
      "removing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
    );
    expect(resourceActRefusal(shared, member, { kind: "add", replaces: { addedBy: "ana" } })).toBe(
      "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
    );
    expect(resourceActRefusal(shared, member, { kind: "use", changeOwner: null })).toBe(
      "choosing how this worktree uses a resource is the change owner's, and this worktree has no first session with an owner yet",
    );
  });
});
