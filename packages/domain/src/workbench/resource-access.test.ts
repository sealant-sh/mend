import { describe, expect, it } from "vitest";

import { OrganizationId } from "../ids.ts";
import type { ProjectTenancy, Viewer } from "./organization.ts";
import {
  type ResourceAct,
  type ResourceActor,
  resourceActRefusal,
  WORKSPACE_RESOURCE_REFUSAL,
} from "./resource-access.ts";

const org = OrganizationId.make("org-a");
const person = (userId: string, role: Viewer["role"]): ResourceActor => ({
  kind: "person",
  viewer: { userId, organizationId: org, role },
});

const shared: ProjectTenancy = {
  organizationId: org,
  visibility: "shared",
  createdByUserId: "maria",
};
const creator = person("maria", "member");
const owner = person("olga", "owner");
const member = person("tom", "member");
const workspace: ResourceActor = { kind: "workspace" };

const acts: ReadonlyArray<{ readonly name: string; readonly act: ResourceAct }> = [
  { name: "read", act: { kind: "read" } },
  { name: "propose", act: { kind: "propose" } },
  { name: "remove own proposal", act: { kind: "remove-proposal", proposedBy: "tom" } },
  { name: "remove another's proposal", act: { kind: "remove-proposal", proposedBy: "ana" } },
  { name: "remove definition", act: { kind: "remove-definition" } },
];

// ADR 0019, "Who may do what": any member who can see the project reads and proposes (G1); a
// manager (the creator or an owner) changes settings (S12); a workspace only reads.
const everything = acts.map((each) => each.name);
const table: ReadonlyArray<{
  readonly name: string;
  readonly actor: ResourceActor;
  readonly allowed: ReadonlyArray<string>;
}> = [
  { name: "the creator", actor: creator, allowed: everything },
  { name: "an owner", actor: owner, allowed: everything },
  { name: "a member", actor: member, allowed: ["read", "propose", "remove own proposal"] },
  { name: "a workspace", actor: workspace, allowed: ["read"] },
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

  it("refuses a workspace's change with the words that send it to a person", () => {
    expect(resourceActRefusal(shared, workspace, { kind: "propose" })).toBe(
      WORKSPACE_RESOURCE_REFUSAL,
    );
  });

  it("refuses everything in a project the person cannot see", () => {
    const hidden: ProjectTenancy = { ...shared, visibility: "private" };
    expect(resourceActRefusal(hidden, member, { kind: "read" })).toBe(
      "is not a project you can see",
    );
    expect(resourceActRefusal(hidden, owner, { kind: "propose" })).not.toBeNull();
  });

  it("names whose act a member was refused", () => {
    expect(resourceActRefusal(shared, member, { kind: "remove-definition" })).toBe(
      "removing a definition is a manager's: the project's creator or an organization owner",
    );
  });
});
