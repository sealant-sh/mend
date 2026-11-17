// @vitest-environment jsdom
import { defaultWorkspaceImage, type WorkspaceImage } from "@mend/domain";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EnvironmentForm } from "./environment-form.tsx";
import {
  ACME,
  choice,
  InRouter,
  pageText,
  RUNTIMES,
  tipOf,
  type RuntimeView,
} from "./runtime-test-views.tsx";
import { byText, click, renderWithTrpc, type Answer } from "./sessions-test-trpc.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const ARCH: WorkspaceImage = { ...defaultWorkspaceImage, os: "arch" };
const UBUNTU: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };
const CUSTOM: WorkspaceImage = {
  mode: "custom",
  baseImage: "node:22-bookworm",
  packages: [],
  setupCommands: [],
  services: { docker: true },
};

const render = async (
  image: WorkspaceImage,
  runtime: RuntimeView | "refused" = RUNTIMES.docker,
) => {
  root = await renderWithTrpc(
    <InRouter>
      <EnvironmentForm
        title="Workspace environment"
        why="The default for every organization."
        savedImage={image}
        allowScan={false}
        pending={false}
        error={null}
        saveEffect="rebuilds images"
        onSave={() => Promise.resolve({ saved: image, resolutions: [] })}
      />
    </InRouter>,
    (path): Answer => {
      if (path === "organization.current") return { data: ACME };
      if (path === "organization.runtime")
        return runtime === "refused" ? { refuse: "the API is restarting" } : { data: runtime };
      return { refuse: `no fake for ${path}` };
    },
  );
};

const switches = () =>
  [...document.querySelectorAll('[role="switch"]')].map((control) => ({
    name: document.getElementById(control.getAttribute("aria-labelledby") ?? "")?.textContent,
    checked: control.getAttribute("aria-checked"),
  }));

const saveButton = () => byText("button", "Save environment");

describe("the workspace environment's switches", () => {
  it("names the Docker switch after what it controls, with its state in aria-checked", async () => {
    for (const on of [true, false]) {
      await render({ ...defaultWorkspaceImage, services: { docker: on } });
      expect(switches()).toContainEqual({ checked: String(on), name: "Docker service" });
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });

  it("shows a family image's Screen switch, off by default, with what it adds and costs", async () => {
    await render(defaultWorkspaceImage);
    expect(switches()).toContainEqual({ name: "Screen", checked: "false" });
    expect(pageText()).toContain("TigerVNC, XFCE, Chromium and DejaVu fonts");
    expect(pageText()).toContain(
      "each session's screen runs while the session does, about 100 MB idle",
    );
    expect(pageText()).toContain("grows the image by an amount Mend has not measured yet");
  });

  it("shows the Screen switch on when the saved image has a screen", async () => {
    await render({ ...defaultWorkspaceImage, screen: true });
    expect(switches()).toContainEqual({ name: "Screen", checked: "true" });
  });

  it("offers no Screen switch on a custom base", async () => {
    await render(CUSTOM);
    expect(switches().map(({ name }) => name)).toEqual(["Docker service"]);
  });
});

describe("the workspace environment against where new sessions run", () => {
  it("on Boat, shows Arch, Fedora and a custom image unavailable with Sealant's reasons", async () => {
    await render(UBUNTU, RUNTIMES.boat);
    for (const [label, reason] of [
      ["Arch", "Boat supports Ubuntu and Nix; Arch is unsupported."],
      ["Fedora", "Boat supports Ubuntu and Nix; Fedora is unsupported."],
    ] as const) {
      expect(choice("OS", label).disabled).toBe(true);
      expect(tipOf(choice("OS", label))).toBe(reason);
    }
    expect(choice("OS", "Ubuntu").disabled).toBe(false);
    expect(choice("OS", "Nix").disabled).toBe(false);
    expect(choice("Base", "Custom image").disabled).toBe(true);
    expect(tipOf(choice("Base", "Custom image"))).toBe("Boat cannot boot a custom OCI base image.");
    expect(pageText()).toContain(
      "New sessions in Acme run on Boat, which runs Ubuntu and Nix; Arch and Fedora are unavailable.",
    );
    expect(pageText()).toContain("Boat cannot boot a custom OCI base image.");
  });

  it("on Boat, keeps a saved Arch environment as Arch and says it cannot start and what to do", async () => {
    await render(ARCH, RUNTIMES.boat);
    expect(choice("OS", "Arch").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Boat supports Ubuntu and Nix; Arch is unsupported. New sessions in Acme run on Boat, so they cannot start from this environment. Pick Ubuntu or Nix and save.",
    );
  });

  it("on Boat, keeps a saved custom image and says to pick an OS family", async () => {
    await render(CUSTOM, RUNTIMES.boat);
    expect(choice("Base", "Custom image").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Boat cannot boot a custom OCI base image. New sessions in Acme run on Boat, so they cannot start from this environment. Pick OS family, then Ubuntu or Nix, and save.",
    );
  });

  it("on Boat, keeps Save off while the draft is one Boat cannot run, and says why", async () => {
    await render(ARCH, RUNTIMES.boat);
    await click(byText("button", "fish"));
    expect(saveButton()).toHaveProperty("disabled", true);
    expect(pageText()).toContain("1 unsaved change · Boat cannot run this environment");
    await click(byText("button", "Ubuntu"));
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(pageText()).toContain("2 unsaved changes · rebuilds images");
  });

  it("follows the report: a Boat that runs Arch leaves Arch open", async () => {
    await render(ARCH, RUNTIMES.boatWithArch);
    expect(choice("OS", "Arch").disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(pageText()).toContain(
      "New sessions in Acme run on Boat, which runs Arch, Ubuntu and Nix; Fedora is unavailable.",
    );
  });

  it("on this server's Docker, offers every choice and adds no line", async () => {
    for (const runtime of [RUNTIMES.docker, RUNTIMES.bothOnDocker]) {
      await render(ARCH, runtime);
      for (const label of ["Arch", "Fedora", "Ubuntu", "Nix"])
        expect(choice("OS", label).disabled).toBe(false);
      expect(choice("Base", "Custom image").disabled).toBe(false);
      expect(pageText()).not.toContain("New sessions in Acme");
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });

  it("on an install offering both, judges by the organization's runtime: Boat restricts", async () => {
    await render(ARCH, RUNTIMES.bothOnBoat);
    expect(choice("OS", "Arch").disabled).toBe(true);
    expect(choice("Base", "Custom image").disabled).toBe(true);
  });

  it("when the report cannot be read, keeps every choice open and says it was not checked", async () => {
    await render(ARCH, RUNTIMES.unread);
    for (const label of ["Arch", "Fedora", "Ubuntu", "Nix"])
      expect(choice("OS", label).disabled).toBe(false);
    expect(choice("Base", "Custom image").disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(pageText()).toContain(
      "Not checked against Boat: Mend could not read what it supports from Sealant (Sealant did not answer within 5 seconds). A session that cannot start says why.",
    );
  });

  it("when Sealant does not launch the runtime, keeps every choice open and says so", async () => {
    await render(ARCH, RUNTIMES.notLaunched);
    expect(choice("OS", "Arch").disabled).toBe(false);
    expect(pageText()).toMatch(
      /New sessions in Acme are set to run on Boat, but Sealant on this server does not launch Boat workspaces \(observed at \d\d:\d\d\)\. These choices are not checked against it\./,
    );
  });

  it("when where sessions run cannot be read at all, keeps every choice open", async () => {
    await render(ARCH, "refused");
    expect(choice("OS", "Arch").disabled).toBe(false);
    expect(pageText()).toContain(
      "Not checked: Mend could not read where new sessions in Acme run (the API is restarting).",
    );
  });
});
