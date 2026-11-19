/**
 * Mend's command line, as setup and Settings introduce it once per page: install it on your own
 * computer and sign it in to this server, or, once the server has seen a computer signed in, one
 * line naming it. Pure, so the states are testable without a server.
 *
 * `mend login --url` adds a device with the platform `cli` when the command line collects its
 * approval; the server then sends the `user` event (facet `devices`), so an open page reads the
 * list again and moves on without a reload.
 */

/** The command that installs Mend's command line, as the README gives it. */
export const INSTALL_COMMAND = "npm install --global @sealant/mend";

/** A device as `devices.list` answers it. */
export interface DeviceRow {
  readonly name: string;
  readonly platform: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** What the block shows. */
export type CommandLineState =
  /** No computer's command line is signed in to this server for the person: install and sign in. */
  | { readonly kind: "waiting" }
  /** One or more are: the most recently used one by name, and how many others. */
  | { readonly kind: "signed-in"; readonly computer: string; readonly others: number };

const usedAt = (device: DeviceRow): number => Date.parse(device.lastUsedAt ?? device.createdAt);

/**
 * Whether a computer's command line is signed in, from the person's devices. Phones, the desktop
 * app and tokens made by hand don't run `mend` commands, so only `cli` devices count. The server's
 * list leaves out revoked ones.
 */
export const commandLineState = (devices: ReadonlyArray<DeviceRow>): CommandLineState => {
  const computers = devices
    .filter((device) => device.platform === "cli")
    .toSorted((a, b) => usedAt(b) - usedAt(a));
  const [latest] = computers;
  if (latest === undefined) return { kind: "waiting" };
  return { kind: "signed-in", computer: latest.name, others: computers.length - 1 };
};

/** The one ticked line once a computer is signed in. */
export const signedInLine = (state: Extract<CommandLineState, { kind: "signed-in" }>): string =>
  state.others === 0
    ? `Mend's command line is signed in on ${state.computer}.`
    : `Mend's command line is signed in on ${state.computer} and ${state.others} more.`;
