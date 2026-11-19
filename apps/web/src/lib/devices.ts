/**
 * What Settings → Devices and access keys says about a person's devices, access keys and
 * workspace SSH keys. Pure, so each line is testable without a server.
 */

/** "ABCDEFGH" → "ABCD-EFGH", the shape a pairing code is read aloud in. */
export const groupCode = (code: string): string =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/** What the QR encodes: the phone opens it; nothing else reads it. */
export const pairingPayload = (baseUrl: string, code: string): string =>
  `mend://pair?u=${encodeURIComponent(baseUrl)}&c=${code}`;

/** What kind of device a platform is, as the list's second line says it. */
export const platformLabel = (platform: string): string => {
  switch (platform) {
    case "ios":
    case "android":
      return "Mend app";
    case "cli":
      return "mend CLI";
    case "desktop":
      return "Mend desktop app";
    case "web":
      return "Browser";
    case "other":
      return "Token made by hand";
    default:
      return platform;
  }
};

const DAY = 86_400_000;

/** "9 Nov", or "9 Nov 2025" when it isn't this year. */
export const shortDay = (iso: string, now: Date): string => {
  const date = new Date(iso);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
};

/** "Now", "5 minutes ago", "3 days ago", or `never` for something not used yet. */
export const lastUsed = (iso: string | null, now: Date, never: string): string => {
  if (iso === null) return never;
  const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "Now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

/** How long a new access key works for, as Settings offers it (ADR 0023, decision 5). */
export type Expiry = "30" | "90" | "365" | "never";

export const EXPIRY_OPTIONS: ReadonlyArray<{ readonly value: Expiry; readonly label: string }> = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

/** The days the server is asked for; null is no expiry. */
export const expiryDays = (expiry: Expiry): number | null =>
  expiry === "never" ? null : Number(expiry);

/** "This key expires on 12 February." for the create dialog. */
export const expiryLine = (expiry: Expiry, now: Date): string => {
  const days = expiryDays(expiry);
  if (days === null) return "This key never expires. Revoke it here when you no longer need it.";
  const day = new Date(now.getTime() + days * DAY);
  return `This key expires on ${longDay(day, now)}.`;
};

const longDay = (date: Date, now: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

/** The Expires column: a day, Never, or Expired for a key past its day. */
export const expiresCell = (iso: string | null, now: Date): string => {
  if (iso === null) return "Never";
  const at = new Date(iso);
  if (at.getTime() <= now.getTime()) return "Expired";
  return shortDay(iso, now);
};

/** The line under a key just shown: when it expires, or that it doesn't. */
export const shownKeyLine = (iso: string | null, now: Date): string =>
  iso === null
    ? "It never expires. You can revoke it on this page at any time."
    : `It expires on ${longDay(new Date(iso), now)}. You can revoke it on this page at any time.`;

/** What removing a workspace SSH key did to the connections already open with it. */
export const removalLine = (removed: {
  readonly name: string;
  readonly openConnections: "end" | "stay";
  readonly runningSessions: ReadonlyArray<unknown>;
}): string =>
  removed.openConnections === "end"
    ? `Removed ${removed.name}. Your workspaces refuse it from the next connection, and connections already open with it end within a minute.`
    : `Removed ${removed.name}. Your workspaces refuse it from the next connection. Connections already open with it stay open until your running sessions stop${removed.runningSessions.length === 0 ? "; none of yours is running" : ""}.`;
