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
 * Where to walk after signing in. Keep a same-origin root-relative path unchanged;
 * full URLs, authority prefixes and invalid URLs fall back to the workbench.
 */
export const safeNextPath = (value: unknown): string => {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  // URL parsing removes tabs and newlines and treats backslashes as slashes in HTTP URLs.
  // Refuse authority prefixes even when their host matches the validation origin below.
  if (/^\/[\t\r\n]*[\\/]/.test(value)) return "/";
  try {
    const origin = "https://mend.invalid";
    return new URL(value, origin).origin === origin ? value : "/";
  } catch {
    return "/";
  }
};

export const continuationOf = (location: {
  readonly search: string;
  readonly hash: string;
}): string => {
  const walked = new URLSearchParams(location.hash.replace(/^#/, "")).get("next");
  const sentByTheApi = new URLSearchParams(location.search).get("next");
  return safeNextPath(walked ?? sentByTheApi);
};

export const withContinuation = (page: "/login" | "/welcome", next: string): string =>
  next === "/" ? page : `${page}#${new URLSearchParams({ next }).toString()}`;

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
