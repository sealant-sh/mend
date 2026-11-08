// @vitest-environment jsdom
import { OrganizationId } from "@mend/domain";
import { Organization, type OrganizationRole } from "@mend/domain/workbench";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithTrpc, settle } from "#/components/settings/sessions-test-trpc";
import { loginWalk } from "#/lib/trpc";

import { OrganizationBlock, useOrganizationMenu } from "./organization-menu.tsx";

const NOW = new Date("2026-11-08T10:00:00Z");
const organization = (id: string, name: string) =>
  new Organization({
    id: OrganizationId.make(id),
    name,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
const membership = (id: string, name: string, role: OrganizationRole, active: boolean) => ({
  organization: organization(id, name),
  role,
  joinedAt: NOW,
  active,
});
const signedIn = (tenancy: "single" | "multi") => ({
  organization: organization("org-acme", "Acme"),
  userId: "carol",
  role: "owner",
  memberCount: 2,
  operator: false,
  tenancy,
  mountDelivery: "bind",
});

/** The account menu's organization section, as the shell renders it. */
function Section() {
  const menu = useOrganizationMenu();
  return menu === null ? null : <OrganizationBlock menu={menu} />;
}

let root: Root | null = null;
let calls: Array<string> = [];

const show = async (
  tenancy: "single" | "multi",
  memberships: ReadonlyArray<ReturnType<typeof membership>>,
) => {
  calls = [];
  root = await renderWithTrpc(<Section />, (path) => {
    calls.push(path);
    if (path === "organization.current") return { data: signedIn(tenancy) };
    if (path === "organizations.list") return { data: memberships };
    if (path === "organizations.switch") return { data: memberships[1] };
    return { data: null };
  });
  await settle();
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the account menu's organizations", () => {
  const acme = membership("org-acme", "Acme", "owner", true);
  const beta = membership("org-beta", "Beta", "member", false);

  it("marks the one this sign-in acts in and offers each other one with its role", async () => {
    await show("multi", [acme, beta]);
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.textContent).toBe("Acmeowner");
    expect(current?.querySelector("button")).toBeNull();
    const others = [...document.querySelectorAll("button")];
    expect(others.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Switch to Beta, member",
    ]);
  });

  it("switches this sign-in and starts the tab over at Now", async () => {
    const home = vi.spyOn(loginWalk, "organizationChanged").mockImplementation(() => undefined);
    await show("multi", [acme, beta]);
    const betaRow = document.querySelector('button[aria-label="Switch to Beta, member"]');
    if (!(betaRow instanceof HTMLElement)) throw new Error("no Switch to Beta");
    await act(async () => betaRow.click());
    await settle();
    expect(calls).toContain("organizations.switch");
    expect(home).toHaveBeenCalledOnce();
  });

  it("only names a lone organization", async () => {
    await show("multi", [acme]);
    expect(document.body.textContent).toBe("organizationAcme");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows nothing in single tenancy, and never reads the list", async () => {
    await show("single", [acme]);
    expect(document.body.textContent).toBe("");
    expect(calls).not.toContain("organizations.list");
  });
});
