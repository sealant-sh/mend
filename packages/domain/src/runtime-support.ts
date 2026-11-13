import { Schema } from "effect";

import {
  defaultWorkspaceImage,
  type SessionRuntime,
  type WorkspaceImage,
  type WorkspaceImageOs,
} from "./settings.ts";

/**
 * What each runtime Sealant launches workspaces on supports, as Core reports it
 * (`sealant.workspaces.runtimes()`, Core 0.40.0-next.870). The facts are Core's: Mend keeps no copy
 * of them. Every unsupported item carries the sentence Core refuses a create with, so what a page
 * shows before a save and what a launch is told agree.
 */

/** A runtime family Sealant launches workspaces on; Mend's `SessionRuntime` is two of them. */
export const RuntimeKind = Schema.Literals([
  "docker",
  "k8s",
  "k3s",
  "cloudflare",
  "microvm",
  "boat",
]);
export type RuntimeKind = typeof RuntimeKind.Type;

export const RuntimeUnsupported = Schema.Struct({
  supported: Schema.Literal(false),
  message: Schema.String,
});
export type RuntimeUnsupported = typeof RuntimeUnsupported.Type;

const Supported = Schema.Struct({ supported: Schema.Literal(true) });

export const RuntimeCapability = Schema.Union([Supported, RuntimeUnsupported]);
export type RuntimeCapability = typeof RuntimeCapability.Type;

export const RuntimeArchitecture = Schema.Literals(["x86_64", "aarch64"]);
export type RuntimeArchitecture = typeof RuntimeArchitecture.Type;

/** What one runtime supports. */
export class RuntimeSupport extends Schema.Class<RuntimeSupport>("RuntimeSupport")({
  runtime: RuntimeKind,
  os: Schema.Struct({
    ubuntu: RuntimeCapability,
    nix: RuntimeCapability,
    arch: RuntimeCapability,
    fedora: RuntimeCapability,
  }),
  customImage: RuntimeCapability,
  /** Directories of this deployment's own servers bound into the workspace. */
  hostDirectories: RuntimeCapability,
  /** Docker inside the workspace. */
  docker: RuntimeCapability,
  gvisor: RuntimeCapability,
  clusterEnv: RuntimeCapability,
  gitSource: RuntimeCapability,
  dotfilesArchives: RuntimeCapability,
  screen: Schema.Union([
    Schema.Struct({
      supported: Schema.Literal(true),
      architectures: Schema.Array(RuntimeArchitecture),
    }),
    RuntimeUnsupported,
  ]),
  /** Ports inside the workspace the runtime holds for itself. */
  reservedPorts: Schema.Array(Schema.Int),
  resources: Schema.Union([
    Schema.Struct({
      supported: Schema.Literal(true),
      attach: Schema.Literals(["live", "next-start"]),
    }),
    RuntimeUnsupported,
  ]),
  /** Whether a workspace that sits idle costs money, and Core's sentence saying so. */
  idleCost: Schema.Struct({ charged: Schema.Boolean, message: Schema.String }),
}) {}

/** The runtimes this install launches; one it cannot launch is not listed. */
export class WorkspaceRuntimes extends Schema.Class<WorkspaceRuntimes>("WorkspaceRuntimes")({
  /** What a create that names no runtime runs on. */
  default: RuntimeKind,
  runtimes: Schema.Array(RuntimeSupport),
}) {}

/**
 * What Mend knows about where an organization's new sessions run:
 *
 * - `observed`: Core listed the runtime, and this is what it supports.
 * - `not-launched`: Core answered and did not list it; this install cannot launch it.
 * - `unread`: Core did not answer. Nothing is known; a page never presents this as supported.
 */
export const RuntimeSupportReading = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("observed"),
    observedAt: Schema.Date,
    support: RuntimeSupport,
  }),
  Schema.Struct({
    state: Schema.Literal("not-launched"),
    observedAt: Schema.Date,
    runtime: RuntimeKind,
  }),
  Schema.Struct({ state: Schema.Literal("unread"), reason: Schema.String }),
]);
export type RuntimeSupportReading = typeof RuntimeSupportReading.Type;

/** Core's answer as Mend last read it, or why it could not. */
export type WorkspaceRuntimesReading =
  | { readonly state: "observed"; readonly observedAt: Date; readonly runtimes: WorkspaceRuntimes }
  | { readonly state: "unread"; readonly reason: string };

/**
 * What the runtime an organization's new sessions run on supports. `runtime` is Mend's choice for
 * it; null is an install where Sealant picks, which runs Core's default.
 */
export const runtimeSupportFor = (
  reading: WorkspaceRuntimesReading,
  runtime: SessionRuntime | null,
): RuntimeSupportReading => {
  if (reading.state === "unread") return reading;
  const kind = runtime ?? reading.runtimes.default;
  const support = reading.runtimes.runtimes.find((entry) => entry.runtime === kind);
  return support === undefined
    ? { state: "not-launched", observedAt: reading.observedAt, runtime: kind }
    : { state: "observed", observedAt: reading.observedAt, support };
};

/** What a reading can say for sure: the runtime's support, or nothing. */
export const observedSupport = (reading: RuntimeSupportReading): RuntimeSupport | null =>
  reading.state === "observed" ? reading.support : null;

const RUNTIME_NAMES: Readonly<Record<RuntimeKind, string>> = {
  docker: "this server's Docker",
  k8s: "Kubernetes",
  k3s: "k3s",
  cloudflare: "Cloudflare",
  microvm: "MicroVM",
  boat: "Boat",
};

/** Where sessions run, in plain words: "this server's Docker", "Boat". */
export const runtimeName = (runtime: RuntimeKind): string => RUNTIME_NAMES[runtime];

const messageOf = (capability: RuntimeCapability): string | null =>
  capability.supported ? null : capability.message;

/** Why the runtime cannot run this OS family, in Core's words; null when it can. */
export const osRefusal = (support: RuntimeSupport, os: WorkspaceImageOs): string | null =>
  messageOf(support.os[os]);

/** Why the runtime cannot build from a custom base image, in Core's words; null when it can. */
export const customImageRefusal = (support: RuntimeSupport): string | null =>
  messageOf(support.customImage);

/**
 * Why the runtime cannot run this workspace environment, in Core's words; null when it can. The
 * first of: its base (OS family or custom image), Docker inside, a screen.
 */
export const environmentRefusal = (support: RuntimeSupport, image: WorkspaceImage): string | null =>
  (image.mode === "custom" ? customImageRefusal(support) : osRefusal(support, image.os)) ??
  (image.services.docker ? messageOf(support.docker) : null) ??
  (image.mode === "family" && image.screen && !support.screen.supported
    ? support.screen.message
    : null);

/** Why a Service cannot listen on this workspace port, or null when it can. */
export const reservedPortRefusal = (support: RuntimeSupport, port: number): string | null =>
  support.reservedPorts.includes(port)
    ? `${runtimeName(support.runtime)} holds port ${port} inside every workspace for itself, so a Service cannot listen on it. Use another port.`
    : null;

/** Why the runtime cannot bind directories from this server, in Core's words; null when it can. */
export const hostDirectoriesRefusal = (support: RuntimeSupport): string | null =>
  messageOf(support.hostDirectories);

/** The order Mend tries OS families in when the inherited one cannot run: its default first. */
const OS_PREFERENCE: ReadonlyArray<WorkspaceImageOs> = [
  defaultWorkspaceImage.os,
  ...(["ubuntu", "fedora", "nix", "arch"] as const).filter((os) => os !== defaultWorkspaceImage.os),
];

/**
 * The environment a new project starts with: null inherits its organization's, which it does
 * whenever the runtime its sessions will run on can run it. Otherwise Mend's default packages on
 * the first OS family the runtime runs, with Docker inside only where the runtime has it. Null too
 * when nothing is known about the runtime: an environment is never changed on a guess.
 */
export const newProjectWorkspaceImage = (
  inherited: WorkspaceImage,
  support: RuntimeSupport | null,
): WorkspaceImage | null => {
  if (support === null || environmentRefusal(support, inherited) === null) return null;
  const os = OS_PREFERENCE.find((family) => support.os[family].supported);
  if (os === undefined) return null;
  return {
    ...defaultWorkspaceImage,
    os,
    services: { docker: support.docker.supported },
  };
};
