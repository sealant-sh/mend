import { boatKeyReportFixture } from "@mend/domain/boat-key-fixtures";
// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { PersonBoatKeyStatusDto } from "#/lib/api";

import { PersonBoatKeySection } from "./boat-key.tsx";
import {
  type Answer,
  byText,
  cachedText,
  click,
  renderWithTrpc,
  settle,
} from "./sessions-test-trpc.tsx";

const KEY = "boat_live_SYNTHETIC0123456789abcdef";
const CONNECTED_AT = new Date("2026-11-08T09:00:00Z");

const notConnected = (organizationKey = false): PersonBoatKeyStatusDto => ({
  organizationName: "Acme",
  connected: false,
  sessionRuntime: "boat",
  organizationKey,
  details: null,
});

const connected = (organizationKey = false): PersonBoatKeyStatusDto => ({
  ...notConnected(organizationKey),
  connected: true,
  details: {
    sealantBoatAccountId: "core-boat-own",
    connectedByUserId: "carol",
    connectedByName: "Carol",
    connectedAt: CONNECTED_AT,
    keyReplacedAt: null,
    report: null,
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
  status: Answer;
  readonly calls: Array<{ readonly path: string; readonly input: unknown }>;
  connect: Answer;
  disconnect: Answer;
}

const open = async (status: Answer, extra: Partial<World> = {}) => {
  const state: World = {
    status,
    calls: [],
    connect: { data: connected() },
    disconnect: { data: { ...notConnected(), removal: { standbysDrained: 0 } } },
    ...extra,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = await renderWithTrpc(
    <PersonBoatKeySection />,
    (path, input) => {
      state.calls.push({ path, input });
      switch (path) {
        case "personBoatKey.status":
          return state.status;
        case "personBoatKey.connect":
          if ("data" in state.connect) state.status = { data: connected() };
          return state.connect;
        case "personBoatKey.disconnect":
          if ("data" in state.disconnect) state.status = { data: notConnected() };
          return state.disconnect;
        default:
          return { data: null };
      }
    },
    queryClient,
  );
  await settle();
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

describe("a person's own Boat key on the account page (SLNT-797)", () => {
  it("names the organization it applies to and says what connecting means before asking for the key", async () => {
    await open({ data: notConnected() });
    expect(text()).toContain("not connected");
    expect(text()).toContain(
      "The Boat sessions you start in Acme run in, and are billed to, your own Boat account. Without your own key they use the server's Boat key.",
    );
    expect(text()).toContain(
      "This key applies in Acme only: the organization's repositories are checked out in VMs in your Boat account, and its owners see that you have connected one, never its details.",
    );
    expect(text()).toContain(
      "Mend keeps no standby workspace on your key, so your Boat sessions here start without one",
    );
    expect(text()).toContain("Your key builds its own image in your Boat account");
    expect(keyInput().type).toBe("password");
  });

  it("says the organization's key decides without theirs, when it has one", async () => {
    await open({ data: notConnected(true) });
    expect(text()).toContain("Without your own key they use the organization's Boat key.");
  });

  it("connects their key, then forgets it: the field, the caches and the page never hold it", async () => {
    const { state, queryClient } = await open({ data: notConnected() });
    await type(`${KEY}\n`);
    await click(byText("button", "Check and connect"));
    await settle();
    expect(state.calls.find((call) => call.path === "personBoatKey.connect")?.input).toEqual({
      key: KEY,
    });
    expect(state.calls.some((call) => call.path.startsWith("boatKey."))).toBe(false);
    expect(text()).toContain("connected by Carol");
    expect(cachedText(queryClient)).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("shows what Boat said about their own key, as the organization's card does", async () => {
    const base = connected();
    const details = base.details;
    if (details === null) throw new Error("connected has details");
    await open({
      data: { ...base, details: { ...details, report: boatKeyReportFixture({}, CONNECTED_AT) } },
    });
    expect(text()).toContain("Acme CI");
    expect(text()).toContain("acme-boat");
    expect(text()).toContain("7 of 10 included slots used");
  });

  it("removes their key after saying where their sessions go then", async () => {
    const { state } = await open({ data: connected(true) });
    await click(byText("button", "Remove…"));
    // The dialog's module loads on its first open.
    await settle();
    expect(text()).toContain("Your new Boat sessions in Acme use the organization's Boat key.");
    expect(text()).toContain("Mend refuses while your Boat account still holds VMs");
    await click(byText("button", "Remove the Boat key"));
    await settle();
    expect(state.calls.map((call) => call.path)).toContain("personBoatKey.disconnect");
    expect(text()).toContain("not connected");
  });

  it("keeps the key and says why when a removal is refused", async () => {
    const refusal =
      "Your Boat account still has 1 session workspace whose VM Boat may be running, so nothing changed and the key stays.";
    await open({ data: connected() }, { disconnect: { refuse: refusal } });
    await click(byText("button", "Remove…"));
    await click(byText("button", "Remove the Boat key"));
    await settle();
    expect(text()).toContain(refusal);
    expect(text()).toContain("connected by Carol");
  });

  it("is left out for a sign-in with no organization", async () => {
    await open({ refuse: "NotFound" });
    expect(text()).toBe("");
  });
});
