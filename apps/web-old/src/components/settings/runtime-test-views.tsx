import { RuntimeSupport, type RuntimeSupportReading, type SessionRuntime } from "@mend/domain";
import {
  BOAT_SUPPORT,
  DOCKER_SUPPORT,
  OBSERVED_AT,
  observedSupportReading,
} from "@mend/domain/runtime-support-fixtures";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * `organization.runtime` and `organization.current` as the server answers them, for pages that
 * judge choices against where the viewer's organization's new sessions run.
 */
export interface RuntimeView {
  readonly sessionRuntime: {
    readonly chosen: SessionRuntime | null;
    readonly effective: SessionRuntime | null;
    readonly offered: ReadonlyArray<SessionRuntime>;
    readonly serverDefault: SessionRuntime | null;
  };
  readonly support: RuntimeSupportReading;
}

const view = (
  effective: SessionRuntime,
  offered: ReadonlyArray<SessionRuntime>,
  support: RuntimeSupportReading,
): RuntimeView => ({
  sessionRuntime: {
    chosen: offered.length > 1 ? effective : null,
    effective,
    offered,
    serverDefault: offered[0] ?? null,
  },
  support,
});

/** The installs the pickers are tried on. */
export const RUNTIMES = {
  boat: view("boat", ["boat"], observedSupportReading(BOAT_SUPPORT)),
  docker: view("docker", ["docker"], observedSupportReading(DOCKER_SUPPORT)),
  bothOnDocker: view("docker", ["docker", "boat"], observedSupportReading(DOCKER_SUPPORT)),
  bothOnBoat: view("boat", ["docker", "boat"], observedSupportReading(BOAT_SUPPORT)),
  unread: view("boat", ["boat"], {
    state: "unread",
    reason: "Sealant did not answer within 5 seconds",
  }),
  notLaunched: view("boat", ["boat"], {
    state: "not-launched",
    observedAt: OBSERVED_AT,
    runtime: "boat",
  }),
  /** A Boat that runs Arch: what the picker allows follows the report, never a copy of it. */
  boatWithArch: view(
    "boat",
    ["boat"],
    observedSupportReading(
      new RuntimeSupport({
        ...BOAT_SUPPORT,
        os: { ...BOAT_SUPPORT.os, arch: { supported: true } },
      }),
    ),
  ),
} as const;

export const ACME = {
  organization: { id: "org-acme", name: "Acme" },
  userId: "carol",
  role: "owner",
  memberCount: 1,
  operator: true,
  tenancy: "single",
  mountDelivery: "bind",
};

// Save bars guard their draft through the router, so pages render inside one.
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

export function InRouter({ children }: { readonly children: ReactNode }) {
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
}

/** The OS or Base choice named `label` in the segment named `segment`. */
export const choice = (segment: string, label: string): HTMLButtonElement => {
  const group = document.querySelector(`[aria-label="${segment}"]`);
  const found = [...(group?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no ${label} in ${segment}`);
  return found;
};

/** The words a choice's tip holds, which screen readers get as its description. */
export const tipOf = (button: HTMLElement): string | null => {
  const holder = button.closest("[aria-describedby]");
  const id = holder?.getAttribute("aria-describedby");
  return id == null ? null : (document.getElementById(id)?.textContent ?? null);
};

/** The page's text with runs of whitespace as one space. */
export const pageText = (): string => (document.body.textContent ?? "").replace(/\s+/g, " ");
