import { canonicalServerUrl, type CliCredential, type StoredCredential } from "./credentials.js";
import { redactOrigin } from "./project-match.js";

/**
 * Story h, first run: what the Mend view's welcome says from what this machine holds. Pure, so the
 * steps' rules are tested without VS Code; `first-run-view.ts` reads the world into these types and
 * carries out what they decide.
 */

/** Where the editor's sign-in to its server comes from. */
export type ConnectionSource =
  /** This extension's browser sign-in: a device that signing out revokes. */
  | { readonly kind: "extension"; readonly deviceId: string | null }
  /** The Mend CLI's sign-in on this machine (`cli.json`), which only `mend logout` ends. */
  | { readonly kind: "cli" };

export type Connection =
  | {
      readonly kind: "connected";
      readonly url: string;
      readonly token: string;
      readonly source: ConnectionSource;
    }
  | {
      readonly kind: "notConnected";
      /** What Connect's URL input starts with: the CLI's server, else the one configured last. */
      readonly prefill: string | null;
      /** The CLI's sign-in when it holds a token: Use it's candidate once Mend names its account. */
      readonly cli: { readonly url: string; readonly token: string } | null;
    };

/**
 * The editor is connected once Connect or Use it named a server (`mend.serverUrl`) and a token
 * for it exists: its own, else the CLI's for the same server. Its own "none" (a sign-out) never
 * falls back to the CLI's, which may be another account.
 */
export const connectionOf = (input: {
  readonly configured: string | null;
  /** The editor's own entry for the configured server. */
  readonly own: StoredCredential | null;
  readonly cli: CliCredential | null;
}): Connection => {
  const cli =
    input.cli !== null && input.cli.token !== null
      ? { url: canonicalServerUrl(input.cli.url), token: input.cli.token }
      : null;
  if (input.configured === null) {
    return { kind: "notConnected", prefill: cli?.url ?? input.cli?.url ?? null, cli };
  }
  const url = canonicalServerUrl(input.configured);
  const own = input.own !== null && canonicalServerUrl(input.own.url) === url ? input.own : null;
  if (own?.kind === "token") {
    return {
      kind: "connected",
      url,
      token: own.token,
      source: { kind: "extension", deviceId: own.deviceId },
    };
  }
  if (own === null && cli !== null && cli.url === url) {
    return { kind: "connected", url, token: cli.token, source: { kind: "cli" } };
  }
  return { kind: "notConnected", prefill: url, cli };
};

/** The CLI's sign-in, offered as Use it: its server and the account Mend says it is. */
export interface CliOffer {
  readonly url: string;
  readonly email: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The signed-in account's email, from `GET /organization` and `GET /organization/members`. */
export const accountEmail = (organization: unknown, members: unknown): string | null => {
  const userId = isRecord(organization) ? organization["userId"] : null;
  if (typeof userId !== "string" || !Array.isArray(members)) return null;
  const member = members.find((candidate) => isRecord(candidate) && candidate["userId"] === userId);
  return isRecord(member) && typeof member["email"] === "string" ? member["email"] : null;
};

/**
 * The one consent in the product (`globalState mend.workspaceSsh.consent`), one per server: its
 * workspace SSH writes that server's Host block into `~/.ssh/config`. First run's Set up gives it;
 * skipping records that she skipped, so the welcome moves on and Open still asks once. Consent to
 * one server's block never lets another server's be written.
 */
export type SshConsent = "given" | "skipped" | "never";

type RecordedConsent = Exclude<SshConsent, "never">;

const isRecordedConsent = (value: unknown): value is RecordedConsent =>
  value === "given" || value === "skipped";

/** The consents kept, by canonical server URL. */
export type SshConsentRecord = Readonly<Record<string, RecordedConsent>>;

const consentsOf = (value: unknown): SshConsentRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([url, consent]) =>
          isRecordedConsent(consent) ? [[url, consent]] : [],
        ),
      )
    : {};

/** What the record says for `server`. */
export const parseSshConsent = (value: unknown, server: string): SshConsent =>
  consentsOf(value)[canonicalServerUrl(server)] ?? "never";

/** The record with `consent` for `server`, every other server's as it was. */
export const withSshConsent = (
  value: unknown,
  server: string,
  consent: RecordedConsent,
): SshConsentRecord => ({ ...consentsOf(value), [canonicalServerUrl(server)]: consent });

/** What Open reads of the record (open-runner's `sshConsent`): only given spares the question. */
export const openConsent = (consent: SshConsent): "given" | "never" =>
  consent === "given" ? "given" : "never";

/**
 * What Open needs from this machine: Remote-SSH installed; this machine's key registered and the
 * server's Host block in `~/.ssh/config` (one idempotent step); Remote-SSH's platform seeded for
 * the Host. Unavailable when the server has no workspace SSH gateway, or it could not be read.
 */
export type SshFacts =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "read";
      readonly remoteSsh: boolean;
      readonly workspaceSsh: boolean;
      readonly platform: boolean;
    };

export type SetUpStep = "installRemoteSsh" | "workspaceSsh" | "seedPlatform";

/** The steps Set up runs, in order: only the missing ones. */
export const missingSteps = (
  facts: Extract<SshFacts, { readonly kind: "read" }>,
): ReadonlyArray<SetUpStep> => {
  const steps: Array<SetUpStep> = [];
  if (!facts.remoteSsh) steps.push("installRemoteSsh");
  if (!facts.workspaceSsh) steps.push("workspaceSsh");
  if (!facts.platform) steps.push("seedPlatform");
  return steps;
};

const STEP_WORDS: Readonly<Record<SetUpStep, string | null>> = {
  installRemoteSsh: "Remote-SSH",
  workspaceSsh: "an SSH key for Mend · one Host block in ~/.ssh/config",
  seedPlatform: null,
};

/** Set up's progress notification, naming what it does. */
export const setUpTitle = (steps: ReadonlyArray<SetUpStep>): string => {
  const words = steps.flatMap((step) => STEP_WORDS[step] ?? []);
  return words.length === 0 ? "Setting up Remote-SSH for Mend" : `Setting up: ${words.join(" · ")}`;
};

export interface SetUpEffects {
  readonly installRemoteSsh: () => Promise<void>;
  /** Registers this machine's key and writes the server's one Host block. */
  readonly workspaceSsh: () => Promise<void>;
  readonly seedPlatform: () => Promise<void>;
  readonly recordConsent: (consent: RecordedConsent) => Promise<void>;
}

/** Runs every missing step, then records the consent: an Open after it never asks. */
export const runSetUp = async (
  facts: Extract<SshFacts, { readonly kind: "read" }>,
  effects: SetUpEffects,
): Promise<ReadonlyArray<SetUpStep>> => {
  const steps = missingSteps(facts);
  for (const step of steps) await effects[step]();
  await effects.recordConsent("given");
  return steps;
};

/** What this window offers for her first project, when she has none yet. */
export type ProjectMatch =
  /** The store has not read her projects yet. */
  | { readonly kind: "unread" }
  /** The window's repository is one Mend knows, or she has others: the view shows them. */
  | { readonly kind: "projects" }
  /** No project yet, and this window is a clone Mend does not have: `Adopt <name> from <origin>`. */
  | { readonly kind: "notAdopted"; readonly name: string; readonly origin: string }
  /** No project yet, and nothing here to adopt: Adopt a repository… asks for a clone URL. */
  | { readonly kind: "noRepository" };

export const projectMatch = (input: {
  readonly read: boolean;
  readonly projects: number;
  readonly unmatched: { readonly name: string; readonly origin: string } | null;
}): ProjectMatch => {
  if (!input.read) return { kind: "unread" };
  if (input.projects > 0) return { kind: "projects" };
  return input.unmatched === null
    ? { kind: "noRepository" }
    : { kind: "notAdopted", ...input.unmatched };
};

export type FirstRun =
  | { readonly kind: "notConnected"; readonly offer: CliOffer | null }
  /** Connected; workspace SSH neither set up nor skipped: the welcome's Set up. */
  | { readonly kind: "needsSsh"; readonly url: string; readonly source: ConnectionSource }
  | {
      readonly kind: "connected";
      readonly url: string;
      readonly source: ConnectionSource;
      /** `unread` until the first read of the SSH facts lands. */
      readonly ssh: "ready" | "given" | "skipped" | "unavailable" | "unread";
      readonly project: ProjectMatch;
    };

export const firstRun = (input: {
  readonly connection: Connection;
  /** Mend's answer for the CLI's sign-in; null when none, or while it is read. */
  readonly offer: CliOffer | null;
  /** Null until read. */
  readonly ssh: SshFacts | null;
  readonly consent: SshConsent;
  readonly project: ProjectMatch;
  /** A session's workspace window: she opened it over Remote-SSH, so first run is behind her. */
  readonly workspaceWindow: boolean;
}): FirstRun => {
  const { connection } = input;
  if (connection.kind === "notConnected") {
    const offer =
      input.offer !== null &&
      connection.cli !== null &&
      canonicalServerUrl(input.offer.url) === connection.cli.url
        ? input.offer
        : null;
    return { kind: "notConnected", offer };
  }
  const { url, source } = connection;
  if (input.workspaceWindow) {
    return { kind: "connected", url, source, ssh: "ready", project: { kind: "projects" } };
  }
  const ssh = ((): Extract<FirstRun, { kind: "connected" }>["ssh"] | "missing" => {
    if (input.consent !== "never") return input.consent;
    if (input.ssh === null) return "unread";
    if (input.ssh.kind === "unavailable") return "unavailable";
    return missingSteps(input.ssh).length === 0 ? "ready" : "missing";
  })();
  if (ssh === "missing") return { kind: "needsSsh", url, source };
  return { kind: "connected", url, source, ssh, project: input.project };
};

export type Welcome =
  | { readonly kind: "connect" }
  | { readonly kind: "useCli"; readonly offer: CliOffer }
  | { readonly kind: "setUp" }
  | { readonly kind: "adopt"; readonly name: string; readonly origin: string }
  | { readonly kind: "adoptRepository" };

/**
 * What the Mend view shows: a welcome step (the tree held empty so VS Code draws it), nothing
 * while a fact it waits on is read, or the sessions tree.
 */
export type ViewMode =
  | { readonly kind: "welcome"; readonly welcome: Welcome }
  | { readonly kind: "blank" }
  | { readonly kind: "tree" };

export const viewMode = (state: FirstRun): ViewMode => {
  switch (state.kind) {
    case "notConnected":
      return {
        kind: "welcome",
        welcome:
          state.offer === null ? { kind: "connect" } : { kind: "useCli", offer: state.offer },
      };
    case "needsSsh":
      return { kind: "welcome", welcome: { kind: "setUp" } };
    case "connected":
      if (state.ssh === "unread") return { kind: "blank" };
      switch (state.project.kind) {
        case "unread":
        case "projects":
          return { kind: "tree" };
        case "notAdopted":
          return {
            kind: "welcome",
            welcome: { kind: "adopt", name: state.project.name, origin: state.project.origin },
          };
        case "noRepository":
          return { kind: "welcome", welcome: { kind: "adoptRepository" } };
      }
  }
};

/** `mend-mini.local:3105`: the server as the welcome and the Accounts menu name it. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * `github.com/acme/newsroom-api` for any spelling of a clone URL (https, ssh, scp-like), without
 * credentials or `.git`.
 */
export const originLabel = (origin: string): string => {
  const trimmed = origin.trim().replace(/\.git$/, "");
  const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp !== null) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    return `${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return trimmed;
  }
};

/** A step whose words carry facts: the view's message says them, and one row acts on them. */
export interface Offer {
  readonly message: string;
  readonly action: { readonly label: string; readonly command: string; readonly tooltip: string };
}

/**
 * The steps VS Code cannot draw as a welcome: a welcome's words are fixed in the manifest, and a
 * single view's title takes no description (it merges into `Mend: Sessions`). Null for a step whose
 * words are fixed, which VS Code draws as the welcome over the empty tree.
 */
export const offerOf = (welcome: Welcome): Offer | null => {
  switch (welcome.kind) {
    case "useCli":
      return {
        message: `Mend at ${hostOf(welcome.offer.url)} · signed in as ${welcome.offer.email} (from the Mend CLI)`,
        action: {
          label: "Use it",
          command: "mend.useCli",
          tooltip: "Connect on the Mend CLI's sign-in: no URL, no browser",
        },
      };
    case "adopt":
      return {
        message: `Adopt ${welcome.name} from ${originLabel(welcome.origin)}`,
        action: {
          label: "Adopt",
          command: "mend.adoptHere",
          tooltip: `Adopt ${redactOrigin(welcome.origin)} into Mend as ${welcome.name}`,
        },
      };
    case "connect":
    case "setUp":
    case "adoptRepository":
      return null;
  }
};

/** The one success toast of a sign-in. */
export const signedInMessage = (url: string, email: string): string => {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // A URL Connect wrote is always parseable; the raw form is only a fallback.
  }
  return `Signed in to ${host} as ${email}`;
};

export type SignInOutcome =
  | { readonly kind: "signedIn"; readonly email: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

export const TRY_AGAIN = "Try again";

export interface ConnectEffects {
  /** The one URL input; undefined when she closes it. */
  readonly askUrl: (prefill: string | null) => Promise<string | undefined>;
  /** The browser walk under its one progress notification, saved when it succeeds. */
  readonly signIn: (url: string) => Promise<SignInOutcome>;
  readonly toast: (message: string) => void;
  /** The one error toast; resolves Try again when she picks it. */
  readonly fail: (reason: string) => Promise<typeof TRY_AGAIN | undefined>;
  /** Points the editor at `url` on the CLI's sign-in: the setting, and no entry of its own there. */
  readonly useCliSignIn: (url: string) => Promise<void>;
}

/**
 * Connect: the URL, the browser, one toast. A failure says why once, with Try again, which asks
 * again from the URL she typed. True once signed in.
 */
export const runConnect = async (
  prefill: string | null,
  effects: ConnectEffects,
): Promise<boolean> => {
  let start = prefill;
  for (;;) {
    const url = await effects.askUrl(start);
    if (url === undefined) return false;
    const outcome = await effects.signIn(url);
    switch (outcome.kind) {
      case "signedIn":
        effects.toast(signedInMessage(url, outcome.email));
        return true;
      case "cancelled":
        return false;
      case "failed":
        if ((await effects.fail(outcome.reason)) !== TRY_AGAIN) return false;
        start = url;
    }
  }
};

/** Use it: the CLI's sign-in, with no URL, no browser and no toast. */
export const useCli = (offer: CliOffer, effects: ConnectEffects): Promise<void> =>
  effects.useCliSignIn(offer.url);
