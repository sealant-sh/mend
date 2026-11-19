import type { StatusTone } from "@mend/ui/components/status";

import { ago } from "./boat-key.ts";

/**
 * What Settings → Server says about the server its operators run (docs/adr/0025: the Server's home
 * is read-only in the app, changed with `mend server setup` or Helm). Every sentence says what the
 * operator declared or what the server observed, never a verdict (docs/adr/0004).
 */

/** A status word and its tone, as the kit's `Status` draws it. */
export interface Said {
  readonly word: string;
  readonly tone: StatusTone;
}

// ---------------------------------------------------------------------------------------------
// Address and exposure

export type Declared = "loopback" | "private" | "public";
export type Established = "observed" | "carried" | "declared" | "open";

export interface ExposureItemFacts {
  readonly established: Established;
  readonly blocksStart: boolean;
}

/** What `MEND_EXPOSURE` says, as the Exposure row reads it, with what it means beneath. */
export const DECLARED_WORDS: Readonly<
  Record<Declared, { readonly word: string; readonly means: string }>
> = {
  loopback: { word: "This machine only", means: "Only this machine reaches Mend." },
  private: { word: "Private network", means: "You control who can join the network." },
  public: { word: "Public", means: "Anyone on the Internet can reach the address." },
};

/**
 * An item's result: observed in effect ("Checked"), carried by this build where the server can't
 * see it in effect, stated by the operator, or none of those ("Open", the one amber word).
 */
export const exposureResult = (item: ExposureItemFacts): Said => {
  switch (item.established) {
    case "observed":
      return { word: "Checked", tone: "idle" };
    case "carried":
      return { word: "In this build", tone: "idle" };
    case "declared":
      return { word: "Declared", tone: "idle" };
    case "open":
      return { word: "Open", tone: "wait" };
  }
};

/** Whether an open item stops the server starting with `MEND_EXPOSURE=public`. */
export const refusesPublicStart = (item: ExposureItemFacts): boolean =>
  item.established === "open" && item.blocksStart;

const countWord = (count: number, one: string, many: string): string =>
  count === 1 ? `One ${one}` : `${count} ${many}`;

/** "on 13 Nov at 10:46", or "today at 10:46". */
export const whenChecked = (at: Date, now: Date): string => {
  const clock = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (at.toDateString() === now.toDateString()) return `today at ${clock}`;
  const day = at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `on ${day} at ${clock}`;
};

/**
 * The line under "Address and exposure": when Mend read the report, and what the open items mean
 * for a public start. A server running `public` has none that refuse it, or it wouldn't be running.
 */
export const exposureSummary = (
  items: ReadonlyArray<ExposureItemFacts>,
  checkedAt: Date,
  now: Date,
): string => {
  const checked = `Mend checked this server ${whenChecked(checkedAt, now)}.`;
  const open = items.filter((item) => item.established === "open").length;
  const refusing = items.filter(refusesPublicStart).length;
  if (open === 0) return `${checked} Nothing is open.`;
  const opened = `${countWord(open, "item is", "items are")} open`;
  if (refusing === 0) return `${checked} ${opened}, and none of them stops a public start.`;
  return `${checked} ${opened}, so Mend would refuse to start in public.`;
};

export interface ObservedAddress {
  readonly originScheme: "http" | "https";
  readonly originOnMachine: boolean;
  readonly arrivedVia: "direct" | "trusted-proxy";
  readonly addressKinds: ReadonlyArray<string>;
}

/**
 * What the server observed about its own address: the scheme of `APP_URL`, whether it names this
 * machine, how this request reached it. The address itself isn't in any answer the server gives.
 */
export const addressLine = (address: ObservedAddress): string =>
  [
    address.originScheme,
    address.originOnMachine ? "on this machine's loopback" : "not on this machine's loopback",
    address.arrivedVia === "trusted-proxy" ? "reached through a trusted proxy" : "reached directly",
  ].join(", ");

/** The kinds of address the host holds, without the addresses. */
export const addressKindsLine = (kinds: ReadonlyArray<string>): string =>
  kinds.length === 0
    ? "Mend found no network address on the host."
    : `Addresses on the host: ${kinds.join(", ")}.`;

// ---------------------------------------------------------------------------------------------
// The Sealant connection (doctor-web-connection)

export type SealantStatus = "connected" | "unauthorized" | "mismatched" | "unreachable";

export interface SealantConnectionFacts {
  readonly status: SealantStatus;
  readonly baseUrl: string;
  readonly detail: string | null;
  readonly checkedAt: Date;
}

/** What the check found, as a word and a sentence, and what Mend saw when it wasn't connected. */
export interface SealantReading extends Said {
  readonly line: string;
  readonly saw: string | null;
}

/**
 * The Sealant connection check, as the Runtimes section's first row reads it. Never shows the
 * service key: an unauthorized answer says Sealant refused it, nothing more.
 */
export const sealantReading = (connection: SealantConnectionFacts, now: Date): SealantReading => {
  const when = ago(connection.checkedAt, now);
  const at = connection.baseUrl;
  switch (connection.status) {
    case "connected":
      return {
        word: "Connected",
        tone: "ok",
        line: `Mend reached Sealant at ${at}, checked ${when}.`,
        saw: null,
      };
    case "unauthorized":
      return {
        word: "Key refused",
        tone: "bad",
        line: `Sealant at ${at} refused this server's service key, checked ${when}. Give the server a new key with mend server setup.`,
        saw: connection.detail,
      };
    case "mismatched":
      return {
        word: "Not Sealant",
        tone: "wait",
        line: `Something answered at ${at}, but not with the Sealant API Mend speaks, checked ${when}.`,
        saw: connection.detail,
      };
    case "unreachable":
      return {
        word: "Unreachable",
        tone: "bad",
        line: `Mend couldn't reach Sealant at ${at}, checked ${when}.`,
        saw: connection.detail,
      };
  }
};

// ---------------------------------------------------------------------------------------------
// Runtimes

export type Runtime = "docker" | "boat";

export const RUNTIMES: ReadonlyArray<Runtime> = ["docker", "boat"];

export const RUNTIME_NAMES: Readonly<Record<Runtime, string>> = { docker: "Docker", boat: "Boat" };

/** Where a runtime's workspaces run. */
export const RUNTIME_PLACES: Readonly<Record<Runtime, string>> = {
  docker: "Containers on this server.",
  boat: "Virtual machines on Boat, through Sealant.",
};

/** Whether the server offers a runtime, and whether new organizations start on it. */
export const runtimeOffer = (
  runtime: Runtime,
  offer: { readonly offered: ReadonlyArray<Runtime>; readonly default: Runtime },
): { readonly word: string; readonly startsHere: boolean } =>
  offer.offered.includes(runtime)
    ? { word: "Offered", startsHere: offer.default === runtime }
    : { word: "Not offered", startsHere: false };

// ---------------------------------------------------------------------------------------------
// This server (health)

export interface HealthFacts {
  readonly version: string;
  readonly deploymentMode: "local" | "kubernetes";
  readonly sessionChannel: {
    readonly mode: "unix-socket" | "network";
    readonly endpoint: string | null;
  };
}

/** Where the server runs, from `/health`'s deployment mode. */
export const deploymentLine = (health: HealthFacts, hostname: string | null): string =>
  health.deploymentMode === "kubernetes"
    ? "Kubernetes"
    : hostname === null
      ? "One machine, with Docker"
      : `One machine, ${hostname}, with Docker`;

/** How workspaces reach their session. */
export const sessionChannelLine = (channel: HealthFacts["sessionChannel"]): string =>
  channel.mode === "unix-socket"
    ? "A socket per session, on this machine"
    : channel.endpoint === null
      ? "Over the network"
      : `Over the network, at ${channel.endpoint}`;

/** How an operator changes the server: setup on one machine, Helm on Kubernetes. */
export const changeHow = (mode: HealthFacts["deploymentMode"] | null): string =>
  mode === "kubernetes"
    ? "edit your Helm values and upgrade the release"
    : mode === "local"
      ? "run mend server setup on the server"
      : "run mend server setup on the server, or edit your Helm values and upgrade the release";

// ---------------------------------------------------------------------------------------------
// Organizations (org-list, tenancy-gate)

export interface OrganizationCounts {
  readonly memberCount: number;
  readonly ownerCount: number;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** "4 members, 2 owners"; an ownerless organization says so, as `mend operator organizations` does. */
export const organizationCounts = (summary: OrganizationCounts): string =>
  `${plural(summary.memberCount, "member", "members")}, ${
    summary.ownerCount === 0 ? "no owner" : plural(summary.ownerCount, "owner", "owners")
  }`;

export type Tenancy = "single" | "multi";

/** `MEND_TENANCY`, as the Tenancy row reads it. */
export const TENANCY_WORDS: Readonly<
  Record<Tenancy, { readonly word: string; readonly means: string }>
> = {
  single: {
    word: "One organization",
    means: "Everyone who signs in is in the same organization. Set with MEND_TENANCY.",
  },
  multi: {
    word: "Several organizations",
    means:
      "Each organization has its own members and projects, and people in one can't see another's. Set with MEND_TENANCY.",
  },
};

export interface GateItemFacts {
  readonly ok: boolean;
}

/** The line over the multi mode gate's items. */
export const gateSummary = (items: ReadonlyArray<GateItemFacts>, tenancy: Tenancy): string => {
  const failing = items.filter((item) => !item.ok).length;
  if (failing === 0) {
    return tenancy === "multi"
      ? "Every item is in place."
      : "Every item is in place, so the server could run several organizations.";
  }
  const missing = `${plural(failing, "item isn't", "items aren't")} in place`;
  return tenancy === "multi"
    ? `${missing}. The server checks them when it starts.`
    : `${missing}, so Mend would refuse to start with several organizations.`;
};

/**
 * Who may create an organization (`MEND_ORGANIZATION_CREATION`), on a server with several. The
 * server doesn't report the value on its own: for an operator signed in with their own sign-in,
 * `organization.current`'s `canCreateOrganizations` is exactly whether it is `anyone`.
 */
export const creationWord = (canCreateOrganizations: boolean): string =>
  canCreateOrganizations ? "Anyone signed in" : "Only operators";

// ---------------------------------------------------------------------------------------------
// The starting workspace image (image-instance-default, read-only)

export type ImageFacts =
  | {
      readonly mode: "family";
      readonly os: string;
      readonly shell: string;
      readonly packages: ReadonlyArray<string>;
      readonly services: { readonly docker: boolean };
      readonly screen: boolean;
    }
  | {
      readonly mode: "custom";
      readonly baseImage: string;
      readonly packages: ReadonlyArray<string>;
      readonly setupCommands: ReadonlyArray<string>;
      readonly services: { readonly docker: boolean };
    };

const OS_NAMES: Readonly<Record<string, string>> = {
  arch: "Arch",
  fedora: "Fedora",
  ubuntu: "Ubuntu",
  nix: "Nix",
};

/** One line for the image: what it builds from and with what. */
export const imageLine = (image: ImageFacts): string =>
  image.mode === "family"
    ? [
        OS_NAMES[image.os] ?? image.os,
        image.shell,
        plural(image.packages.length, "package", "packages"),
      ].join(" · ")
    : [
        image.baseImage,
        plural(image.packages.length, "package", "packages"),
        plural(image.setupCommands.length, "setup command", "setup commands"),
      ].join(" · ");

/** What the image adds to a workspace beyond its packages. */
export const imageExtras = (image: ImageFacts): string => {
  const docker = image.services.docker ? "Docker inside workspaces" : "No Docker inside workspaces";
  if (image.mode === "custom") return docker;
  return `${docker} · ${image.screen ? "a screen agents can drive" : "no screen"}`;
};
