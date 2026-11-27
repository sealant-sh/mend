import type { SessionRuntime } from "@mend/domain";
import { Option, Schema } from "effect";

import {
  macHostEligibilityFailure,
  renderMacHostVmOverlay,
  type ServerMacHostVm,
} from "./server-host-vm-mac.ts";
import { type ServerProcessOptions, serverProcessDeadlines } from "./server-runtime.ts";

/**
 * The host VM runtime's disks. `compose.host-vm.yaml` maps two more roots in
 * SEALANT_DOCKER_VOLUME_MAPPINGS (base disks and each VM's data disk) and mounts their volumes. A
 * generation carries it only when the saved config names host-vm among its session runtimes:
 * every other install sends the two mappings it always sent, which a released Mend image checks.
 * Setup offers host-vm when this server's KVM passes the checks below (`observeHostVm`).
 */

export const HOST_VM_COMPOSE_FILE = "compose.host-vm.yaml";

/** deploy/docker/compose.host-vm.yaml, byte for byte (server-host-vm.test.ts holds them equal). */
export const HOST_VM_COMPOSE_OVERLAY: string = [
  "# The host VM runtime's disks: an overlay merged after compose.v2.yaml, used only when host-vm is",
  "# among the session runtimes (MEND_SESSION_RUNTIMES or MEND_SESSION_RUNTIME). host-vm boots each",
  "# workspace in a virtual machine of its own on this server's KVM. Without this file the bundle maps",
  "# the store and the control sockets only, as every install did before host-vm.",
  "#",
  "# `mend server setup` writes it into the install's generation when the saved config names host-vm;",
  "# the CLI carries a copy (apps/cli/src/server-host-vm.ts), which its tests hold to this file. For a",
  "# Compose install you run yourself:",
  "#",
  "#   docker compose -f compose.v2.yaml -f compose.host-vm.yaml up -d",
  "services:",
  "  mend:",
  "    environment:",
  "      # The base file's two mappings, then base disks (one per workspace image) and each VM's data",
  "      # disk. This value replaces the base file's.",
  "      SEALANT_DOCKER_VOLUME_MAPPINGS: >-",
  '        [{"logicalRoot":"/var/lib/mend/store","volumeName":"${MEND_STORE_VOLUME_NAME:-mend-store}"},{"logicalRoot":"/run/sealant/sockets","volumeName":"${MEND_CONTROL_VOLUME_NAME:-mend-control}"},{"logicalRoot":"/var/lib/mend/vm-images","volumeName":"${MEND_VM_IMAGES_VOLUME_NAME:-mend-vm-images}"},{"logicalRoot":"/var/lib/mend/vm-data","volumeName":"${MEND_VM_DATA_VOLUME_NAME:-mend-vm-data}"}]',
  "    volumes:",
  "      - mend-vm-images:/var/lib/mend/vm-images",
  "      - mend-vm-data:/var/lib/mend/vm-data",
  "",
  "volumes:",
  "  # Named as in SEALANT_DOCKER_VOLUME_MAPPINGS, which Sealant mounts by the volume's Docker name.",
  "  # Compose owns them: setup claims neither.",
  "  mend-vm-images:",
  "    name: ${MEND_VM_IMAGES_VOLUME_NAME:-mend-vm-images}",
  "  mend-vm-data:",
  "    name: ${MEND_VM_DATA_VOLUME_NAME:-mend-vm-data}",
  "",
].join("\n");

/** Whether the config's offered runtimes, or its one runtime when it lists none, name host-vm. */
export const namesHostVm = (settings: {
  readonly sessionRuntime?: SessionRuntime;
  readonly sessionRuntimes?: ReadonlyArray<SessionRuntime>;
}): boolean =>
  (settings.sessionRuntimes ?? [settings.sessionRuntime ?? "docker"]).includes("host-vm");

/** The overlay a generation holds, or undefined when the config names no host-vm. */
export const renderHostVmOverlay = (settings: {
  readonly sessionRuntime?: SessionRuntime;
  readonly sessionRuntimes?: ReadonlyArray<SessionRuntime>;
  readonly macHostVm?: ServerMacHostVm;
}): string | undefined =>
  !namesHostVm(settings)
    ? undefined
    : settings.macHostVm !== undefined
      ? renderMacHostVmOverlay(settings.macHostVm)
      : HOST_VM_COMPOSE_OVERLAY;

// ─── whether this server can run host-vm ────────────────────────────────────

/**
 * The vm-runner setup runs `--self-test` with: sealantd 0.21.0-next.221's (the multi-arch index),
 * which supports both Linux KVM and Apple Silicon `mac-vmd` self-tests. Moves with that pin.
 */
export const VM_RUNNER_IMAGE =
  "ghcr.io/sealant-sh/vm-runner-next:0.21.0-next.221@sha256:722fcf54623fc7b18417f0a0585e4a077584cccd18b13ef602c18aa9ed2ef10d";

/** The first Docker Engine whose bridge driver takes `gateway_mode_ipv4=isolated`. */
const ISOLATED_GATEWAY_ENGINE = 28;

/** The words setup prints after "Observed: " when it offers Docker alone. */
const DOCKER_ONLY = "offering docker runtime (shared Linux kernel; no per-workspace VM isolation)";

/** What setup observed about running host-vm on this server's Docker host. */
export type HostVmObservation =
  | { readonly _tag: "passed"; readonly backend?: "cloud-hypervisor" | "mac-vmd" }
  /** `observed`: what stopped it, as setup says it after "Observed: ". */
  | { readonly _tag: "unavailable"; readonly observed: string };

/** The line setup prints for an observation it chose runtimes by. */
export const hostVmChoiceLine = (observation: HostVmObservation): string =>
  observation._tag === "passed"
    ? observation.backend === "mac-vmd"
      ? "Observed: Apple Silicon macOS Virtualization.framework and Docker passed the host-vm self-test — offering host-vm (a virtual machine of its own per workspace) and docker; new organizations start on host-vm"
      : "Observed: this server's KVM passed the vm-runner self-test — offering host-vm (a virtual machine of its own per workspace) and docker; new organizations start on host-vm"
    : `Observed: ${observation.observed} — ${DOCKER_ONLY}`;

/**
 * The runtimes setup offers by itself on an observation. Docker alone is saved as the one runtime,
 * with no offered list, as a Docker install always was: `--session-runtime boat` still moves it to
 * Boat without naming the list.
 */
export const hostVmChoice = (
  observation: HostVmObservation,
): {
  readonly sessionRuntime: SessionRuntime;
  readonly sessionRuntimes?: ReadonlyArray<SessionRuntime>;
} =>
  observation._tag === "passed"
    ? { sessionRuntime: "host-vm", sessionRuntimes: ["host-vm", "docker"] }
    : { sessionRuntime: "docker" };

interface ProbeOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** What the probes need of setup's runtime. */
export interface HostVmProbeRuntime {
  readonly platform: NodeJS.Platform;
  /** CPU architecture on macOS (`arm64` required for native Virtualization.framework). */
  readonly arch?: string;
  /** Darwin release (`os.release()`) on macOS. */
  readonly osRelease?: string;
  /** Numeric user id for `gui/<uid>` launchd checks on macOS. */
  readonly uid?: number;
  /** Whether /dev/kvm is on this machine; absent, setup never looks (`ServerSetupRuntime`). */
  readonly kvmDevice?: () => boolean;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ServerProcessOptions,
  ) => Promise<ProbeOutput>;
  randomBytes(size: number): Buffer;
}

/** The Docker host setup drives: its context, and the endpoint that says whether it is this machine. */
export interface HostVmDockerHost {
  readonly context: string;
  readonly endpoint: string;
  /** `--offline`: the vm-runner image is not pulled; missing, the self-test fails. */
  readonly offline: boolean;
}

/** One line of what a command said: stderr, else its error, else its exit status. */
const detailOf = (output: ProbeOutput): string =>
  (output.stderr.trim() || output.error || `exit ${output.status ?? "unknown"}`).replace(
    /\s+/g,
    " ",
  );

const SelfTestCheck = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  observed: Schema.String,
});

/** The one JSON line `vm-runner --self-test` prints, whether it passed (exit 0) or not (exit 1). */
const SelfTestReport = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Boolean,
  checks: Schema.Array(SelfTestCheck),
});

const decodeSelfTestReport = Schema.decodeUnknownOption(Schema.fromJsonString(SelfTestReport));

/**
 * What the self-test's output says: null when it passed, else what failed. A report that does not
 * decode, or an exit status that disagrees with it, is a failure in its own words.
 */
export const selfTestFailure = (output: ProbeOutput): string | null => {
  const line =
    output.stdout
      .trim()
      .split("\n")
      .map((each) => each.trim())
      .findLast((each) => each !== "") ?? "";
  const report = decodeSelfTestReport(line);
  if (Option.isNone(report))
    // Docker refuses `--device /dev/kvm` before the container starts on a host without it.
    return /\/dev\/kvm/.test(output.stderr)
      ? `/dev/kvm unavailable (${detailOf(output)})`
      : `the vm-runner self-test printed no report (${detailOf(output)})`;
  const failed = report.value.checks.filter((check) => !check.ok);
  if (report.value.ok && failed.length === 0 && output.status === 0) return null;
  return failed.length === 0
    ? `the vm-runner self-test failed (${detailOf(output)})`
    : failed.map((check) => `${check.name}: ${check.observed}`).join("; ");
};

/** The leading major version of a Docker Engine version (`29.1.3`, `28.0.0-rc.1`), or null. */
const engineMajor = (version: string): number | null => {
  const match = /^(\d+)\./.exec(version.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
};

/**
 * Whether Docker can give a workspace network an isolated gateway (`gateway_mode_ipv4=isolated`),
 * which host-vm's networks need and the self-test does not check: an internal network created
 * with it, and removed again whatever happened. Null when it can; else what stopped it.
 */
const isolatedGatewayFailure = async (
  runtime: HostVmProbeRuntime,
  context: string,
): Promise<string | null> => {
  const version = await runtime.run("docker", [
    "--context",
    context,
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const engine = version.stdout.trim();
  const major = version.status === 0 ? engineMajor(engine) : null;
  if (major === null)
    return `Docker did not say its Engine version (${version.status === 0 ? `"${engine}"` : detailOf(version)})`;
  if (major < ISOLATED_GATEWAY_ENGINE)
    return `Docker Engine ${engine} cannot isolate a network's gateway (gateway_mode_ipv4=isolated needs Docker Engine ${ISOLATED_GATEWAY_ENGINE} or later)`;
  const name = `mend-setup-isolation-check-${runtime.randomBytes(4).toString("hex")}`;
  const created = await runtime.run("docker", [
    "--context",
    context,
    "network",
    "create",
    "--internal",
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    name,
  ]);
  // Removed even when create failed: a create that timed out may still have made it.
  await runtime.run("docker", ["--context", context, "network", "rm", name]);
  return created.status === 0
    ? null
    : `Docker could not create a network with an isolated gateway (gateway_mode_ipv4=isolated): ${detailOf(created)}`;
};

/**
 * Whether this server's Docker host can run host-vm:
 * - On Linux: `/dev/kvm`, `vm-runner --self-test` (KVM, TUN, nftables, Landlock, Cloud Hypervisor),
 *   and Docker `gateway_mode_ipv4=isolated`.
 * - On Apple Silicon macOS (when `runtime.arch` is supplied): macOS >= 14, local Docker context,
 *   active `gui/<uid>` launchd domain, `vm-runner --self-test --vmm-backend mac-vmd` (TUN +
 *   nftables, no `/dev/kvm`), and Docker `gateway_mode_ipv4=isolated`.
 */
export const observeHostVm = async (
  runtime: HostVmProbeRuntime,
  host: HostVmDockerHost,
): Promise<HostVmObservation> => {
  if (runtime.platform === "darwin" && runtime.arch !== undefined) {
    const eligibility = await macHostEligibilityFailure(
      {
        platform: runtime.platform,
        arch: runtime.arch,
        ...(runtime.osRelease === undefined ? {} : { osRelease: runtime.osRelease }),
        ...(runtime.uid === undefined ? {} : { uid: runtime.uid }),
        configDir: "",
        run: runtime.run,
        fetchText: async () => ({ status: 0, body: "", error: "unused" }),
        randomBytes: (size) => runtime.randomBytes(size),
        sleep: async () => undefined,
        writeLine: () => undefined,
      },
      host.endpoint,
    );
    if (eligibility !== null) return { _tag: "unavailable", observed: eligibility };
    const selfTest = await runtime.run(
      "docker",
      [
        "--context",
        host.context,
        "run",
        "--rm",
        ...(host.offline ? ["--pull", "never"] : []),
        "--device",
        "/dev/net/tun",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETPCAP",
        "--security-opt",
        "no-new-privileges:true",
        VM_RUNNER_IMAGE,
        "--vmm-backend",
        "mac-vmd",
        "--self-test",
      ],
      { timeoutMs: serverProcessDeadlines.pull },
    );
    const failed = selfTestFailure(selfTest);
    if (failed !== null) return { _tag: "unavailable", observed: failed };
    const gateway = await isolatedGatewayFailure(runtime, host.context);
    return gateway === null
      ? { _tag: "passed", backend: "mac-vmd" }
      : { _tag: "unavailable", observed: gateway };
  }
  const local = host.endpoint.startsWith("unix://");
  if (runtime.platform !== "linux" || (local && runtime.kvmDevice?.() !== true))
    return { _tag: "unavailable", observed: "/dev/kvm unavailable" };
  const selfTest = await runtime.run(
    "docker",
    [
      "--context",
      host.context,
      "run",
      "--rm",
      ...(host.offline ? ["--pull", "never"] : []),
      "--device",
      "/dev/kvm",
      "--device",
      "/dev/net/tun",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETPCAP",
      "--security-opt",
      "no-new-privileges:true",
      VM_RUNNER_IMAGE,
      "--self-test",
    ],
    // The first run pulls the vm-runner image.
    { timeoutMs: serverProcessDeadlines.pull },
  );
  const failed = selfTestFailure(selfTest);
  if (failed !== null) return { _tag: "unavailable", observed: failed };
  const gateway = await isolatedGatewayFailure(runtime, host.context);
  return gateway === null
    ? { _tag: "passed", backend: "cloud-hypervisor" }
    : { _tag: "unavailable", observed: gateway };
};

// ─── whether the VM disks share a filesystem with the server's data ──────────

/** The volume each workspace VM's data disk lives in, as compose.host-vm.yaml names it. */
export const VM_DATA_VOLUME = "mend-vm-data";

/** The steps that move it to a filesystem of its own, before setup or after Compose made it. */
const VM_DISKS_APART_DOCS =
  "https://docs.mend.run/reference/server-environment/#keep-vm-disks-apart-from-the-servers-data";

/** Where a volume's bytes are on the Docker host, or why setup cannot say. */
type Backing =
  | { readonly _tag: "path"; readonly path: string }
  /** A filesystem of its own (a local volume with `type` other than a bind, such as nfs or tmpfs). */
  | { readonly _tag: "own"; readonly what: string }
  | { readonly _tag: "unknown"; readonly why: string };

const VolumeInspect = Schema.Struct({
  Driver: Schema.String,
  Mountpoint: Schema.String,
  Options: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});

/** The three fields setup reads of a volume, as one JSON object. */
const VOLUME_FORMAT =
  '{"Driver":{{json .Driver}},"Mountpoint":{{json .Mountpoint}},"Options":{{json .Options}}}';

const decodeVolumeInspect = Schema.decodeUnknownOption(Schema.fromJsonString(VolumeInspect));

const backingOf = async (
  runtime: HostVmProbeRuntime,
  context: string,
  volume: string,
  volumesRoot: () => Promise<Backing>,
): Promise<Backing> => {
  const inspected = await runtime.run("docker", [
    "--context",
    context,
    "volume",
    "inspect",
    "--format",
    VOLUME_FORMAT,
    volume,
  ]);
  // Not created yet (Compose creates the VM volumes on its first up): Docker's own volume root.
  if (inspected.status !== 0)
    return /no such volume/i.test(inspected.stderr)
      ? volumesRoot()
      : { _tag: "unknown", why: `docker volume inspect ${volume}: ${detailOf(inspected)}` };
  const decoded = decodeVolumeInspect(inspected.stdout.trim());
  if (Option.isNone(decoded))
    return { _tag: "unknown", why: `docker volume inspect ${volume} printed no volume` };
  const { Driver, Mountpoint, Options } = decoded.value;
  if (Driver !== "local")
    return { _tag: "unknown", why: `${volume} uses the ${Driver} volume driver` };
  const device = Options?.["device"];
  const type = Options?.["type"];
  if (device !== undefined && device !== "") {
    if (Options?.["o"]?.split(",").includes("bind") === true) return { _tag: "path", path: device };
    if (type !== undefined && type !== "" && type !== "none")
      return { _tag: "own", what: `${type} ${device}` };
  }
  return Mountpoint === ""
    ? { _tag: "unknown", why: `${volume} has no mountpoint` }
    : { _tag: "path", path: Mountpoint };
};

/**
 * What setup says about where VM data disks sit (spec §5.4): a warning when the VM data volume
 * would share one filesystem with Postgres's or Garage's volume, since a workspace VM that fills
 * its disk would leave them without space; a plain line when it could not check; nothing when they
 * are apart. Never a refusal. `others` are the server's data volumes by their Docker names, each
 * with what it holds as the warning names it ("Postgres").
 * `helperImage` is a small image with busybox's `stat` that every install has (HOST_HELPER_IMAGE).
 */
export const sharedFilesystemLines = async (
  runtime: HostVmProbeRuntime,
  context: string,
  others: ReadonlyArray<{ readonly volume: string; readonly holds: string }>,
  helperImage: string,
): Promise<ReadonlyArray<string>> => {
  let root: Promise<Backing> | undefined;
  const volumesRoot = (): Promise<Backing> => {
    root ??= runtime
      .run("docker", ["--context", context, "info", "--format", "{{.DockerRootDir}}"])
      .then((info) =>
        info.status === 0 && info.stdout.trim().startsWith("/")
          ? { _tag: "path", path: `${info.stdout.trim().replace(/\/+$/, "")}/volumes` }
          : { _tag: "unknown", why: `Docker did not say its data root (${detailOf(info)})` },
      );
    return root;
  };
  const cannot = (why: string): ReadonlyArray<string> => [
    `Could not check whether ${VM_DATA_VOLUME} shares a filesystem with the server's data: ${why}.`,
  ];
  const volumes = [VM_DATA_VOLUME, ...others.map((other) => other.volume)];
  const backings: Array<Backing> = [];
  for (const volume of volumes)
    backings.push(await backingOf(runtime, context, volume, volumesRoot));
  const unknown = backings.find((backing) => backing._tag === "unknown");
  if (unknown !== undefined) return cannot(unknown.why);
  const paths = backings.flatMap((backing) => (backing._tag === "path" ? [backing.path] : []));
  const stat = await runtime.run("docker", [
    "--context",
    context,
    "run",
    "--rm",
    "--network",
    "none",
    ...paths.flatMap((each, index) => ["--volume", `${each}:/mend-fs/${index}:ro`]),
    "--entrypoint",
    "stat",
    helperImage,
    "-c",
    "%d",
    ...paths.map((_, index) => `/mend-fs/${index}`),
  ]);
  const devices = stat.stdout
    .trim()
    .split("\n")
    .map((each) => each.trim());
  if (
    stat.status !== 0 ||
    devices.length !== paths.length ||
    !devices.every((d) => /^\d+$/.test(d))
  )
    return cannot(`stat on the Docker host failed (${detailOf(stat)})`);
  // Each volume's filesystem: its device number, or a filesystem of its own.
  let next = 0;
  const filesystems = backings.map((backing) =>
    backing._tag === "own" ? `own:${backing.what}` : `dev:${devices[next++] ?? ""}`,
  );
  const [vmData] = filesystems;
  const sharing = others.filter((_, index) => filesystems[index + 1] === vmData);
  const [first, ...rest] = sharing;
  if (first === undefined) return [];
  return [
    `Warning: ${VM_DATA_VOLUME} shares one filesystem with ${first.volume}${rest.length === 0 ? "" : ` (and ${rest.map((other) => other.volume).join(", ")})`}. A workspace VM that fills its disk can leave ${sharing.map((other) => other.holds).join(" and ")} without space. To move ${VM_DATA_VOLUME} to a filesystem of its own: ${VM_DISKS_APART_DOCS}`,
  ];
};
