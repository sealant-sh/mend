// @vitest-environment jsdom
import { OrganizationView } from "@mend/api-contracts";
import { OrganizationId } from "@mend/domain";
import {
  boatKeyProofFixture,
  boatUnreachableFixture,
  KEY_LIST_FORBIDDEN,
  oneWalletReportFixture,
  organizationKeyReportFixture,
  threeWalletsReportFixture,
  walletChangedReportFixture,
} from "@mend/domain/boat-key-fixtures";
import { BOAT_KEY_REQUIRED_PERMISSIONS } from "@mend/domain/workbench";
import { Organization, type OrganizationRole } from "@mend/domain/workbench";
import { QueryClient } from "@tanstack/react-query";
import { act, Suspense } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type {
  BoatKeyCheckDto,
  BoatKeyFullCheckDto,
  BoatKeyDetailsDto,
  BoatKeyReportDto,
  BoatKeyStatusDto,
} from "#/lib/api";

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

const notConnected: BoatKeyStatusDto = {
  connected: false,
  sessionRuntime: "boat",
  details: null,
  peopleWithOwnKeys: [],
};

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
  wallets: null,
  billing: { mode: "key-organization" },
  requiredPermissions: [],
  permissions: {
    observed: true,
    held: [...BOAT_KEY_REQUIRED_PERMISSIONS],
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

const NO_FULL_CHECK: BoatKeyDetailsDto["fullCheck"] = { last: null, runningSince: null };

const connected = (
  report: BoatKeyReportDto | null,
  fullCheck: BoatKeyDetailsDto["fullCheck"] = NO_FULL_CHECK,
  unreachable: BoatKeyDetailsDto["unreachable"] = null,
): BoatKeyStatusDto => ({
  connected: true,
  sessionRuntime: "boat",
  peopleWithOwnKeys: [],
  details: {
    sealantBoatAccountId: "core-boat-1",
    connectedByUserId: "alice",
    connectedByName: "Alice",
    connectedAt: CONNECTED_AT,
    keyReplacedAt: null,
    report,
    fullCheck,
    unreachable,
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
  /** What `boatKey.check` answers. */
  check: BoatKeyCheckDto;
  /** What `boatKey.fullCheck` answers; a finished one becomes the status's last, as sealant keeps it. */
  fullCheck: { readonly data: BoatKeyFullCheckDto } | { readonly refuse: string };
  /** What `boatKey.chooseWallet` answers; the status it answers becomes the world's. */
  chooseWallet: { readonly data: BoatKeyStatusDto } | { readonly refuse: string };
}

const open = async (
  world: Omit<World, "calls" | "connect" | "disconnect" | "check" | "fullCheck" | "chooseWallet"> &
    Partial<World>,
) => {
  const state: World = {
    calls: [],
    connect: { refuse: "unset" },
    disconnect: { data: notConnected },
    fullCheck: { refuse: "unset" },
    chooseWallet: { refuse: "unset" },
    check: {
      state: "active",
      observedAt: new Date(),
      keyReplacedAt: null,
      report: null,
      unanswered: null,
    },
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
          return { data: state.check };
        case "boatKey.fullCheck": {
          const answer = state.fullCheck;
          if ("data" in answer && state.status.details !== null)
            state.status = {
              ...state.status,
              details: {
                ...state.status.details,
                fullCheck: answer.data,
              },
            };
          return answer;
        }
        case "boatKey.disconnect":
          if ("data" in state.disconnect) state.status = notConnected;
          return state.disconnect;
        case "boatKey.chooseWallet": {
          const answer = state.chooseWallet;
          if ("data" in answer) state.status = answer.data;
          return answer;
        }
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
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
      `boat --org <your-boat-organization> api-key create mend --ttl 365d --actions ${BOAT_KEY_REQUIRED_PERMISSIONS.join(",")}`,
      `boat --org personal api-key create mend --ttl 365d --actions ${BOAT_KEY_REQUIRED_PERMISSIONS.join(",")}`,
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
    "This key lacks host and sandbox.delete, which Mend needs to run sessions. Create a key with the command above and connect it.",
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
          keyKind: { observed: true, kind: "personal" },
          permissions: { observed: false, reason: "refused", boat: KEY_LIST_FORBIDDEN },
          expiry: { observed: false, reason: "no-answer", boat: null },
        }),
      ),
      role: "owner",
    });
    expect(rows()).toContainEqual(
      expect.stringContaining(
        "not observed · Boat refused to show this to the key (403 forbidden: Organization API keys cannot list API keys.)",
      ),
    );
    expect(rows()).toContainEqual(expect.stringContaining("not observed · Boat did not answer"));
    expect(text()).not.toContain("none Mend needs missing");
  });

  it("says an organization key's permissions and expiry cannot be read from it, and where to see them", async () => {
    await open({ status: connected(organizationKeyReportFixture()), role: "owner" });
    expect(rows()).toContainEqual(
      expect.stringMatching(
        /^Permissions.*not observed · not readable from a Boat organization's key$/,
      ),
    );
    expect(rows()).toContainEqual(
      expect.stringMatching(
        /^Expires.*not observed · not readable from a Boat organization's key$/,
      ),
    );
    expect(notices()).toEqual([
      "Boat does not show a Boat organization's key its own permissions or expiry, so Mend cannot read them from this key. To see them, run boat --org acme-boat api-key list, or open the API Keys tab in Boat's dashboard. If the key lacks a permission or has expired, a Boat session that cannot start says so.",
    ]);
    expect(alerts()).toEqual([]);
    expect(text()).toMatch(/connected · observed \d\d:\d\d/);
  });

  it("shows the report a check observed, and says when Boat did not answer it", async () => {
    const last = fullReport({ observedAt: new Date(Date.now() - 3_600_000) });
    const { state } = await open({ status: connected(last), role: "owner" });
    state.check = {
      state: "active",
      observedAt: new Date(),
      keyReplacedAt: null,
      report: last,
      unanswered:
        "Boat did not answer this check, so Mend observed nothing new: the report shown is the last one. Try again in a minute.",
    };
    await click(byText("button", "Check now"));
    expect(notices()).toContainEqual(expect.stringContaining("Boat did not answer this check"));
    expect(rows().slice(1)).toContainEqual(expect.stringContaining("yes · 2 of 5 VMs running"));
  });

  it("names the permissions the key lacks, from the same list the command shows", async () => {
    const held = BOAT_KEY_REQUIRED_PERMISSIONS.filter(
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
      expect.stringContaining("This key lacks host and sandbox.delete, which Mend needs"),
    );
  });

  it("says a key made without account.read starts nothing new, keeps its sessions, and must be replaced", async () => {
    const held = BOAT_KEY_REQUIRED_PERMISSIONS.filter(
      (permission) => permission !== "account.read",
    );
    await open({
      status: connected(
        fullReport({
          permissions: { observed: true, held, missing: [], limitedToSandboxes: false },
        }),
      ),
      role: "owner",
    });
    expect(rows()).toContainEqual(expect.stringContaining("missing account.read"));
    expect(alerts()).toContainEqual(
      expect.stringContaining(
        "This key lacks account.read, so sealant cannot see which Boat wallet it bills: no new Boat session starts with it, and the ones running keep running. Boat adds no permission to an existing key.",
      ),
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
      expect.stringContaining("no · The wallet has no credit left · 0 of 5 VMs running"),
    );
    expect(alerts()).toEqual([
      "Boat will not start a VM in this wallet now: The wallet has no credit left. New Boat sessions wait until that changes in Boat.",
    ]);
  });

  it("removes the key after saying what removing does", async () => {
    const { state } = await open({ status: connected(null), role: "owner" });
    await click(byText("button", "Remove…"));
    expect(text()).toContain(
      "New Boat sessions in the organization use the server's own Boat key, if it has one, apart from those of people who connected their own; otherwise they are refused.",
    );
    expect(text()).toContain(
      "Mend first stops the standby workspaces it keeps in this Boat account",
    );
    expect(text()).not.toContain("hot sessions to 0");
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

describe("the Boat page, full check", () => {
  const FINISHED = new Date(Date.now() - 60_000);

  it("says what a full check costs before it runs, then shows each step it passed", async () => {
    const passed = { last: boatKeyProofFixture("passed", FINISHED), runningSince: null };
    const { state } = await open({
      status: connected(null),
      role: "owner",
      fullCheck: { data: passed },
    });
    expect(text()).not.toContain("full check passed");
    await click(byText("button", "Run a full check…"));
    expect(text()).toContain(
      "It uses one VM start, takes about a minute, and holds one saved snapshot slot for that minute.",
    );
    expect(text()).toContain("a Boat organization's key among them");
    await click(byText("button", "Run the full check"));
    await settle();
    expect(state.calls.filter((call) => call.path === "boatKey.fullCheck")).toHaveLength(1);
    expect(text()).toMatch(/full check passed · observed \d\d:\d\d/);
    expect(rows()).toEqual(
      expect.arrayContaining([
        "Start a VMpassed",
        "Run a commandpassed",
        "Publish a portpassed",
        "Save a snapshotpassed",
        "Delete the snapshotpassed",
        "Delete the VMpassed",
      ]),
    );
    expect(text()).toContain("Sealant saw Boat delete everything the check made.");
  });

  it("names the step Boat refused, with Boat's reason in the failure table's words", async () => {
    await open({
      status: connected(null, {
        last: boatKeyProofFixture("refused", FINISHED),
        runningSince: null,
      }),
      role: "owner",
    });
    expect(text()).toContain("full check refused at publish a port");
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Publish a portrefusedThis Boat key lacks the Boat permission host, so the full check stopped there.",
        ),
        "Save a snapshotnot reached",
      ]),
    );
  });

  it("says an interrupted check was swept, and names what is not yet confirmed removed", async () => {
    await open({
      status: connected(null, {
        last: boatKeyProofFixture("interrupted", FINISHED, {
          vm: "bx_abc123",
          snapshot: "sealant-key-proof-1",
          removalConfirmed: false,
        }),
        runningSince: null,
      }),
      role: "owner",
    });
    expect(text()).toContain("full check interrupted");
    expect(notices()).toEqual(
      expect.arrayContaining([
        "The full check stopped before it finished, and Sealant took over removing what it had made. Run it again.",
        "It used one VM start. Sealant has not yet seen Boat delete VM bx_abc123 and snapshot sealant-key-proof-1. It keeps deleting what is left, and the key cannot be replaced or removed until it has.",
      ]),
    );
  });

  it("while one runs, says since when and offers no second one", async () => {
    await open({
      status: connected(null, {
        last: boatKeyProofFixture("passed", FINISHED),
        runningSince: new Date(Date.now() - 20_000),
      }),
      role: "owner",
    });
    expect(text()).toMatch(/full check running · started \d\d:\d\d/);
    expect(text()).toContain("You can leave this page: Sealant keeps the result");
    expect(byText("button", "Full check running…").hasAttribute("disabled")).toBe(true);
  });

  it("says so when Sealant has one running already, and starts none", async () => {
    const refusal =
      "A full check of this key is running, or Sealant is still removing what the last one made in Boat, so no other was started. Sealant says: VM bx_abc123 may still be held.";
    await open({ status: connected(null), role: "owner", fullCheck: { refuse: refusal } });
    await click(byText("button", "Run a full check…"));
    await click(byText("button", "Run the full check"));
    await settle();
    expect(alerts()).toEqual([refusal]);
  });

  it("shows why a removal waits while the check's leftovers are not removed", async () => {
    const refusal =
      "A full check of this key has not finished removing what it made in Boat, so nothing changed: the key that made them is the one that can delete them. Sealant says: snapshot sealant-key-proof-1 may still be held.";
    await open({ status: connected(null), role: "owner", disconnect: { refuse: refusal } });
    await click(byText("button", "Remove…"));
    await click(byText("button", "Remove the Boat key"));
    expect(alerts()).toEqual([refusal]);
  });
});

describe("the Boat page for a member", () => {
  it("says only whether the organization has its own key, with no controls", async () => {
    await open({
      status: { connected: true, sessionRuntime: "boat", details: null, peopleWithOwnKeys: null },
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
      "This organization has no Boat key, so its Boat sessions use the server's own key, if the server has one.",
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("the Boat page's people with their own key (SLNT-797)", () => {
  it("names them for an owner, and says none of their key's details", async () => {
    await open({
      status: {
        ...notConnected,
        peopleWithOwnKeys: [
          { userId: "carol", name: "Carol" },
          { userId: "dan", name: "Dan" },
        ],
      },
      role: "owner",
    });
    expect(text()).toContain("People with their own Boat key");
    expect(text()).toContain(
      "Carol and Dan have connected their own Boat key, so the organization's repositories are checked out in VMs in their Boat accounts. Only they see their key's details or change it.",
    );
  });

  it("says so when nobody has one", async () => {
    await open({ status: notConnected, role: "owner" });
    expect(text()).toContain("Nobody in this organization has connected their own Boat key.");
  });

  it("shows a member nothing about who has one", async () => {
    await open({ status: { ...notConnected, peopleWithOwnKeys: null }, role: "member" });
    expect(text()).not.toContain("People with their own Boat key");
  });
});

const radios = () =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].map((radio) => ({
    text: radio.textContent ?? "",
    checked: radio.getAttribute("aria-checked") === "true",
  }));

describe("the wallet the key bills (SLNT-821)", () => {
  it("says a Boat organization's key bills its organization, fixed, and offers no choice", async () => {
    await open({ status: connected(organizationKeyReportFixture()), role: "owner" });
    expect(rows()).toContainEqual(
      expect.stringContaining(
        "the Boat organization acme-boat · the key's role there: admin · fixed: a Boat organization's key bills only its own organization",
      ),
    );
    expect(radios()).toEqual([]);
    expect(text()).not.toContain("Wallet this key bills");
  });

  it("names the personal account a key with one wallet bills, and offers no choice", async () => {
    await open({ status: connected(oneWalletReportFixture()), role: "owner" });
    expect(rows()).toContainEqual(
      expect.stringContaining(
        "the personal Boat account of @acme-ci · fixed: sealant names it on every request",
      ),
    );
    expect(radios()).toEqual([]);
  });

  it("lets an owner choose among three wallets, with the one billed now chosen, and change it", async () => {
    const report = threeWalletsReportFixture();
    const { state } = await open({ status: connected(report), role: "owner" });
    expect(radios()).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("The personal Boat account of @acme-ci"),
        checked: false,
      }),
      expect.objectContaining({ text: expect.stringContaining("bills now"), checked: true }),
      expect.objectContaining({
        text: expect.stringContaining("active in Boat now"),
        checked: false,
      }),
    ]);
    expect(rows()).toContainEqual(
      expect.stringContaining("the Boat organization beta-labs (member) · active in Boat now"),
    );
    expect(byText("button", "Billed here now").hasAttribute("disabled")).toBe(true);
    const beta = [...document.querySelectorAll<HTMLElement>('[role="radio"]')][2];
    if (beta === undefined) throw new Error("no third wallet");
    await click(beta);
    state.chooseWallet = {
      data: connected({
        ...report,
        organization: "org_12",
        billing: { mode: "pinned", organization: "org_12" },
      }),
    };
    await click(byText("button", "Bill the Boat organization beta-labs"));
    expect(state.calls).toContainEqual({
      path: "boatKey.chooseWallet",
      input: { wallet: "org_12" },
    });
    expect(radios()[2]).toMatchObject({
      checked: true,
      text: expect.stringContaining("bills now"),
    });
    expect(byText("button", "Billed here now").hasAttribute("disabled")).toBe(true);
  });

  it("shows a refused change and keeps the wallet billed now", async () => {
    const { state } = await open({ status: connected(threeWalletsReportFixture()), role: "owner" });
    state.chooseWallet = {
      refuse:
        "This key's Boat account cannot bill that wallet, so nothing changed. Choose one of the wallets Mend lists for the key; Check now reads them from Boat again.",
    };
    const personal = [...document.querySelectorAll<HTMLElement>('[role="radio"]')][0];
    if (personal === undefined) throw new Error("no personal wallet");
    await click(personal);
    await click(byText("button", "Bill the personal Boat account of @acme-ci"));
    expect(alerts()).toContainEqual(
      expect.stringContaining("This key's Boat account cannot bill that wallet"),
    );
    expect(radios()[1]).toMatchObject({ text: expect.stringContaining("bills now") });
  });

  it("says the bill moved for a key sealant has not pinned whose active wallet changed", async () => {
    await open({ status: connected(walletChangedReportFixture()), role: "owner" });
    expect(rows()).toContainEqual(
      expect.stringContaining("not fixed: it follows the active wallet of the key's Boat account"),
    );
    expect(alerts()).toContainEqual(
      expect.stringContaining(
        "The bill moved: this key billed the personal Boat account of @acme-ci until the active wallet of its Boat account changed, observed 2026-11-13 09:30 UTC, and bills the Boat organization acme-boat now.",
      ),
    );
  });

  it("names what sealant cannot reach, by the names Boat shows, and what to do", async () => {
    await open({
      status: connected(threeWalletsReportFixture(), NO_FULL_CHECK, boatUnreachableFixture),
      role: "owner",
    });
    expect(notices()).toContainEqual(
      expect.stringContaining(
        "sealant made the saved images sealant-img-a1b2 and sealant-img-c3d4 (Saved snapshots in Boat)",
      ),
    );
    expect(notices()).toContainEqual(
      expect.stringContaining(
        "Replace the organization's key with one made with account.read: sealant then reads them again and records gone what Boat no longer holds.",
      ),
    );
  });
});
