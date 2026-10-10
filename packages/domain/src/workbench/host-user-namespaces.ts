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

/** What a refusing host means for Mend, in the words doctor, a failed launch and the web share. */
export const HOST_USER_NAMESPACES_REFUSED =
  "the server's host refuses user namespaces · no workspace can start";

/** What leads the fix wherever it is written out: the command runs on the host, not here. */
export const HOST_USER_NAMESPACES_FIX_LEAD = "on the server's host: ";

/** Where to apply the fix, then the command: doctor's fix column. */
export const hostUserNamespacesFixLine = (setting: string): string =>
  `${HOST_USER_NAMESPACES_FIX_LEAD}${hostUserNamespacesFix(setting)}`;

/**
 * The whole refusal as one line: what a launch on a refusing host fails with, before it builds an
 * image or creates a workspace (`launch failed: <this>`).
 */
export const hostUserNamespacesRefusal = (setting: string): string =>
  `${HOST_USER_NAMESPACES_REFUSED} · ${hostUserNamespacesFixLine(setting)}`;

/**
 * A line that carries the refusal, split around its command so a reader can set the command
 * apart: the words up to and including the lead, the command, and anything after it (a session
 * line may carry ` · saved at …`). Null for any other line.
 */
export const hostUserNamespacesRefusalParts = (
  line: string,
): { readonly lead: string; readonly command: string; readonly rest: string } | null => {
  if (!line.includes(HOST_USER_NAMESPACES_REFUSED)) return null;
  const at = line.indexOf(HOST_USER_NAMESPACES_FIX_LEAD);
  if (at === -1) return null;
  const start = at + HOST_USER_NAMESPACES_FIX_LEAD.length;
  // The command ends at `sudo sysctl --system`; a session line may go on after it.
  const end = line.indexOf(" · ", start);
  return {
    lead: line.slice(0, start),
    command: end === -1 ? line.slice(start) : line.slice(start, end),
    rest: end === -1 ? "" : line.slice(end),
  };
};
