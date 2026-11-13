// @vitest-environment jsdom
import { MachineView } from "@mend/api-contracts";
import {
  boatKeyReportFixture,
  boatUnreachableFixture,
  refusedKeyReportFixture,
  serverBoatFactsFixture,
} from "@mend/domain/boat-key-fixtures";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SessionsAndBoat } from "./exposure-sessions.tsx";
import { byText, click, renderWithTrpc } from "./sessions-test-trpc.tsx";

const NOW = new Date("2026-11-13T14:02:00Z");

let root: Root | null = null;
afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted !== null) await act(async () => mounted.unmount());
  document.body.innerHTML = "";
});

const machine = (fields: Partial<MachineView> = {}) =>
  new MachineView({
    hostname: "fixture",
    platform: "linux",
    tailnet: { status: "not-detected", address: null },
    ...fields,
  });

const render = async (view: MachineView): Promise<string> => {
  // The web tier flattens the contract's classes before superjson, as `run` does.
  root = await renderWithTrpc(<SessionsAndBoat now={NOW} />, (path) =>
    path === "platform.machine"
      ? { data: structuredClone(view) }
      : { refuse: `unexpected ${path}` },
  );
  return document.body.textContent ?? "";
};

describe("where sessions run, on the instance's Exposure page (SLNT-799)", () => {
  it("says what a Docker-only server offers, and nothing of Boat", async () => {
    const text = await render(
      machine({ sessionRuntimes: { offered: ["docker"], default: "docker" } }),
    );
    expect(text).toContain(
      "offered on this server's Docker · new organizations run on this server's Docker until an owner chooses · declared",
    );
    expect(text).not.toContain("boat");
  });

  it("shows the operator each Boat fact as observed and when, and what to do about a refused key", async () => {
    const text = await render(
      machine({
        sessionRuntimes: { offered: ["docker", "boat"], default: "boat" },
        boat: serverBoatFactsFixture(
          { serverKey: { state: "held", unreachable: null, report: refusedKeyReportFixture(NOW) } },
          NOW,
        ),
      }),
    );
    expect(text).toContain(
      "session traffic at https://mend.example.ts.net:8443 · answered HTTP 404 from the server · observed 2026-11-13 14:02 UTC",
    );
    expect(text).toContain("boat key");
    expect(text).toContain("needs action");
    expect(text).toContain(
      "This server's Boat key has expired, so Boat refused it and new Boat sessions cannot start with it.",
    );
    expect(text).toContain("a worker reported that it launches Boat VMs");
    expect(text).toContain("present on the worker that launches Boat");
  });

  it("lets the operator check the server's key now, then reads the machine view again", async () => {
    const before = machine({
      sessionRuntimes: { offered: ["docker", "boat"], default: "boat" },
      boat: serverBoatFactsFixture(
        { serverKey: { state: "held", unreachable: null, report: refusedKeyReportFixture(NOW) } },
        NOW,
      ),
    });
    const after = machine({
      sessionRuntimes: { offered: ["docker", "boat"], default: "boat" },
      boat: serverBoatFactsFixture(
        {
          serverKey: {
            state: "held",
            unreachable: boatUnreachableFixture,
            report: boatKeyReportFixture({}, NOW),
          },
        },
        NOW,
      ),
    });
    const calls: Array<string> = [];
    let view = before;
    root = await renderWithTrpc(<SessionsAndBoat now={NOW} />, (path) => {
      calls.push(path);
      if (path === "platform.machine") return { data: structuredClone(view) };
      if (path === "platform.checkServerBoatKey") {
        view = after;
        return { data: structuredClone(after.boat?.serverKey) };
      }
      return { refuse: `unexpected ${path}` };
    });
    await click(byText("button", "Check the server's Boat key now"));
    expect(calls).toContain("platform.checkServerBoatKey");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("has expired");
    expect(text).toContain("boat unreachable");
    expect(text).toContain("give this server a key whose Boat account can see them");
  });
});
