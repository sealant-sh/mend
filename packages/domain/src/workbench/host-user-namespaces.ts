/**
 * Whether a Docker host's kernel lets an unprivileged process create a user namespace.
 *
 * Every workspace's Docker service is a rootless Docker daemon (Core's `docker:*-dind-rootless`),
 * and rootlesskit starts it as an unprivileged user that creates a user namespace. Two kernel
 * settings refuse that, and the daemon then exits with "fork/exec /proc/self/exe: operation not
 * permitted" before the workspace can start:
 *
 * - `kernel.apparmor_restrict_unprivileged_userns=1`, Ubuntu's default since 23.10 (24.04 LTS
 *   included). It applies only while AppArmor is enabled.
 * - `kernel.unprivileged_userns_clone=0`, Debian's switch (on by default since Debian 11).
 *
 * The readings are the files' contents (`/proc/sys/kernel/…`, `/sys/module/apparmor/parameters/
 * enabled`), null where a file is absent or unreadable. A container reads its host's kernel there,
 * so the same readings work from the host or from any container on it.
 */
export interface HostUserNamespaceReadings {
  readonly apparmorRestrictUnprivilegedUserns: string | null;
  readonly apparmorEnabled: string | null;
  readonly unprivilegedUsernsClone: string | null;
}

export type HostUserNamespaces =
  | { readonly allowed: true }
  /** `setting` is the line that allows them, as `sysctl` and `/etc/sysctl.d` take it. */
  | { readonly allowed: false; readonly setting: string };

/** The files a reading comes from, in `HostUserNamespaceReadings` order. */
export const HOST_USER_NAMESPACE_FILES = [
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  "/sys/module/apparmor/parameters/enabled",
  "/proc/sys/kernel/unprivileged_userns_clone",
] as const;

/** Where the setting goes on a host, so it holds across a restart. */
export const HOST_USER_NAMESPACE_SYSCTL_FILE = "/etc/sysctl.d/60-mend-rootless-docker.conf";

export const hostUserNamespacesOf = (readings: HostUserNamespaceReadings): HostUserNamespaces => {
  const restrict = readings.apparmorRestrictUnprivilegedUserns?.trim();
  // AppArmor reports `Y` when it is enabled; a host booted with it off does not apply the switch.
  const apparmorOff = readings.apparmorEnabled?.trim() === "N";
  if (restrict === "1" && !apparmorOff) {
    return { allowed: false, setting: "kernel.apparmor_restrict_unprivileged_userns = 0" };
  }
  if (readings.unprivilegedUsernsClone?.trim() === "0") {
    return { allowed: false, setting: "kernel.unprivileged_userns_clone = 1" };
  }
  return { allowed: true };
};

/** The command that allows them on the host, now and after a restart. */
export const hostUserNamespacesFix = (setting: string): string =>
  `echo '${setting}' | sudo tee ${HOST_USER_NAMESPACE_SYSCTL_FILE} && sudo sysctl --system`;
