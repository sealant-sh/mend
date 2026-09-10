/**
 * The pure parts of first contact: which form the login page leads with,
 * what a password must satisfy before the server sees it, and how the
 * first-run checklist tells CLI sign-ins from paired phones (one table, two
 * meanings). Kept free of React so they are testable as plain functions.
 */

export type LoginMode = "sign-in" | "sign-up";

/** better-auth's own floor; checking it here names the problem before a round trip. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Where to walk after signing in. Only a same-origin path is honoured —
 * anything else (a full URL, a protocol-relative `//host`) falls back to the
 * workbench, so a crafted login link cannot walk a user off this instance.
 */
export const safeNextPath = (value: unknown): string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

/** A fresh instance opens on registration; one with accounts opens on sign-in. */
export const defaultLoginMode = (
  instance: { readonly users: "none" | "some" } | undefined,
): LoginMode => (instance?.users === "none" ? "sign-up" : "sign-in");

/** The one reason a password pair cannot be submitted yet, or null when it can. */
export const passwordProblem = (password: string, confirm: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `At least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (confirm !== password) return "The two passwords differ.";
  return null;
};

/** The three steps of first contact, as the setup pages show them. */
export const SETUP_STEPS = ["Account", "Git access", "First run"] as const;

/**
 * Device tokens are one table: `mend login` mints one with platform `cli`,
 * `mend pair` and the phone mint the rest. The checklist reads them apart.
 */
export const splitDevices = <D extends { readonly platform: string }>(
  devices: ReadonlyArray<D>,
): { readonly machines: ReadonlyArray<D>; readonly paired: ReadonlyArray<D> } => ({
  machines: devices.filter((device) => device.platform === "cli"),
  paired: devices.filter((device) => device.platform !== "cli"),
});
