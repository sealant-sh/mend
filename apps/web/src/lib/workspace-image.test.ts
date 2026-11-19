import { BOAT_SUPPORT, DOCKER_SUPPORT } from "@mend/domain/runtime-support-fixtures";
import { describe, expect, it } from "vitest";

import {
  addPackages,
  customCommandLine,
  customCommandValue,
  customUnavailable,
  draftOf,
  draftProblem,
  imageLine,
  imageOf,
  installSwitchLine,
  osUnavailable,
  readyWords,
  resolutionIssue,
} from "./workspace-image.ts";

const family = {
  mode: "family" as const,
  os: "arch" as const,
  shell: "zsh" as const,
  packages: ["pnpm", "jq"],
  services: { docker: true },
  screen: false,
};

describe("the image draft", () => {
  it("round-trips a family image and keeps the other kind's fields while switching", () => {
    expect(imageOf(draftOf(family))).toEqual(family);
    const custom = imageOf({
      ...draftOf(family),
      mode: "custom",
      baseImage: " node:22-bookworm ",
      setupCommands: "echo one\n\n  echo two  \n",
    });
    expect(custom).toEqual({
      mode: "custom",
      baseImage: "node:22-bookworm",
      packages: ["pnpm", "jq"],
      setupCommands: ["echo one", "echo two"],
      services: { docker: true },
    });
    // Back to the family: its OS and shell are still the ones it had.
    expect(imageOf({ ...draftOf(custom), mode: "family", os: "arch", shell: "zsh" })).toMatchObject(
      { mode: "family", os: "arch", shell: "zsh" },
    );
  });

  it("holds back a custom image with no base", () => {
    expect(draftProblem({ ...draftOf(family), mode: "custom", baseImage: " " })).toMatch(
      /Type the base image/,
    );
    expect(draftProblem(draftOf(family))).toBeNull();
  });

  it("says the image in a line", () => {
    expect(imageLine(family)).toBe("Arch, zsh and 2 packages.");
    expect(
      imageLine({
        mode: "custom",
        baseImage: "node:22",
        packages: ["jq"],
        setupCommands: ["make"],
        services: { docker: false },
      }),
    ).toBe("Built from node:22, with 1 package and 1 setup command.");
  });
});

describe("addPackages", () => {
  it("adds typed names after the others, lowercased and without repeats", () => {
    expect(addPackages(["pnpm"], "Redis, jq  pnpm")).toEqual({
      packages: ["pnpm", "redis", "jq"],
      invalid: null,
    });
  });

  it("refuses a name that can't be a package, changing nothing", () => {
    expect(addPackages(["pnpm"], "jq ../etc")).toEqual({ packages: ["pnpm"], invalid: "../etc" });
  });
});

describe("resolutionIssue", () => {
  const base = { canonicalId: "redis", supported: true, alternatives: [] as string[] };
  it("says nothing for a package the server resolved", () => {
    expect(resolutionIssue({ ...base, status: "resolved" }, "arch")).toBeNull();
  });
  it("words each refusal", () => {
    expect(resolutionIssue({ ...base, status: "not-found" }, "arch")).toBe(
      "Sealant could not find this package.",
    );
    expect(
      resolutionIssue({ ...base, status: "ambiguous", alternatives: ["redis", "valkey"] }, "arch"),
    ).toBe("Sealant found more than one match. Try redis, valkey.");
    expect(resolutionIssue({ ...base, status: "unsupported", supported: false }, "nix")).toBe(
      "Sealant found the package, but not for Nix.",
    );
  });
});

describe("what the runtime can run", () => {
  it("follows the runtime's report, not a list of its own", () => {
    expect(osUnavailable(BOAT_SUPPORT, "arch")).toMatch(/Arch is unsupported/);
    expect(osUnavailable(BOAT_SUPPORT, "ubuntu")).toBeNull();
    expect(customUnavailable(BOAT_SUPPORT)).toMatch(/custom OCI base image/);
    expect(customUnavailable(DOCKER_SUPPORT)).toBeNull();
    // Nothing known: every choice stays open.
    expect(osUnavailable(null, "arch")).toBeNull();
  });
});

describe("Dependencies", () => {
  const detection = {
    ref: "origin/main",
    read: true,
    command: "pnpm install --frozen-lockfile",
    from: "pnpm-lock.yaml",
  };

  it("says what Mend found on the default branch, or the custom command", () => {
    expect(customCommandLine(null, detection)).toBe(
      "Mend found pnpm install --frozen-lockfile from pnpm-lock.yaml on main and runs it. Type a command to replace it.",
    );
    expect(customCommandLine("make deps", detection)).toBe(
      "Mend runs this instead of the command it found from the lockfile.",
    );
    expect(customCommandLine(null, { ...detection, command: null, from: null })).toMatch(
      /^Mend found no lockfile it knows on main/,
    );
    expect(customCommandLine(null, { ...detection, read: false })).toMatch(
      /^Mend couldn't read main/,
    );
  });

  it("sends a blank field as no custom command", () => {
    expect(customCommandValue("  ")).toBeNull();
    expect(customCommandValue(" make deps ")).toBe("make deps");
  });

  it("says when install is off, and that the custom command is kept", () => {
    expect(installSwitchLine(false, "make deps")).toMatch(/keeps your custom command/);
    expect(installSwitchLine(false, null)).not.toMatch(/custom command/);
  });
});

describe("readyWords", () => {
  const status = { hotSessions: 2, ready: 0, warming: 0, failed: 0, error: null };
  it("says off, none yet, or what is ready, starting and failed", () => {
    expect(readyWords({ ...status, hotSessions: 0 })).toBe("Off");
    expect(readyWords(status)).toBe("None ready yet");
    expect(readyWords({ ...status, ready: 1, warming: 1 })).toBe("1 ready for you, 1 starting");
    expect(readyWords({ ...status, failed: 2 })).toBe("2 failed");
  });
});
