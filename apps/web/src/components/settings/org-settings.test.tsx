// @vitest-environment jsdom
import { OrganizationSettingsView, OrganizationView } from "@mend/api-contracts";
import {
  defaultSettings,
  inheritedOrganizationSettings,
  MendSettings,
  OrganizationId,
  organizationDefaults,
  OrganizationSettings,
} from "@mend/domain";
import { Organization, type OrganizationRole } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loginWalk, TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { DefaultsTab } from "./org-defaults.tsx";
import { leavingFacts, MembersTab, REMOVAL_FACTS, RemoveMemberDialog } from "./org-members.tsx";
import { archiveRows } from "./org-projects.tsx";

const NOW = new Date("2026-10-26T10:00:00Z");
const acme = new Organization({
  id: OrganizationId.make("org-acme"),
  name: "Acme",
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const viewer = (role: OrganizationRole) =>
  new OrganizationView({
    organization: acme,
    userId: "carol",
    role,
    memberCount: 2,
    operator: false,
    tenancy: "single",
    mountDelivery: "bind",
  });
const instance = new MendSettings({ ...defaultSettings, autoLand: false, autoTour: true });
const own = new OrganizationSettings({ ...inheritedOrganizationSettings, autoLand: true });
const settingsView = (editable: boolean) =>
  new OrganizationSettingsView({
    organization: own,
    instance,
    effective: organizationDefaults(instance, own),
    editable,
  });
const MEMBERS = [
  { userId: "carol", name: "Carol", email: "carol@acme.test", role: "owner", joinedAt: NOW },
  { userId: "dan", name: "Dan", email: "dan@acme.test", role: "member", joinedAt: NOW },
];
const MEMBERS_WITH_MEMBER_CAROL = [
  { ...MEMBERS[0], role: "member" },
  { ...MEMBERS[1], userId: "dan", role: "owner" },
];
const TWO_ORGANIZATIONS = [
  { organization: acme, role: "owner", joinedAt: NOW, active: true },
  {
    organization: new Organization({ ...acme, id: OrganizationId.make("org-beta"), name: "Beta" }),
    role: "member",
    joinedAt: NOW,
    active: false,
  },
];

let root: Root;
let answers: Record<string, unknown>;
let refuse: ReadonlySet<string>;
let calls: Array<string>;
/** Lets a refused call answer only when the test says so, to look at the screen before it does. */
let release: () => void = () => undefined;

const render = async (node: ReactNode) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url) => {
          const path = new URL(url.toString()).pathname.replace("/trpc/", "");
          calls.push(path);
          if (refuse.has(path)) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return Response.json(
              {
                error: serialize({
                  message: "Only owners change defaults.",
                  code: -32603,
                  data: { code: "FORBIDDEN", httpStatus: 403 },
                }),
              },
              { status: 403 },
            );
          }
          return Response.json({ result: { data: serialize(answers[path] ?? null) } });
        },
      }),
    ],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <Suspense fallback={null}>{node}</Suspense>
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
};

const settle = async () => {
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** The pressed option of the setting labelled `label`. */
const group = (label: string) =>
  [...document.querySelectorAll('[role="group"]')].find(
    (element) => element.getAttribute("aria-label") === label,
  );

const pressed = (label: string) =>
  group(label)?.querySelector('[aria-pressed="true"]')?.textContent;

const option = (label: string, text: string) => {
  const found = [...(group(label)?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`no ${text} in ${label}`);
  return found;
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  refuse = new Set();
  calls = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Organization · Defaults", () => {
  it("gives an owner Inherit, On and Off, with Inherit showing the instance's value", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true),
    };
    await render(<DefaultsTab />);
    expect(document.body.textContent).toContain("Defaults · Acme");
    expect(pressed("Compose the description & tour")).toContain("Inherit · on");
    // Land when a turn completes is Acme's own.
    expect(pressed("Land when a turn completes")).toBe("On");
  });

  it("shows an owner's pick at once and puts it back when the server refuses", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true),
    };
    refuse = new Set(["organization.setSettings"]);
    await render(<DefaultsTab />);

    await act(async () => option("Suggest fixes", "Off").click());
    await settle();
    expect(pressed("Suggest fixes")).toBe("Off");
    release();
    await settle();

    expect(calls).toContain("organization.setSettings");
    expect(pressed("Suggest fixes")).toContain("Inherit");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Only owners change defaults.",
    );
  });

  it("shows a member each value and where it comes from, with nothing to press", async () => {
    answers = {
      "organization.current": viewer("member"),
      "organization.settings": settingsView(false),
    };
    await render(<DefaultsTab />);
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.body.textContent).toContain("on · from acme's defaults");
    expect(document.body.textContent).toContain("on · from the instance default");
  });
});

describe("Organization · Members", () => {
  it("lets a member read the roster without any way to change it", async () => {
    answers = { "organization.current": viewer("member"), "organization.members": MEMBERS };
    await render(<MembersTab />);
    expect(document.body.textContent).toContain("dan@acme.test");
    expect(document.querySelector('button[aria-label^="Manage"]')).toBeNull();
  });

  it("gives an owner a Manage menu on each row, and Leave on their own beside another owner", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.members": [...MEMBERS, { ...MEMBERS[1], userId: "erin", role: "owner" }],
      "organizations.list": TWO_ORGANIZATIONS,
    };
    await render(<MembersTab />);
    expect(document.querySelector('button[aria-label="Manage Dan"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Manage your membership"]')?.textContent).toBe(
      "Leave…",
    );
  });

  it("offers the last owner no Leave", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.members": MEMBERS,
      "organizations.list": TWO_ORGANIZATIONS,
    };
    await render(<MembersTab />);
    expect(document.querySelector('button[aria-label="Manage your membership"]')?.textContent).toBe(
      "Manage",
    );
  });

  it("gives a member Leave on their own row only, while they belong to another organization", async () => {
    answers = {
      "organization.current": viewer("member"),
      "organization.members": MEMBERS_WITH_MEMBER_CAROL,
      "organizations.list": TWO_ORGANIZATIONS,
    };
    await render(<MembersTab />);
    expect(
      [...document.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Leave Acme"]);
  });

  it("offers no Leave in the account's only organization", async () => {
    answers = {
      "organization.current": viewer("member"),
      "organization.members": MEMBERS_WITH_MEMBER_CAROL,
      "organizations.list": [TWO_ORGANIZATIONS[0]],
    };
    await render(<MembersTab />);
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});

const press = async (selector: string, text: string) => {
  const find = () =>
    [...document.querySelectorAll(selector)].find((element) => element.textContent === text);
  for (let tick = 0; tick < 200 && find() === undefined; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  const found = find();
  if (!(found instanceof HTMLElement)) throw new Error(`no ${text} at ${selector}`);
  await act(async () => found.click());
};

describe("leaving from your own row", () => {
  it("states what leaving does, leaves through the account, and carries on at Now", async () => {
    const home = vi.spyOn(loginWalk, "organizationChanged").mockImplementation(() => undefined);
    const signIn = vi.spyOn(loginWalk, "accessRemoved").mockImplementation(() => undefined);
    answers = {
      "organization.current": viewer("member"),
      "organization.members": MEMBERS_WITH_MEMBER_CAROL,
      "organizations.list": TWO_ORGANIZATIONS,
    };
    await render(<MembersTab />);
    await press('button[aria-label="Leave Acme"]', "Leave…");
    await settle();
    const shown = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(shown).toContain("Leave Acme?");
    for (const fact of leavingFacts("Acme")) expect(shown).toContain(fact);
    await press('[role="dialog"] button', "Leave Acme");
    await settle();
    expect(calls).toContain("organizations.leave");
    expect(calls).not.toContain("organization.removeMember");
    expect(home).toHaveBeenCalledOnce();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("gives an owner beside another owner the same Leave from their Manage menu", async () => {
    const home = vi.spyOn(loginWalk, "organizationChanged").mockImplementation(() => undefined);
    answers = {
      "organization.current": viewer("owner"),
      "organization.members": [...MEMBERS, { ...MEMBERS[1], userId: "erin", role: "owner" }],
      "organizations.list": TWO_ORGANIZATIONS,
    };
    await render(<MembersTab />);
    await press('button[aria-label="Manage your membership"]', "Leave…");
    await press('[role="menuitem"]', "Leave Acme…");
    await press('[role="dialog"] button', "Leave Acme");
    await settle();
    expect(calls).toContain("organizations.leave");
    expect(home).toHaveBeenCalledOnce();
  });
});

describe("removing a member", () => {
  const dialog = async (self: boolean) =>
    render(
      <RemoveMemberDialog
        member={{ userId: "dan", name: "Dan" }}
        self={self}
        organizationName="Acme"
        pending={false}
        error={null}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

  it("states what removal does before it happens, in a named dialog", async () => {
    await dialog(false);
    const shown = document.querySelector('[role="dialog"]');
    expect(shown?.textContent).toContain("Remove Dan?");
    for (const fact of REMOVAL_FACTS) expect(shown?.textContent).toContain(fact);
  });

  it("claims deactivation only for someone's last organization", () => {
    const deactivation = REMOVAL_FACTS.filter((fact) => fact.includes("deactivated"));
    expect(deactivation).toEqual([
      "If this is their last organization, the account is deactivated and its devices signed out. Links already handed out keep their remaining lifetime.",
    ]);
  });

  it("asks to leave when the member is you, with what leaving does instead", async () => {
    await dialog(true);
    const shown = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(shown).toContain("Leave Acme?");
    expect(shown).toContain("Your live sessions in Acme are checkpointed, then stopped.");
    expect(shown).toContain("Your private projects stay in Acme, hidden.");
    expect(shown).toContain("Your account and your other organizations are not touched.");
    expect(shown).not.toContain("deactivated");
  });
});

describe("archived resources", () => {
  it("gives each kept volume a row with its resource and measured size", () => {
    const rows = archiveRows([
      {
        projectId: "p1",
        projectName: "old-landing",
        archivedAt: "2026-10-01T09:00:00Z",
        volumes: [
          { resourceName: "db", name: "data", dockerName: "mend-p1-db-data", bytes: 2048 },
          { resourceName: "cache", name: "data", dockerName: "mend-p1-cache", bytes: null },
        ],
      },
      { projectId: "p2", projectName: "empty", archivedAt: NOW, volumes: [] },
    ]);
    expect(rows.map((row) => [row.project, row.volume, row.size])).toEqual([
      ["old-landing", "@db · data", "2.0 KiB"],
      ["old-landing", "@cache · data", "size not observed"],
      ["empty", "no volumes were declared", null],
    ]);
  });
});
