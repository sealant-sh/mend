// @vitest-environment jsdom
import { OrganizationView } from "@mend/api-contracts";
import { OrganizationId } from "@mend/domain";
import { BOAT_KEY_COMMAND_PERMISSIONS } from "@mend/domain/workbench";
import { Organization, type OrganizationRole } from "@mend/domain/workbench";
import { QueryClient } from "@tanstack/react-query";
import { act, Suspense } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { BoatKeyReportDto, BoatKeyStatusDto } from "#/lib/api";

import { BoatKeyTab } from "./boat-key.tsx";
import {
  type Answer,
  byText,
  cachedText,
  click,
  renderWithTrpc,
  settle,
} from "./sessions-test-trpc.tsx";

const KEY = "boat_live_SYNTHETIC0123456789abcdef";
const DAY = 86_400_000;
const CONNECTED_AT = new Date("2026-11-08T09:00:00Z");
const acme = new Organization({
  id: OrganizationId.make("org-acme"),
  name: "Acme",
  createdByUserId: null,
  createdAt: CONNECTED_AT,
  updatedAt: CONNECTED_AT,
});
const viewer = (role: OrganizationRole) =>
  new OrganizationView({
    organization: acme,
    userId: "alice",
    role,
    memberCount: 2,
    operator: false,
    tenancy: "single",
    mountDelivery: "bind",
  });

const notConnected: BoatKeyStatusDto = { connected: false, sessionRuntime: "boat", details: null };

const fullReport = (overrides: Partial<BoatKeyReportDto> = {}): BoatKeyReportDto => ({
  observedAt: new Date(),
  organization: "acme-boat",
  identity: {
    observed: true,
    accountId: "acct_123",
    login: "acme-ci",
    displayName: "Acme CI",
    serviceAccount: true,
    accountStatus: "active",
  },
  keyKind: { observed: true, kind: "organization" },
  wallet: {
    observed: true,
    kind: "organization",
    organizationId: "org_9",
    organizationName: "acme-boat",
    role: "admin",
  },
  requiredPermissions: [],
  permissions: {
    observed: true,
    held: [...BOAT_KEY_COMMAND_PERMISSIONS],
    missing: [],
    limitedToSandboxes: false,
  },
  expiry: {
    observed: true,
    expiresAt: new Date(Date.now() + 200 * DAY),
    expired: false,
    expiringSoon: false,
  },
  start: {
    observed: true,
    canStart: true,
    blockedReason: null,
    billingStatus: "active",
    runningVms: 2,
    allowedVms: 5,
  },
  snapshots: { observed: true, used: 7, included: 10 },
  ...overrides,
});

const connected = (report: BoatKeyReportDto | null): BoatKeyStatusDto => ({
  connected: true,
  sessionRuntime: "boat",
  details: {
    sealantBoatAccountId: "core-boat-1",
    connectedByUserId: "alice",
    connectedByName: "Alice",
    connectedAt: CONNECTED_AT,
    keyReplacedAt: null,
    report,
  },
});

let root: Root | null = null;
afterEach(async () => {
  if (root !== null) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

interface World {
  status: BoatKeyStatusDto;
  readonly role: OrganizationRole;
  readonly calls: Array<{ readonly path: string; readonly input: unknown }>;
  /** What `boatKey.connect` answers; the status it answers becomes the world's. */
  connect: Answer;
  disconnect: Answer;
}

const open = async (world: Omit<World, "calls" | "connect" | "disconnect"> & Partial<World>) => {
  const state: World = {
    calls: [],
    connect: { refuse: "unset" },
    disconnect: { data: notConnected },
    ...world,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = await renderWithTrpc(
    <Suspense fallback={null}>
      <BoatKeyTab />
    </Suspense>,
    (path, input) => {
      state.calls.push({ path, input });
      switch (path) {
        case "organization.current":
          return { data: viewer(state.role) };
        case "boatKey.status":
          return { data: state.status };
        case "boatKey.connect": {
          if ("data" in state.connect) state.status = connected(null);
          return state.connect;
        }
        case "boatKey.check":
          return {
            data: {
              state: "active",
              observedAt: new Date(),
              keyReplacedAt: null,
              report: null,
            },
          };
        case "boatKey.disconnect":
          if ("data" in state.disconnect) state.status = notConnected;
          return state.disconnect;
        default:
          return { data: null };
      }
    },
    queryClient,
  );
  return { state, queryClient };
};

const text = () => document.body.textContent ?? "";
const keyInput = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error("no key field");
  return input;
};
const type = async (value: string) => {
  const input = keyInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () => {
  await click(byText("button", "Check and connect"));
  await settle();
};
const rows = () =>
  [...document.querySelectorAll('[role="row"]')].map((row) => row.textContent ?? "");
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent ?? "");
const notices = () =>
  [...document.querySelectorAll('[role="status"]')]
    .map((notice) => notice.textContent ?? "")
    .filter((words) => words !== "");

describe("the Boat page, not connected", () => {
  it("says what connecting does, shows both create-key commands with every permission, and one key field", async () => {
    await open({ status: notConnected, role: "owner" });
    expect(text()).toContain("not connected");
    expect(text()).toContain("billed to, the Boat account of its own key");
    const commands = [...document.querySelectorAll("code")].map((code) => code.textContent ?? "");
    expect(commands).toEqual([
      `boat --org <your-boat-organization> api-key create mend --ttl 365d --actions ${BOAT_KEY_COMMAND_PERMISSIONS.join(",")}`,
      `boat api-key create mend --ttl 365d --actions ${BOAT_KEY_COMMAND_PERMISSIONS.join(",")}`,
    ]);
    expect(keyInput().type).toBe("password");
    expect(text()).toContain("waits a few minutes while Sealant builds its image");
  });

  it("connects a key, then forgets it: the field, both caches and the page never hold it", async () => {
    const { state, queryClient } = await open({
      status: notConnected,
      role: "owner",
      connect: { data: connected(null) },
    });
    await type(`${KEY}\n`);
    await submit();
    expect(state.calls.find((call) => call.path === "boatKey.connect")?.input).toEqual({
      key: KEY,
    });
    expect(text()).toContain("connected by Alice");
    expect(cachedText(queryClient)).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(window.location.href).not.toContain(KEY);
  });

  const refusals = [
    "Boat refused this key, so nothing changed. Check that you copied the whole key and that it has not expired or been revoked in Boat.",
    "Boat did not answer when Sealant checked the key, so nothing changed. Try again in a minute.",
    "This key lacks host and sandbox.delete, which Sealant needs to run sessions. Create a key with the command above and connect it.",
    "This key cannot see 3 VMs or saved images the organization's Boat account holds now, so it is most likely another Boat account's key. Nothing changed.",
    "The organization's Boat account still has 2 workspaces whose VMs and 1 image build Boat may be running, standby workspaces included.",
    "This server's Sealant does not run Boat, or keeps no credentials, so it cannot hold a Boat key. Ask the person who runs Mend to set Boat up on the server.",
  ];
  for (const refusal of refusals) {
    it(`says the refusal as a sentence and keeps no key: ${refusal.slice(0, 40)}…`, async () => {
      const { queryClient } = await open({
        status: notConnected,
        role: "owner",
        connect: { refuse: refusal },
      });
      await type(KEY);
      await submit();
      expect(alerts()).toEqual([refusal]);
      expect(keyInput().value).toBe("");
      expect(cachedText(queryClient)).not.toContain(KEY);
      expect(document.body.innerHTML).not.toContain(KEY);
      expect(text()).toContain("not connected");
    });
  }

  it("says plainly when this server's sessions do not run on Boat, and still lets an owner connect", async () => {
    await open({ status: { ...notConnected, sessionRuntime: "docker" }, role: "owner" });
    expect(notices()).toEqual([
      "This server runs new sessions on Docker, so no session uses a Boat key until it runs them on Boat. You can connect one now for when it does.",
    ]);
    expect(keyInput()).toBeDefined();
  });
});

describe("the Boat page, connected", () => {
  it("with no report yet, says who connected it and that the details are not observed yet", async () => {
    await open({ status: connected(null), role: "owner" });
    expect(text()).toContain("connected by Alice");
    expect(text()).toContain("Not observed yet: who the key is, the wallet it bills");
    expect(rows()).toEqual([]);
    expect(alerts()).toEqual([]);
    for (const action of ["Check now", "Replace key…", "Remove…"]) {
      expect(byText("button", action)).toBeDefined();
    }
  });

  it("checks now and says when Sealant was observed holding the key", async () => {
    const { state } = await open({ status: connected(null), role: "owner" });
    await click(byText("button", "Check now"));
    expect(state.calls.map((call) => call.path)).toContain("boatKey.check");
    expect(text()).toMatch(/connected · observed \d\d:\d\d/);
  });

  it("with a full report, lists each fact as observed and warns about nothing", async () => {
    await open({ status: connected(fullReport()), role: "owner" });
    expect(rows().slice(1)).toEqual([
      expect.stringContaining("Acme CI @acme-ci service account · a Boat organization's key"),
      expect.stringContaining("the Boat organization acme-boat · the key's role there: admin"),
      expect.stringContaining("yes · 2 of 5 VMs running"),
      expect.stringContaining("7 of 10 included slots used"),
      expect.stringContaining("11 permissions · none Mend needs missing"),
      expect.stringMatching(/Expires.* · in 200 days/),
    ]);
    expect(alerts()).toEqual([]);
    expect(notices()).toEqual([]);
    expect(text()).toMatch(/connected · observed \d\d:\d\d/);
  });

  it("shows a fact Boat would not show as not observed, with Boat's reason, never as fine", async () => {
    await open({
      status: connected(
        fullReport({
          permissions: {
            observed: false,
            reason: "refused",
            boat: {
              code: "forbidden",
              status: 403,
              message: "Organization keys cannot list keys.",
            },
          },
          expiry: { observed: false, reason: "no-answer", boat: null },
        }),
      ),
      role: "owner",
    });
    expect(rows()).toContainEqual(
      expect.stringContaining(
        "not observed · Boat refused to show this to the key (403 forbidden: Organization keys cannot list keys.)",
      ),
    );
    expect(rows()).toContainEqual(expect.stringContaining("not observed · Boat did not answer"));
    expect(text()).not.toContain("none Mend needs missing");
  });

  it("names the permissions the key lacks, from the same list the command shows", async () => {
    const held = BOAT_KEY_COMMAND_PERMISSIONS.filter(
      (permission) => permission !== "host" && permission !== "sandbox.delete",
    );
    await open({
      status: connected(
        fullReport({
          permissions: {
            observed: true,
            held: [...held, "sandbox.delete-own"],
            missing: [],
            limitedToSandboxes: false,
          },
        }),
      ),
      role: "owner",
    });
    expect(rows()).toContainEqual(expect.stringContaining("missing host, sandbox.delete"));
    expect(alerts()).toContainEqual(
      expect.stringContaining("This key lacks host and sandbox.delete, which Sealant needs"),
    );
  });

  it("warns from fourteen days before the key expires, and says what to do", async () => {
    await open({
      status: connected(
        fullReport({
          expiry: {
            observed: true,
            expiresAt: new Date(Date.now() + 5 * DAY - 60_000),
            expired: false,
            expiringSoon: true,
          },
        }),
      ),
      role: "owner",
    });
    expect(notices()).toEqual([
      expect.stringMatching(
        /^This Boat key expires on .*, in 5 days\. After that, new Boat sessions cannot start with it\. Create a new key/,
      ),
    ]);
    expect(text()).toMatch(/connected · observed/);
  });

  it("says an expired key is expired", async () => {
    await open({
      status: connected(
        fullReport({
          expiry: {
            observed: true,
            expiresAt: new Date(Date.now() - DAY),
            expired: true,
            expiringSoon: false,
          },
        }),
      ),
      role: "owner",
    });
    expect(alerts()).toEqual([
      expect.stringMatching(
        /^This Boat key expired on .*, so new Boat sessions cannot start with it\./,
      ),
    ]);
    expect(rows()).toContainEqual(expect.stringMatching(/Expiresexpired /));
  });

  it("says why the wallet cannot start a VM", async () => {
    await open({
      status: connected(
        fullReport({
          start: {
            observed: true,
            canStart: false,
            blockedReason: "The wallet has no credit left.",
            billingStatus: "billing_required",
            runningVms: 0,
            allowedVms: 5,
          },
        }),
      ),
      role: "owner",
    });
    expect(rows()).toContainEqual(
      expect.stringContaining("no · The wallet has no credit left. · 0 of 5 VMs running"),
    );
    expect(alerts()).toEqual([
      "Boat will not start a VM in this wallet now: The wallet has no credit left.. New Boat sessions wait until that changes in Boat.",
    ]);
  });

  it("removes the key after saying what removing does", async () => {
    const { state } = await open({ status: connected(null), role: "owner" });
    await click(byText("button", "Remove…"));
    expect(text()).toContain("New Boat sessions in the organization use the server's Boat key.");
    await click(byText("button", "Remove the Boat key"));
    expect(state.calls.map((call) => call.path)).toContain("boatKey.disconnect");
    expect(text()).toContain("not connected");
  });

  it("keeps the key and says why when a removal is refused", async () => {
    const refusal =
      "The organization's Boat account still has 1 workspace whose VM Boat may be running, standby workspaces included.";
    await open({ status: connected(null), role: "owner", disconnect: { refuse: refusal } });
    await click(byText("button", "Remove…"));
    await click(byText("button", "Remove the Boat key"));
    expect(alerts()).toEqual([refusal]);
    expect(text()).toContain("connected by Alice");
  });

  it("replaces the key from a dialog that shows the command again", async () => {
    const { state, queryClient } = await open({
      status: connected(null),
      role: "owner",
      connect: { data: connected(null) },
    });
    await click(byText("button", "Replace key…"));
    expect(text()).toContain("The new key must be for the same Boat account");
    expect(document.querySelectorAll("code")).toHaveLength(2);
    await type(KEY);
    await submit();
    expect(state.calls.filter((call) => call.path === "boatKey.connect")).toHaveLength(1);
    expect(cachedText(queryClient)).not.toContain(KEY);
  });
});

describe("the Boat page for a member", () => {
  it("says only whether the organization has its own key, with no controls", async () => {
    await open({
      status: { connected: true, sessionRuntime: "boat", details: null },
      role: "member",
    });
    expect(text()).toContain("This organization has its own Boat key");
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector("code")).toBeNull();
  });

  it("says when the organization has none", async () => {
    await open({ status: notConnected, role: "member" });
    expect(text()).toContain(
      "This organization has no Boat key, so its Boat sessions use the server's.",
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});
