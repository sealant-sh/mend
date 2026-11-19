// @vitest-environment jsdom
import {
  defaultSettings,
  defaultWorkspaceImage,
  MendSettings,
  organizationDefaults,
  newOrganizationSettings,
} from "@mend/domain";
import { act, Suspense } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { OrganizationEnvironmentTab } from "./environment-organization.tsx";
import { ACME, InRouter, pageText, RUNTIMES, type RuntimeView } from "./runtime-test-views.tsx";
import { renderWithTrpc, type Answer } from "./sessions-test-trpc.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** The instance keeps Mend's built-in Arch; the organization follows it. */
const instance = new MendSettings({ ...defaultSettings, workspaceImage: defaultWorkspaceImage });

const render = async (runtime: RuntimeView, role: "owner" | "member") => {
  root = await renderWithTrpc(
    <InRouter>
      <Suspense fallback={null}>
        <OrganizationEnvironmentTab />
      </Suspense>
    </InRouter>,
    (path): Answer => {
      if (path === "organization.current") return { data: { ...ACME, role } };
      if (path === "organization.runtime") return { data: runtime };
      if (path === "organization.settings")
        return {
          data: {
            organization: newOrganizationSettings(defaultWorkspaceImage),
            instance,
            effective: organizationDefaults(
              instance,
              newOrganizationSettings(defaultWorkspaceImage),
            ),
            editable: role === "owner",
            sessionRuntime: runtime.sessionRuntime,
          },
        };
      return { refuse: `no fake for ${path}` };
    },
  );
};

const NOTE =
  "Boat supports Ubuntu and Nix; Arch is unsupported. New sessions in Acme run on Boat, so no new project that starts from this image can start one.";

describe("the organization's environment, folded", () => {
  it("shows a member the organization's own starting image, says on Boat it cannot start, and to ask an owner", async () => {
    await render(RUNTIMES.boat, "member");
    expect(pageText()).toContain("arch · 19 packages · set for Acme");
    expect(pageText()).not.toContain("from the instance");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(NOTE);
    expect(pageText()).toContain("Ask an owner of Acme to change it.");
  });

  it("says nothing on Docker, or when Sealant was not read", async () => {
    await render(RUNTIMES.docker, "owner");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    act(() => root?.unmount());
    document.body.replaceChildren();
    await render(RUNTIMES.unread, "owner");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
