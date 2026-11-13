// @vitest-environment jsdom
import {
  OrganizationSessionRuntimeView,
  OrganizationSettingsView,
  OrganizationView,
} from "@mend/api-contracts";
import {
  defaultSettings,
  defaultWorkspaceImage,
  inheritedOrganizationSettings,
  MendSettings,
  OrganizationId,
  organizationDefaults,
  OrganizationSettings,
  ProjectId,
  type RuntimeSupportReading,
  runtimeSwitchImpact,
  type SessionRuntime,
} from "@mend/domain";
import {
  BOAT_SUPPORT,
  DOCKER_SUPPORT,
  observedSupportReading,
} from "@mend/domain/runtime-support-fixtures";
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
const dockerOnly = new OrganizationSessionRuntimeView({
  chosen: null,
  effective: "docker",
  offered: ["docker"],
  serverDefault: "docker",
});
const bothRuntimes = new OrganizationSessionRuntimeView({
  chosen: null,
  effective: "docker",
  offered: ["docker", "boat"],
  serverDefault: "docker",
});
const settingsView = (editable: boolean, sessionRuntime = dockerOnly) =>
  new OrganizationSettingsView({
    organization: own,
    instance,
    effective: organizationDefaults(instance, own),
    editable,
    sessionRuntime,
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

/** Answers a test need not state: Docker runs everything an organization has. */
const FALLBACK: Record<string, unknown> = {
  "organization.runtimeSwitch": {
    chosen: null,
    effective: "docker",
    impact: runtimeSwitchImpact({
      reading: observedSupportReading(DOCKER_SUPPORT),
      organizationDefault: { image: defaultWorkspaceImage, inherited: true },
      projects: [],
    }),
  },
};

let root: Root;
let answers: Record<string, unknown>;
let refuse: ReadonlySet<string>;
let calls: Array<string>;
/** What each mutation sent, decoded. */
let sent: Array<{ readonly path: string; readonly input: unknown }>;
/** Lets a refused call answer only when the test says so, to look at the screen before it does. */
let release: () => void = () => undefined;

const render = async (node: ReactNode) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const path = new URL(url.toString()).pathname.replace("/trpc/", "");
          calls.push(path);
          if (typeof init?.body === "string")
            sent.push({ path, input: JSON.parse(init.body).json });
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
          return Response.json({
            result: { data: serialize(answers[path] ?? FALLBACK[path] ?? null) },
          });
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
  sent = [];
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

/** One project the switch compares: visible and inheriting unless stated. */
const project = (
  name: string,
  facts: Partial<Parameters<typeof runtimeSwitchImpact>[0]["projects"][number]> = {},
) => ({
  id: ProjectId.make(`p-${name}`),
  name,
  visible: true,
  workspaceImage: null,
  services: [],
  serverFolders: 0,
  ...facts,
});

const switchDialog = () => document.querySelector('[role="dialog"]');

describe("Organization · Defaults · where new sessions run (SLNT-794)", () => {
  const RUNTIME = "Where new sessions run";
  const choseBoat = new OrganizationSessionRuntimeView({
    ...bothRuntimes,
    chosen: "boat",
    effective: "boat",
  });

  const arch = { ...defaultWorkspaceImage, os: "arch" as const };
  /** What choosing `chosen` would change, compared by the domain as the API does. */
  const switchView = (
    chosen: SessionRuntime | null,
    reading: RuntimeSupportReading,
    projects: Parameters<typeof runtimeSwitchImpact>[0]["projects"] = [],
  ) => ({
    chosen,
    effective: chosen ?? "docker",
    impact: runtimeSwitchImpact({
      reading,
      organizationDefault: { image: arch, inherited: true },
      projects,
    }),
  });
  const breaksOnBoat = switchView("boat", observedSupportReading(BOAT_SUPPORT), [
    project("web", {
      workspaceImage: { ...defaultWorkspaceImage, os: "fedora" },
      services: [{ name: "dev", port: 8080 }],
    }),
    project("docs"),
    project("hidden", { visible: false, workspaceImage: arch }),
  ]);
  const press = async (text: string) => {
    const found = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === text,
    );
    if (found === undefined) throw new Error(`no button ${text}`);
    await act(async () => found.click());
    await settle();
  };
  const switchesSent = () =>
    sent
      .filter((entry) => entry.path === "organization.setSessionRuntime")
      .map((entry) => entry.input);

  it("switches in one step, as before, when the new runtime runs everything", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, bothRuntimes),
      "organization.runtimeSwitch": switchView("boat", observedSupportReading(DOCKER_SUPPORT)),
      "organization.setSessionRuntime": settingsView(true, choseBoat),
    };
    await render(<DefaultsTab />);
    expect(pressed(RUNTIME)).toContain("Inherit · Docker");
    // The server keeps the choice: the read after the save answers it too.
    answers = { ...answers, "organization.settings": settingsView(true, choseBoat) };
    await act(async () => option(RUNTIME, "Boat").click());
    await settle();
    expect(calls).toContain("organization.runtimeSwitch");
    expect(switchDialog()).toBeNull();
    expect(switchesSent()).toEqual([{ sessionRuntime: "boat" }]);
    expect(pressed(RUNTIME)).toBe("Boat");
  });

  it("lists what Boat would not run before anything is saved, and moves it in the same step", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, bothRuntimes),
      "organization.runtimeSwitch": breaksOnBoat,
      "organization.setSessionRuntime": settingsView(true, choseBoat),
    };
    await render(<DefaultsTab />);
    await act(async () => option(RUNTIME, "Boat").click());
    await settle();
    expect(switchesSent()).toEqual([]);
    const text = switchDialog()?.textContent ?? "";
    expect(text).toContain("Before new sessions run on Boat");
    expect(text).toContain("Acme's environment");
    expect(text).toContain(
      "arch · 19 packages, from the instance → Ubuntu with Mend's default packages",
    );
    expect(text).toContain("Boat supports Ubuntu and Nix; Arch is unsupported.");
    expect(text).toContain("fedora · 19 packages → Ubuntu with Mend's default packages");
    expect(text).toContain("Service dev on port 8080 cannot listen: Boat holds that port");
    expect(text).toContain("Follows the organization's environment");
    expect(text).toContain("1 private project");
    expect(text).not.toContain("hidden");
    expect(text).toContain("takes a few minutes the first time");
    // Nothing saved yet: the choice shown is still the saved one.
    expect(pressed(RUNTIME)).toContain("Inherit · Docker");

    await press("Move 2 and switch");
    expect(switchesSent()).toEqual([
      { sessionRuntime: "boat", moves: { organizationDefault: true, projects: ["p-web"] } },
    ]);
  });

  it("switches without moving anything when the owner asks for that", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, bothRuntimes),
      "organization.runtimeSwitch": breaksOnBoat,
      "organization.setSessionRuntime": settingsView(true, choseBoat),
    };
    await render(<DefaultsTab />);
    await act(async () => option(RUNTIME, "Boat").click());
    await settle();
    await press("Switch without moving");
    expect(switchesSent()).toEqual([{ sessionRuntime: "boat" }]);
  });

  it("cancels with nothing saved", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, bothRuntimes),
      "organization.runtimeSwitch": breaksOnBoat,
    };
    await render(<DefaultsTab />);
    await act(async () => option(RUNTIME, "Boat").click());
    await settle();
    await press("Cancel");
    expect(switchesSent()).toEqual([]);
    expect(pressed(RUNTIME)).toContain("Inherit · Docker");
  });

  it("says Mend cannot tell when Sealant was not read, and never that nothing breaks", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, bothRuntimes),
      "organization.runtimeSwitch": switchView("boat", {
        state: "unread",
        reason: "Sealant could not be reached",
      }),
      "organization.setSessionRuntime": settingsView(true, choseBoat),
    };
    await render(<DefaultsTab />);
    await act(async () => option(RUNTIME, "Boat").click());
    await settle();
    expect(switchDialog()?.textContent).toContain(
      "Not checked: Mend could not read what the new runtime runs (Sealant could not be reached), so it cannot tell which projects in Acme would stop starting.",
    );
    expect(switchDialog()?.textContent).not.toContain("Move");
    await press("Switch to Boat anyway");
    expect(switchesSent()).toEqual([{ sessionRuntime: "boat" }]);
  });

  it("shows an owner on Boat what still would not start, with the same move", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, choseBoat),
      "organization.runtimeSwitch": breaksOnBoat,
      "organization.setSessionRuntime": settingsView(true, choseBoat),
    };
    await render(<DefaultsTab />);
    expect(switchDialog()).toBeNull();
    expect(document.body.textContent).toContain(
      "New sessions in Acme run on Boat, which cannot run everything here as it is",
    );
    await press("Move 2 to what Boat runs");
    expect(switchesSent()).toEqual([
      { sessionRuntime: "boat", moves: { organizationDefault: true, projects: ["p-web"] } },
    ]);
  });

  it("offers an owner no choice the server does not offer", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(true, dockerOnly),
    };
    await render(<DefaultsTab />);
    expect(group(RUNTIME)).toBeUndefined();
    expect(document.body.textContent).toContain("Docker · from this server");
    expect(document.body.textContent).not.toContain("Boat");
  });

  it("shows a member the organization's choice, with nothing to press", async () => {
    answers = {
      "organization.current": viewer("member"),
      "organization.settings": settingsView(false, choseBoat),
    };
    await render(<DefaultsTab />);
    expect(group(RUNTIME)).toBeUndefined();
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.body.textContent).toContain("Boat · from acme's defaults");
  });

  it("says Sealant picks where the server offers nothing", async () => {
    answers = {
      "organization.current": viewer("owner"),
      "organization.settings": settingsView(
        true,
        new OrganizationSessionRuntimeView({
          chosen: null,
          effective: null,
          offered: [],
          serverDefault: null,
        }),
      ),
    };
    await render(<DefaultsTab />);
    expect(group(RUNTIME)).toBeUndefined();
    expect(document.body.textContent).toContain("Sealant picks · from this server");
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

const appeared = async <A,>(find: () => A | undefined): Promise<A | undefined> => {
  for (let tick = 0; tick < 200 && find() === undefined; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return find();
};

const press = async (selector: string, text: string) => {
  const found = await appeared(() =>
    [...document.querySelectorAll(selector)].find((element) => element.textContent === text),
  );
  if (!(found instanceof HTMLElement)) throw new Error(`no ${text} at ${selector}`);
  await act(async () => found.click());
};

const dialogSaying = (title: string) =>
  appeared(() => {
    const text = document.querySelector('[role="dialog"]')?.textContent ?? "";
    return text.includes(title) ? text : undefined;
  });

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
    const shown = (await dialogSaying("Leave Acme?")) ?? "";
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
