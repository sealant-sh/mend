import type { RuntimeSupport, WorkspaceImage } from "@mend/domain";
import { describe, expect, it } from "vitest";

import {
  pickerNotes,
  refusedFamilies,
  type RuntimeFacts,
  runtimeFacts,
} from "./runtime-support.ts";

const yes = { supported: true } as const;
const no = (message: string) => ({ supported: false, message }) as const;

const support = (overrides: Partial<RuntimeSupport> = {}): RuntimeSupport => ({
  runtime: "boat",
  os: { ubuntu: yes, nix: yes, arch: no("Boat runs no Arch."), fedora: no("Boat runs no Fedora.") },
  customImage: yes,
  hostDirectories: yes,
  docker: yes,
  gvisor: yes,
  clusterEnv: yes,
  gitSource: yes,
  dotfilesArchives: yes,
  screen: { supported: true, architectures: ["x86_64"] },
  reservedPorts: [],
  resources: { supported: true, attach: "live" },
  idleCost: { charged: false, message: "" },
  ...overrides,
});

const observed: RuntimeFacts = { state: "observed", organization: "Northwind", support: support() };

const image = (os: "arch" | "ubuntu"): WorkspaceImage => ({
  mode: "family",
  os,
  packages: [],
  shell: "bash",
  services: { docker: false },
  screen: false,
});

describe("what the runtime can run", () => {
  it("refuses an OS family the runtime doesn't run, says why, and keeps Save off", () => {
    expect([...refusedFamilies(observed)].toSorted()).toEqual(["arch", "fedora"]);
    const notes = pickerNotes(observed, image("arch"));
    expect(notes.os).toContain("New sessions in Northwind run on Boat.");
    expect(notes.blocks).toBe("Not saved yet: Boat can't run this image.");
  });

  it("names the families it doesn't run when the draft is fine", () => {
    const notes = pickerNotes(observed, image("ubuntu"));
    expect(notes.blocks).toBeNull();
    expect(notes.os).toBe("New sessions in Northwind run on Boat. It doesn't run Arch, Fedora.");
  });

  it("leaves every choice open, and says so, when Mend couldn't read the runtime", () => {
    const facts = runtimeFacts(
      {
        sessionRuntime: {
          chosen: null,
          effective: "boat",
          offered: ["boat"],
          serverDefault: "boat",
        },
        support: { state: "unread", reason: "timed out" },
      },
      "Northwind",
    );
    expect(refusedFamilies(facts).size).toBe(0);
    expect(pickerNotes(facts, image("arch"))).toEqual({
      base: "Not checked against Boat: Mend couldn't read what it supports from Sealant (timed out). A session that can't start says why.",
      os: null,
      blocks: null,
    });
  });

  it("says nothing while it reads", () => {
    expect(pickerNotes({ state: "pending" }, image("arch"))).toEqual({
      base: null,
      os: null,
      blocks: null,
    });
  });
});
