import { ProjectId, type WorkspaceImage } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { OrganizationRuntimeSwitchDto } from "./api.ts";
import {
  impactCount,
  impactRows,
  imageWords,
  offerLine,
  runtimeChoices,
  runtimeIntro,
  standingImpact,
  switchedLine,
  switchStep,
} from "./runtime-switch.ts";
import { clockTime } from "./session-view.ts";

const at = new Date("2026-11-19T09:41:00Z");
const time = clockTime(at);

const arch: WorkspaceImage = {
  mode: "family",
  os: "arch",
  packages: ["ripgrep", "jq"],
  shell: "bash",
  services: { docker: false },
  screen: false,
};
const ubuntu: WorkspaceImage = { ...arch, os: "ubuntu", packages: [] };
const custom: WorkspaceImage = {
  mode: "custom",
  baseImage: "node:22",
  packages: [],
  setupCommands: [],
  services: { docker: false },
};

const checkout = ProjectId.make("project-checkout");
const billing = ProjectId.make("project-billing");

type Observed = Extract<OrganizationRuntimeSwitchDto["impact"], { state: "observed" }>;

const observed = (overrides: Partial<Observed> = {}): Observed => ({
  state: "observed",
  observedAt: at,
  runtime: "boat",
  organizationDefault: null,
  projects: [],
  unseen: 0,
  ...overrides,
});

const view = (impact: OrganizationRuntimeSwitchDto["impact"]): OrganizationRuntimeSwitchDto => ({
  chosen: "boat",
  effective: "boat",
  impact,
});

describe("the runtimes the page lists", () => {
  it("lists what the server offers, Docker first, with where new sessions run now selected", () => {
    const choices = runtimeChoices({
      chosen: "boat",
      effective: "boat",
      offered: ["boat", "docker"],
      serverDefault: "docker",
    });
    expect(choices).toEqual({ kind: "offered", runtimes: ["docker", "boat"], selected: "boat" });
    expect(offerLine(choices)).toBe("An operator chose which runtimes this server offers.");
  });

  it("lists this server's KVM between Docker and Boat when the server offers it", () => {
    expect(
      runtimeChoices({
        chosen: "host-vm",
        effective: "host-vm",
        offered: ["host-vm", "docker", "boat"],
        serverDefault: "host-vm",
      }),
    ).toEqual({ kind: "offered", runtimes: ["docker", "host-vm", "boat"], selected: "host-vm" });
  });

  it("selects the server's default for an organization that never chose", () => {
    expect(
      runtimeChoices({
        chosen: null,
        effective: "docker",
        offered: ["docker", "boat"],
        serverDefault: "docker",
      }),
    ).toMatchObject({ selected: "docker" });
  });

  it("says when the server offers one runtime", () => {
    const choices = runtimeChoices({
      chosen: null,
      effective: "docker",
      offered: ["docker"],
      serverDefault: "docker",
    });
    expect(offerLine(choices)).toBe(
      "This server offers only Docker. An operator chose which runtimes it offers.",
    );
  });

  it("has nothing to choose where Sealant picks", () => {
    const choices = runtimeChoices({
      chosen: null,
      effective: null,
      offered: [],
      serverDefault: null,
    });
    expect(choices).toEqual({ kind: "sealant-picks" });
    expect(offerLine(choices)).toContain("mend server setup --session-runtimes");
  });
});

describe("who can change it", () => {
  it("reads the frame's words to an owner", () => {
    expect(runtimeIntro("Northwind", true, ["Ada"])).toBe(
      "Where Northwind's new sessions run. Running sessions stay where they are. Only owners can change this.",
    );
  });

  it("names the owners to everyone else", () => {
    expect(runtimeIntro("Northwind", false, ["Ada Lovelace", "Grace Hopper"])).toBe(
      "Where Northwind's new sessions run. Running sessions stay where they are. Only an owner can change this: Ada Lovelace and Grace Hopper.",
    );
    expect(runtimeIntro("Northwind", false, [])).toContain("Only an owner of Northwind");
  });
});

describe("what a switch would change", () => {
  it("switches straight away when the server says nothing changes for new sessions", () => {
    expect(switchStep(view(observed()), "boat", "Northwind")).toEqual({ kind: "switch" });
  });

  it("asks first, listing what the runtime wouldn't run and offering the move", () => {
    const step = switchStep(
      view(
        observed({
          organizationDefault: {
            refusal: "Boat runs no Arch.",
            from: arch,
            to: ubuntu,
            inherited: false,
          },
          projects: [
            {
              id: checkout,
              name: "checkout-api",
              environment: {
                refusal: "Boat runs no Arch.",
                from: arch,
                to: ubuntu,
                inherited: false,
              },
              services: [],
              serverFolders: null,
            },
          ],
          unseen: 2,
        }),
      ),
      "boat",
      "Northwind",
    );
    if (step.kind !== "ask") throw new Error("expected to ask");
    expect(step.ask.title).toBe("Before new sessions run on Boat");
    expect(step.ask.lead).toBe(
      `Boat can't run everything in Northwind as it is, as Sealant reported at ${time}. Running sessions stay where they are; this is about new sessions.`,
    );
    expect(step.ask.heading).toBe(
      "What Boat wouldn't run: 3 projects and Northwind's workspace image",
    );
    expect(step.ask.moves).toEqual({ organizationDefault: true, projects: [checkout] });
    expect(step.ask.confirm).toBe("Switch without moving");
    expect(step.ask.rows.map((row) => row.name)).toEqual([
      "Northwind's workspace image",
      "checkout-api",
      "2 private projects",
    ]);
  });

  it("offers only switching anyway when nothing can be moved", () => {
    const step = switchStep(
      view(
        observed({
          projects: [
            {
              id: billing,
              name: "billing",
              environment: null,
              services: [{ name: "ssh", port: 22 }],
              serverFolders: null,
            },
          ],
        }),
      ),
      "boat",
      "Northwind",
    );
    if (step.kind !== "ask") throw new Error("expected to ask");
    expect(step.ask.moves).toBeNull();
    expect(step.ask.moveNote).toBeNull();
    expect(step.ask.confirm).toBe("Switch to Boat anyway");
    expect(step.ask.heading).toBe("What Boat wouldn't run: 1 project");
  });

  it("says Mend couldn't check when Sealant didn't answer, or doesn't launch the runtime", () => {
    const unread = switchStep(view({ state: "unread", reason: "timed out" }), "boat", "Northwind");
    if (unread.kind !== "ask") throw new Error("expected to ask");
    expect(unread.ask.lead).toContain("Mend couldn't read what Boat runs (timed out)");
    expect(unread.ask.heading).toBeNull();
    expect(unread.ask.confirm).toBe("Switch to Boat anyway");

    const notLaunched = switchStep(
      view({ state: "not-launched", observedAt: at, runtime: "boat" }),
      "boat",
      "Northwind",
    );
    if (notLaunched.kind !== "ask") throw new Error("expected to ask");
    expect(notLaunched.ask.lead).toContain(
      `Sealant on this server doesn't launch Boat workspaces (checked at ${time})`,
    );
  });
});

describe("the rows", () => {
  it("says each thing the runtime wouldn't run, with Sealant's reason", () => {
    const rows = impactRows(
      observed({
        organizationDefault: {
          refusal: "No custom images.",
          from: custom,
          to: null,
          inherited: false,
        },
        projects: [
          {
            id: checkout,
            name: "checkout-api",
            environment: {
              refusal: "Boat runs no Arch.",
              from: arch,
              to: ubuntu,
              inherited: false,
            },
            services: [{ name: "web", port: 22 }],
            serverFolders: { count: 2, refusal: "Boat can't bind server folders." },
          },
        ],
        unseen: 1,
      }),
      "Northwind",
    );
    expect(rows).toEqual([
      {
        key: "organization",
        name: "Northwind's workspace image",
        facts: [
          {
            text: "the image node:22, and Boat runs no image Mend can move it to",
            why: "No custom images.",
          },
        ],
      },
      {
        key: checkout,
        name: "checkout-api",
        facts: [
          {
            text: "New sessions wouldn't start on Arch with 2 packages → Ubuntu with Mend's default packages",
            why: "Boat runs no Arch.",
          },
          { text: "Service web on port 22 couldn't listen: Boat holds that port" },
          {
            text: "2 server folders: sessions start without them",
            why: "Boat can't bind server folders.",
          },
        ],
      },
      {
        key: "unseen",
        name: "1 private project",
        facts: [
          {
            text: "Another member's private project uses something Boat doesn't run. Mend doesn't name or move it; its creator can change it.",
          },
        ],
      },
    ]);
  });

  it("counts projects and the image the way the heading says them", () => {
    expect(impactCount(observed({ unseen: 1 }), "Northwind")).toBe("1 project");
    expect(
      impactCount(
        observed({
          organizationDefault: { refusal: "x", from: arch, to: ubuntu, inherited: false },
        }),
        "Northwind",
      ),
    ).toBe("Northwind's workspace image");
  });

  it("names an image by its family and packages, or its base image", () => {
    expect(imageWords(arch)).toBe("Arch with 2 packages");
    expect(imageWords({ ...arch, packages: ["jq"] })).toBe("Arch with 1 package");
    expect(imageWords(custom)).toBe("the image node:22");
  });
});

describe("after a switch", () => {
  it("shows what the runtime new sessions run on now doesn't run, with the move", () => {
    const standing = standingImpact(
      view(
        observed({
          projects: [
            {
              id: checkout,
              name: "checkout-api",
              environment: {
                refusal: "Boat runs no Arch.",
                from: arch,
                to: ubuntu,
                inherited: false,
              },
              services: [],
              serverFolders: null,
            },
          ],
        }),
      ),
      "Northwind",
    );
    expect(standing?.lead).toBe(
      `New sessions in Northwind run on Boat, which can't run everything here as it is, as Sealant reported at ${time}.`,
    );
    expect(standing?.moves).toEqual({ organizationDefault: false, projects: [checkout] });
    expect(standing?.moveLabel).toBe("Move to what Boat runs");
  });

  it("shows nothing when the runtime runs everything, or Sealant wasn't read", () => {
    expect(standingImpact(view(observed()), "Northwind")).toBeNull();
    expect(standingImpact(view({ state: "unread", reason: "x" }), "Northwind")).toBeNull();
  });

  it("says where new sessions run now, and that the move happened", () => {
    expect(switchedLine("Northwind", "boat", false)).toBe("New sessions in Northwind run on Boat.");
    expect(switchedLine("Northwind", "docker", true)).toBe(
      "Moved. New sessions in Northwind run on Docker.",
    );
  });
});
