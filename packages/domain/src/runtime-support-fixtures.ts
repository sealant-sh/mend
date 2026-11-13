import {
  RuntimeSupport,
  type RuntimeSupportReading,
  WorkspaceRuntimes,
  type WorkspaceRuntimesReading,
} from "./runtime-support.ts";

/**
 * Reports for tests, shaped like Core's 0.40.0-next.870 answers for this server's Docker and for
 * Boat. Tests change them to show that what Mend allows follows the report, never its own copy.
 */

const SUPPORTED = { supported: true } as const;
const no = (message: string) => ({ supported: false, message }) as const;

export const DOCKER_SUPPORT = new RuntimeSupport({
  runtime: "docker",
  os: { ubuntu: SUPPORTED, nix: SUPPORTED, arch: SUPPORTED, fedora: SUPPORTED },
  customImage: SUPPORTED,
  hostDirectories: SUPPORTED,
  docker: SUPPORTED,
  gvisor: SUPPORTED,
  clusterEnv: no(
    "Docker workspaces cannot read Kubernetes Secrets, ConfigMaps or a service account; only Kubernetes workspaces can. Remove them from this workspace.",
  ),
  gitSource: SUPPORTED,
  dotfilesArchives: SUPPORTED,
  screen: { supported: true, architectures: ["x86_64"] },
  reservedPorts: [],
  resources: { supported: true, attach: "live" },
  idleCost: {
    charged: false,
    message:
      "A Docker workspace runs on this deployment's own servers: sitting idle costs nothing beyond them.",
  },
});

export const BOAT_SUPPORT = new RuntimeSupport({
  runtime: "boat",
  os: {
    ubuntu: SUPPORTED,
    nix: SUPPORTED,
    arch: no("Boat supports Ubuntu and Nix; Arch is unsupported."),
    fedora: no("Boat supports Ubuntu and Nix; Fedora is unsupported."),
  },
  customImage: no("Boat cannot boot a custom OCI base image."),
  hostDirectories: no("Boat cannot bind directories from this deployment's own servers."),
  docker: SUPPORTED,
  gvisor: no("Boat cannot supply the runsc OCI runtime."),
  clusterEnv: no("Boat cannot resolve Kubernetes environment references."),
  gitSource: no(
    "Boat starts a workspace only from a capture of its files, not by cloning a repository.",
  ),
  dotfilesArchives: no(
    "Boat cannot apply dotfiles sent as archives with the create. Name a dotfiles repository instead.",
  ),
  screen: { supported: true, architectures: ["x86_64"] },
  reservedPorts: [8080],
  resources: { supported: true, attach: "live" },
  idleCost: {
    charged: true,
    message: "Boat bills a workspace by the second while its VM runs, idle or not.",
  },
});

export const OBSERVED_AT = new Date("2026-11-13T14:02:00.000Z");

/** Core's answer listing `runtimes`, the first its default. */
export const observedRuntimes = (
  ...runtimes: ReadonlyArray<RuntimeSupport>
): WorkspaceRuntimesReading => ({
  state: "observed",
  observedAt: OBSERVED_AT,
  runtimes: new WorkspaceRuntimes({
    default: runtimes[0]?.runtime ?? "docker",
    runtimes: [...runtimes],
  }),
});

/** An install offering this server's Docker and Boat, as most Boat installs do. */
export const DOCKER_AND_BOAT = observedRuntimes(DOCKER_SUPPORT, BOAT_SUPPORT);

export const UNREAD: WorkspaceRuntimesReading = {
  state: "unread",
  reason: "Sealant did not answer within 5 seconds",
};

/** One runtime's support as an organization's page reads it. */
export const observedSupportReading = (support: RuntimeSupport): RuntimeSupportReading => ({
  state: "observed",
  observedAt: OBSERVED_AT,
  support,
});
