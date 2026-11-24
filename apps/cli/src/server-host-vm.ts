import type { SessionRuntime } from "@mend/domain";

/**
 * The host VM runtime's disks. `compose.host-vm.yaml` maps two more roots in
 * SEALANT_DOCKER_VOLUME_MAPPINGS (base disks and each VM's data disk) and mounts their volumes. A
 * generation carries it only when the saved config names host-vm among its session runtimes:
 * every other install sends the two mappings it always sent, which a released Mend image checks.
 * Setup never offers host-vm yet; a config set to it another way gets the overlay.
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
}): string | undefined => (namesHostVm(settings) ? HOST_VM_COMPOSE_OVERLAY : undefined);
