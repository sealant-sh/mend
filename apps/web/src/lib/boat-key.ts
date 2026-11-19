import {
  boatKeyCreateCommand,
  type BoatKeyReport,
  boatKeyWarnings,
  type BoatKeyWarning,
  expiryState,
} from "@mend/domain/workbench";

/**
 * Settings → the organization → Boat (docs/adr/0025: the organization's Boat key, and the
 * organization always pays): what the page says, from what the server answers. What it says about
 * a key's report beyond these lines comes from `boatKeyFacts` and `boatKeyWarnings` in
 * `@mend/domain/workbench`, which `mend boat` prints too. No part of the key is ever shown.
 */

const DAY_MS = 86_400_000;

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** `2 Sep`, with the year when it isn't this year's. */
const dayOf = (at: Date, now: Date): string =>
  at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

/** `today`, or `on 2 Sep`. */
export const onDay = (at: Date, now: Date): string =>
  sameDay(at, now) ? "today" : `on ${dayOf(at, now)}`;

/** `just now`, `5 minutes ago`, `2 hours ago`, `on 2 Sep`. */
export const ago = (at: Date, now: Date): string => {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && now.getTime() - at.getTime() < DAY_MS) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  return onDay(at, now);
};

/** The page's intro under its title. */
export const boatIntro = (organization: string): string =>
  `${organization} pays for every Boat workspace with this key, whoever starts the session. Only owners can change it.`;

/** What a member reads in place of the key's details: whether there is one. */
export const memberKeyLine = (connected: boolean, organization: string): string =>
  connected
    ? `${organization} has its own Boat key, so its Boat sessions run in, and are billed to, its own Boat account. Only an owner sees the key's details or changes it.`
    : `${organization} has no Boat key, so its Boat sessions use the server's own key, if the server has one. An owner can connect one here.`;

/** An owner's line when no key is connected. */
export const noKeyLine = (organization: string): string =>
  `No key connected. ${organization}'s Boat sessions use the server's own Boat key, if it has one, and are refused if it has none.`;

/** Who added the key and when, when it was replaced, and when it expires, if Boat said. */
export const keyLine = (
  details: {
    readonly connectedByName: string | null;
    readonly connectedAt: Date;
    readonly keyReplacedAt: Date | null;
  },
  report: BoatKeyReport | null,
  now: Date,
): string => {
  const who = details.connectedByName ?? "A removed account";
  const added =
    details.keyReplacedAt === null
      ? `${who} added it ${onDay(details.connectedAt, now)}`
      : `${who} added it ${onDay(details.connectedAt, now)}, and it was replaced ${onDay(details.keyReplacedAt, now)}`;
  if (report === null || !report.expiry.observed) return `${added}.`;
  const state = expiryState(report.expiry, now);
  switch (state.kind) {
    case "never":
      return `${added}. It doesn't expire.`;
    case "later":
    case "soon":
      return `${added}, and it expires on ${dayOf(state.at, now)}.`;
    case "expired":
      return state.at === null
        ? `${added}. It has expired.`
        : `${added}. It expired on ${dayOf(state.at, now)}.`;
  }
};

/** The banner over the page while the key expires within two weeks, or has expired. */
export const expiryBanner = (
  report: BoatKeyReport | null,
  now: Date,
  organization: string,
): { readonly title: string; readonly body: string; readonly tone: "warning" | "error" } | null => {
  if (report === null || !report.expiry.observed) return null;
  const state = expiryState(report.expiry, now);
  switch (state.kind) {
    case "never":
    case "later":
      return null;
    case "soon":
      return {
        tone: "warning",
        title: `${organization}'s Boat key expires on ${dayOf(state.at, now)}.`,
        body: "After that, Boat sessions that use it won't start. Replace it before then.",
      };
    case "expired":
      return {
        tone: "error",
        title:
          state.at === null
            ? `${organization}'s Boat key has expired.`
            : `${organization}'s Boat key expired on ${dayOf(state.at, now)}.`,
        body: "Boat sessions that use it can't start. Replace it with a new key.",
      };
  }
};

/** Where the page sends an owner to make a new key. */
export const REPLACE_ON_PAGE = "Create a new key in Boat, then use Replace key.";

/**
 * What needs an owner, as sentences, under the key's rows. Expiry is left out: the banner over the
 * page says it.
 */
export const keyWarnings = (report: BoatKeyReport, now: Date): ReadonlyArray<BoatKeyWarning> =>
  boatKeyWarnings(report, now, REPLACE_ON_PAGE, "other").filter(
    (warning) => !warning.text.startsWith("This Boat key expire"),
  );

/** The Last check row's line: what Boat last answered about the key, and when. */
export const lastCheckLine = (report: BoatKeyReport | null, now: Date): string => {
  if (report === null) {
    return "Not checked yet. Check now asks Boat who the key is, the wallet it bills, whether it can start a VM and when it expires.";
  }
  const when = ago(report.observedAt, now);
  const { identity } = report;
  if (!identity.observed) return `Boat answered ${when}, but didn't say whose key it is.`;
  const status =
    identity.accountStatus === "unknown" ? "" : ` The account is ${identity.accountStatus}.`;
  return `Boat accepted the key ${when}.${status}`;
};

/** What a check found when the key is no longer active in Sealant. */
export const CHECK_STATE_LINES: Readonly<
  Record<"removing" | "missing" | "none", { readonly title: string; readonly body: string }>
> = {
  removing: {
    title: "Sealant is removing this Boat account.",
    body: "No new session runs in it. Connect a key again once the removal is done.",
  },
  missing: {
    title: "Sealant no longer lists this Boat account.",
    body: "Remove the key, then connect it again.",
  },
  none: {
    title: "Another owner removed the key.",
    body: "Connect a key to run Boat sessions in the organization's own Boat account.",
  },
};

/** What removing the key does, in the order it happens. */
export const REMOVAL_FACTS: ReadonlyArray<string> = [
  "Mend first stops the standby workspaces it keeps in this Boat account, without saving anything, since they hold no session's work. It refuses while a session's VM or an image build still uses the account: stop those sessions first.",
  "Sealant deletes the saved images it made in this Boat account, which frees their snapshot slots.",
  "New Boat sessions use the server's own Boat key, if it has one; otherwise they are refused.",
];

/** Where Boat is used: the organization's runtime, set on the Runtime page. */
export const runtimeLine = (
  runtime: "boat" | "docker" | null,
  organization: string,
): { readonly lead: string; readonly rest: string } => {
  switch (runtime) {
    case "boat":
      return {
        lead: `Sessions run on Boat when ${organization}'s runtime is Boat, as it is now.`,
        rest: "You choose the runtime on the Runtime page.",
      };
    case "docker":
      return {
        lead: `${organization}'s sessions run on Docker now, so none uses this key until the runtime is Boat.`,
        rest: "You choose the runtime on the Runtime page.",
      };
    case null:
      return {
        lead: `Sealant picks where ${organization}'s sessions run, so this key is used only for the ones it runs on Boat.`,
        rest: "You choose the runtime on the Runtime page.",
      };
  }
};

/** The command that creates a suitable key, for a Boat organization and for a personal account. */
export const BOAT_KEY_COMMANDS = [
  {
    key: "organization",
    caption: "For a Boat organization",
    command: boatKeyCreateCommand("<your-boat-organization>"),
  },
  { key: "personal", caption: "For a personal account", command: boatKeyCreateCommand(null) },
] as const;
