/**
 * The session engine's per-person steps (docs/adr/0016-per-person-harness-homes.md), behind
 * `MEND_HARNESS_LAYOUT`: the layout decided before create, what prepare runs and what it found,
 * the people an executor holds, the user each of their processes starts as, and the logins in
 * each person's home (decision 5). With the flag off and nothing recorded, nothing here reads the
 * store, execs or calls Core.
 */
import { HarnessLayoutsRepo, type OrganizationsRepo } from "@mend/db";
import { type OrganizationId, type WorkspaceImage, WorktreeId } from "@mend/domain";
import {
  type HarnessLayout,
  HarnessLayout as HarnessLayoutSchema,
  type HarnessLayoutSource,
  type LinuxIdentity,
  MEND_GROUP,
  linuxHomeOf,
} from "@mend/domain/workbench";
import {
  type HeldHome,
  type HomeLogins,
  type LoginProvider,
  type LoginSkip,
  PersonLayoutPlatform,
  type ProcessUser,
  SealantPlatformError,
  type SealantClientShape,
} from "@mend/sealant";
import type { Harness, Workspace, WorkspaceCredentialsOptions } from "@sealant/sdk";
import { Clock, Config, Deferred, Duration, Effect, Layer, Schedule } from "effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

import { CONVERSATION_HOMES } from "./conversation-home.ts";
import {
  type LayoutCapability,
  type PrepareFinding,
  UNKNOWN_CAPABILITY,
  decideHarnessLayout,
  identityPickupScript,
  imageLayoutKeyOf,
  identityRefusal,
  layoutProbeScript,
  operatorPersonRefusal,
  ownerMapRefusal,
  parseLayoutReport,
  personLayoutRefusal,
  personHomeScript,
  personPrepareScript,
  personProcessEnv,
  processUserOf,
  staticLayoutObstacle,
  worktreeRepairScript,
} from "./harness-layout.ts";
import { DOTFILES_NOT_TO_ROOT } from "./person-deliveries.ts";

// ─── configuration ───────────────────────────────────────────────────────────

/** `MEND_HARNESS_LAYOUT`: the layout of worktrees with none yet. `shared` until Delivery 21. */
export class HarnessLayoutConfig extends Context.Service<
  HarnessLayoutConfig,
  {
    readonly flag: HarnessLayout;
    /**
     * How long after a person's last process start their logins are kept although Mend sees no
     * live process of theirs (`LOGIN_RELEASE_GRACE` unless a test says): the start's process row
     * is written once the platform has opened it.
     */
    readonly loginReleaseGrace?: Duration.Duration;
    /**
     * How long a start waits for a person's dotfiles apply before the agent starts beside it
     * (`DOTFILES_APPLY_BOUND_MS` unless a test says).
     */
    readonly dotfilesApplyBound?: Duration.Duration;
  }
>()("@mend/sessions/HarnessLayoutConfig") {}

/** A person's logins outlive a start by this much before an idle check may release them. */
export const LOGIN_RELEASE_GRACE: Duration.Duration = Duration.minutes(1);

export const HarnessLayoutConfigLive: Layer.Layer<HarnessLayoutConfig, Config.ConfigError> =
  Layer.effect(
    HarnessLayoutConfig,
    Effect.gen(function* () {
      const flag = yield* Config.schema(HarnessLayoutSchema, "MEND_HARNESS_LAYOUT").pipe(
        Config.withDefault("shared" as const),
      );
      return { flag };
    }),
  );

/** The flag off, for tests and compositions that never run the person layout. */
export const HarnessLayoutConfigShared: Layer.Layer<HarnessLayoutConfig> = Layer.succeed(
  HarnessLayoutConfig,
  { flag: "shared" },
);

// ─── what a launch runs ──────────────────────────────────────────────────────

/**
 * A launch's layout, decided before its create. `recorded`: the decision is in
 * `executor_layouts` (anything but the flag-off default, which leaves no row: a launch with no
 * row is `shared`, as every launch before this release).
 */
export type LaunchLayout =
  | {
      readonly layout: "shared";
      readonly source: HarnessLayoutSource;
      readonly reason: string | null;
      /** Prepare runs the image probe and records what it found. */
      readonly probe: boolean;
      readonly imageKey: string | null;
      readonly runtime: string;
      readonly recorded: boolean;
    }
  | {
      readonly layout: "person";
      readonly source: HarnessLayoutSource;
      readonly onMissing: PrepareFinding;
      readonly launcher: LinuxIdentity;
      /** Current members of the organization other than the launcher, made when their saved directory is in the restored head. */
      readonly members: ReadonlyArray<LinuxIdentity>;
      readonly imageKey: string;
      readonly runtime: string;
    };

/** The flag-off launch: no row, no probe, exactly as before this release. */
export const SHARED_AS_BEFORE: LaunchLayout = {
  layout: "shared",
  source: "flag",
  reason: null,
  probe: false,
  imageKey: null,
  runtime: "unknown",
  recorded: false,
};

/** A launch refused before create, with the line the session settles on (decision 14). */
export const layoutRefused = (message: string) =>
  new SealantPlatformError({ code: "harness_layout_refused", status: 409, message, cause: null });

/** What prepare found, once the executor exists. */
export type PrepareOutcome =
  | {
      readonly layout: "person";
      /**
       * The people prepare made whose restored saved directory holds an opencode database:
       * scrubbed of in-app logins as each of them, off the launch path (decision 8a).
       */
      readonly opencode: ReadonlyArray<LinuxIdentity>;
    }
  | {
      readonly layout: "shared";
      readonly fallback: string | null;
      /**
       * Why the launcher's dotfiles were not applied, when decision 1's fallback to `/root` had
       * some: Core's `dotfiles.apply` runs only as a person, never as root (sealant#334), and the
       * create, made for a person launch, applied none at boot. Null otherwise.
       */
      readonly dotfilesNotApplied?: string | null;
    };

/** Until Delivery 18, a turn from anyone but the process's person is refused in a person executor. */
export const PERSON_STEER_REFUSAL =
  "This session's workspace runs each person as their own user, and turns from anyone but its owner arrive with per-person steering. Until then only the owner sends turns here.";

// ─── logins per person (decision 5) ──────────────────────────────────────────

/**
 * The logins a process needs in its person's home: the harness's own provider, without which it
 * is refused, and the rest, written when connected and left out when not. A shell, a Service, pi
 * and opencode are open workbenches (the create's own ladder for them names every provider), so
 * nothing is required of them. pi and opencode also take the ChatGPT login Core makes for each
 * from the person's Codex account (sealant#336), in place of the copy Mend's seed made.
 */
export interface LoginNeed {
  readonly required: ReadonlyArray<LoginProvider>;
  readonly optional: ReadonlyArray<LoginProvider>;
}

export const loginNeedOf = (harness: string): LoginNeed => {
  switch (harness) {
    case "claude":
      return { required: ["claude"], optional: ["github"] };
    case "codex":
      return { required: ["codex"], optional: ["github"] };
    case "pi":
      return { required: [], optional: ["claude", "codex", "github", "pi"] };
    case "opencode":
      return { required: [], optional: ["claude", "codex", "github", "opencode"] };
    default:
      return { required: [], optional: ["claude", "codex", "github"] };
  }
};

const PROVIDER_NAMES: Readonly<Record<LoginProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  github: "GitHub",
  pi: "pi's ChatGPT",
  opencode: "opencode's ChatGPT",
};

/** Why Core refused or left out a provider's login (`SealantApiError.reason`, sealant#335/#337). */
export type LoginRefusalReason = LoginSkip["reason"];

/**
 * The refusal before start (decision 5): the needed provider is not connected, its login needs
 * reconnecting, its account is not one the provider takes, or its login file in the person's home
 * cannot be written. Nobody else's login is used. The person's user and home may already be made
 * (that runs beside the POST), and what the POST wrote of the rest is released with the Mend token
 * minted for them.
 */
export const loginRefusal = (provider: LoginProvider, reason: LoginRefusalReason): string => {
  const name = PROVIDER_NAMES[provider];
  switch (reason) {
    case "connected-account-invalid":
      return `Your ${name} login needs reconnecting. Reconnect ${name} to start a session here.`;
    case "connected-account-unsupported":
      return `Your connected ${name} account cannot be used for this. Connect another to start a session here.`;
    case "login-file-unusable":
      return `Your ${name} login could not be written into your home in this workspace: its file there is not a plain file of yours. Start a new worktree, or remove the file.`;
    case "connected-account-missing":
      return `Connect ${name} to start a session here.`;
  }
};

const CHATGPT_SKIP_WORDS: Readonly<Record<LoginRefusalReason, string>> = {
  "connected-account-missing": "no Codex account is connected",
  "connected-account-invalid": "the Codex login needs reconnecting",
  "connected-account-unsupported": "the Codex account is not a ChatGPT login",
  "login-file-unusable": "its login file in your home is not a plain file of yours",
};

/**
 * The session line when Core left pi's or opencode's ChatGPT login out of a person's put
 * (sealant#336/#337): what was observed, never a verdict. Null for any other provider, whose
 * absence an open workbench does not need said.
 */
export const loginLeftOutWords = (skip: LoginSkip): string | null =>
  skip.provider === "pi" || skip.provider === "opencode"
    ? `${PROVIDER_NAMES[skip.provider]} login not written · ${CHATGPT_SKIP_WORDS[skip.reason]}`
    : null;

/** A process refused because its person's needed login is missing (`loginRefusal`). */
export const loginRefused = (message: string) =>
  new SealantPlatformError({ code: "person_login_refused", status: 409, message, cause: null });

const loginProviderOf = (word: string | undefined): LoginProvider | null => {
  switch (word) {
    case "claude":
    case "codex":
    case "github":
    case "pi":
    case "opencode":
      return word;
    default:
      return null;
  }
};

const refusalReasonOf = (code: string): LoginRefusalReason | null => {
  switch (code) {
    case "connected-account-missing":
    case "connected-account-invalid":
    case "connected-account-unsupported":
      return code;
    default:
      return null;
  }
};

/**
 * The account a whole POST was refused for, by Core's stable code (`SealantApiError.reason`:
 * `connected-account-missing`, `-invalid` or `-unsupported`) and its `provider` (sealant#335).
 * Null for any other failure. Nothing was written: Core resolves every account before it writes
 * any.
 */
export const refusedAccountOf = (
  error: SealantPlatformError,
): { readonly provider: LoginProvider; readonly reason: LoginRefusalReason } | null => {
  const reason = refusalReasonOf(error.code);
  const provider = loginProviderOf(error.provider);
  return provider === null || reason === null ? null : { provider, reason };
};

/**
 * Whether a failed turn's words say its harness was refused for its login (a 401, an expired or
 * revoked OAuth token, Claude's "Please run /login"): what makes Mend write the person's login
 * into their home once more (decision 5, "one re-POST after an authentication failure").
 */
export const isAuthenticationFailure = (error: string | null): boolean =>
  error !== null &&
  /\b401\b|unauthori[sz]ed|authentication[_ ]error|failed to authenticate|invalid (?:api key|x-api-key|bearer)|oauth token|please run \/login|not logged in|token (?:has )?(?:expired|been revoked)/i.test(
    error,
  );

/** The providers a launch's create wrote into the launcher's home (`credentialsHome`). */
export const loginsOfCreate = (
  credentials: WorkspaceCredentialsOptions | undefined,
): ReadonlyArray<LoginProvider> =>
  (["claude", "codex", "github"] as const).filter(
    (provider) => credentials?.[provider] !== undefined && credentials[provider] !== false,
  );

export interface HarnessLayoutSteps {
  readonly flag: HarnessLayout;
  /** The layout of a capture-mode launch, before its create; a refusal fails with its line. */
  readonly decide: (input: {
    readonly worktreeId: WorktreeId;
    readonly sessionId: string;
    readonly launchId: string;
    readonly ownerUserId: string;
    readonly organizationId: OrganizationId;
    /** The image the create will ask for (read only when the flag or the worktree asks). */
    readonly image: Effect.Effect<WorkspaceImage>;
    /** The harness the create will ask for: part of the image Core reports on. */
    readonly harness: Harness;
    /** Whether the worktree's head capture holds `harness/people/` (read only when needed). */
    readonly headHasPeople: Effect.Effect<boolean>;
    /**
     * Whether the launcher keeps dotfiles this project applies: read only when the flag would make
     * a fresh worktree person and the platform cannot apply dotfiles as a person yet.
     */
    readonly launcherHasDotfiles?: Effect.Effect<boolean>;
  }) => Effect.Effect<LaunchLayout, SealantPlatformError>;
  /**
   * Whether any executor of the worktree can run the person layout: the flag on, or the worktree
   * already person. One row read; with neither, a process start asks nothing else here.
   */
  readonly mayRunPerson: (worktreeId: WorktreeId) => Effect.Effect<boolean>;
  /**
   * Whether any worktree may run the person layout at all: the flag on, or a layout recorded (at
   * startup, or since). Answered from memory. False means `mayRunPerson` answers false for every
   * worktree without a read, so a caller may skip the reads it would make to ask it.
   */
  readonly personPossible: () => boolean;
  /**
   * A worktree's layout is being recorded outside these steps (the operator's `harnessLayout`,
   * noted before its write): from now on the steps read the store again. With the flag off and
   * nothing recorded, it is the only way a layout gets recorded (`decide` records nothing then),
   * so nothing polls the store for one (docs/adr/0016). Another engine over the same database (a
   * second Mend, or `MEND_MODE=api` beside `MEND_MODE=worker`) sees such a record only after it
   * restarts (deploy/aws/issues-for-real-ha.md, A6).
   */
  readonly noteRecorded: () => void;
  /** Whether a standby (created before any worktree is known, as root) may serve the worktree. */
  readonly standbyMayServe: (worktreeId: WorktreeId) => Effect.Effect<boolean>;
  /**
   * One identity pickup ticket per person prepare may make (docs/adr/0016, decision 4), by
   * account: what prepare's exec redeems for each person it makes, their Mend token of this
   * launch and their git author, minted only at redemption, so a person prepare skips gets none.
   * Null for a shared launch. Memory only: it rides prepare's exec, so it adds no exec; the
   * caller discards the tickets when that exec ends.
   */
  readonly prepareTickets: (input: {
    readonly layout: LaunchLayout;
    readonly launchId: string;
    readonly sessionId: string;
    readonly worktreeId: string;
  }) => Effect.Effect<ReadonlyMap<string, string> | null>;
  /** What prepare runs in the executor's first exec for this layout, after the helper install. */
  readonly prepareScript: (
    layout: LaunchLayout,
    places: { readonly harnessHome: string; readonly repo: string },
    tickets?: ReadonlyMap<string, string> | null,
  ) => string | null;
  /**
   * What prepare's output says, recorded: the person layout confirmed (the worktree is person
   * from now on), a fallback to shared on a fresh worktree (the launcher's logins and dotfiles put
   * where a shared executor reads them first), or a refusal.
   */
  readonly settlePrepare: (input: {
    readonly layout: LaunchLayout;
    readonly launchId: string;
    readonly worktreeId: WorktreeId;
    readonly workspace: Workspace;
    readonly stdout: string;
    readonly fallback: {
      /** The launcher's create-time logins: what their home holds once the layout is person. */
      readonly credentials: WorkspaceCredentialsOptions | undefined;
      /**
       * What the launch starts (`loginNeedOf`): the providers the `/root` write must not leave
       * out. Null when unknown: then every provider the create named is needed.
       */
      readonly harness?: string | null;
      readonly dotfiles: ReadonlyArray<{
        readonly data: string;
        readonly manager: string;
        readonly bootstrap: boolean;
      }>;
    };
  }) => Effect.Effect<PrepareOutcome, SealantPlatformError>;
  /**
   * A person launch's create, refused for its owner map (decision 13's words): Core's
   * `owner-map-unsupported` (the image's sealantd does not restore files per person) or a
   * runtime where no person's sudo works (Kubernetes, Cloudflare). What it found is recorded
   * against the image, so the next launch of a fresh worktree decides shared before create; a
   * worktree already person stays person and is refused. Null for any other failure.
   */
  readonly refusedOwnerMap: (input: {
    readonly layout: LaunchLayout;
    readonly launchId: string | undefined;
    readonly error: SealantPlatformError;
  }) => Effect.Effect<SealantPlatformError | null>;
  /** The layout of the executor a launch made: its record, or `shared` without one. */
  readonly layoutOfLaunch: (launchId: string | null) => Effect.Effect<HarnessLayout>;
  /**
   * The user a person's process starts as in a person-layout executor, made there first when it
   * is their first process (one exec), with their own logins written into their home before it
   * starts (one Core call, beside that exec), and the worktree repair started when the person
   * differs from the last one whose process started there (one exec, never awaited). Refused
   * when Core left the harness's own provider out of that call (not connected, needs
   * reconnecting, or its file unusable), what it did write recorded for the release that follows,
   * and when the launch is unknown in a worktree that runs per person (never run as root there).
   * Null in a shared executor: the process runs as root, as before.
   */
  readonly processAs: (input: {
    readonly workspace: Workspace;
    readonly launchId: string | null;
    readonly accountId: string;
    /** The session the process belongs to: what its shim and helper name (`MEND_SESSION_ID`). */
    readonly sessionId: string;
    /** That session's worktree, which a person's identity ticket names. */
    readonly worktreeId: string;
    /** What the process runs, which decides the logins it needs (`loginNeedOf`). */
    readonly harness: string;
    /** Who has a live process in the executor: read only when a start does not finish. */
    readonly live: Effect.Effect<ReadonlySet<string>>;
    /**
     * Told once the person's user and home exist in the executor, before their logins are
     * written (decision 5): their deliveries run beside that write, and only the start waits for
     * both (Performance). Never told in a shared executor; the caller completes it with null.
     */
    readonly homeReady?: Deferred.Deferred<PersonHome | null>;
  }) => Effect.Effect<
    {
      readonly user: ProcessUser;
      readonly env: Readonly<Record<string, string>>;
      /** The session line's words for an optional login this start's put left out. */
      readonly loginsLeftOut: ReadonlyArray<string>;
    } | null,
    SealantPlatformError
  >;
  /**
   * Whether Mend holds a home in this executor that an idle check could release: answered from
   * memory, so an exit in a shared executor, or one with only its launcher, reads nothing more.
   */
  readonly holdsReleasable: (workspaceId: string) => boolean;
  /**
   * Releases the logins of every person who holds a home in the executor and has no live process
   * there (`live`, read only when there is a home to release), except the launcher's create-time
   * home, which stays while the executor lives: DELETE, retried, then their Mend token of the
   * launch revoked. A person whose process started within the grace is checked again once it has
   * passed. Never fails: what could not be released stays held until the executor ends.
   */
  readonly releaseIdle: (input: {
    readonly workspaceId: string;
    readonly workspace: Effect.Effect<Workspace, SealantPlatformError>;
    readonly live: Effect.Effect<ReadonlySet<string>>;
    /** Whose launch made the executor: their create-time home is never released. Null: unknown. */
    readonly launcher: Effect.Effect<string | null>;
  }) => Effect.Effect<void>;
  /**
   * Writes a person's logins into their home once more after their harness was refused for its
   * login (decision 5): one Core call, at most once a minute per person and executor. Never
   * fails.
   */
  readonly relogin: (input: {
    readonly workspace: Workspace;
    readonly launchId: string | null;
    readonly accountId: string;
    readonly harness: string;
    /** Who has a live process there: nobody is written into whom nothing runs. */
    readonly live: Effect.Effect<ReadonlySet<string>>;
  }) => Effect.Effect<void>;
  /**
   * At startup (decision 5, reconciliation against `GET`): what Core keeps in a live person
   * executor's homes becomes what Mend knows it holds, and a home whose person has no live process
   * there is released, the launcher's create-time home excepted. Never fails.
   */
  readonly reconcileLogins: (input: {
    readonly workspace: Workspace;
    readonly launchId: string;
    readonly launcher: string;
    /** Who has a live process there, read after Core's homes are listed. */
    readonly live: Effect.Effect<ReadonlySet<string>>;
    /**
     * A conversation home Core lists (`/run/mend/conv/<session id>`, decision 6): kept for the
     * conversation's live process, or released, by the caller.
     */
    readonly conversationHome?: (held: HeldHome) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  /** An executor ended: what Mend kept about its people goes with it. */
  readonly forgetExecutor: (workspaceId: string) => void;
  /** The refusal of a turn whose author is not the process's person, in a person executor. */
  readonly turnRefusal: (input: {
    readonly launchId: string | null;
    readonly ownerUserId: string | null;
    readonly author: string | null;
  }) => Effect.Effect<string | null>;
}

/** A person's home in an executor, ready for their deliveries (`processAs`'s `homeReady`). */
export interface PersonHome {
  readonly identity: LinuxIdentity;
  readonly user: ProcessUser;
  /** This start made their user and home here: their first process in this executor. */
  readonly made: boolean;
}

/** What prepare runs for a layout (`HarnessLayoutSteps.prepareScript`). */
export const layoutPrepareScript: HarnessLayoutSteps["prepareScript"] = (
  layout,
  places,
  tickets,
) => {
  if (layout.layout === "person") {
    const ticketOf = (person: LinuxIdentity) => {
      const ticket = tickets?.get(person.accountId);
      return ticket === undefined ? {} : { ticket };
    };
    return personPrepareScript(
      [
        { person: layout.launcher, ifSaved: false, ...ticketOf(layout.launcher) },
        ...layout.members.map((person) => ({ person, ifSaved: true, ...ticketOf(person) })),
      ],
      places,
    );
  }
  return layout.probe ? layoutProbeScript([]) : null;
};

const BOUND = 2_048;
/** A map that forgets everything at a bound: what it holds is a cache, rebuilt on a miss. */
const bounded = <K, V>() => {
  const map = new Map<K, V>();
  return {
    get: (key: K) => map.get(key),
    delete: (key: K) => map.delete(key),
    set: (key: K, value: V) => {
      // The oldest goes, one at a time: live launches are never flushed together.
      map.delete(key);
      if (map.size >= BOUND) {
        const oldest = map.keys().next();
        if (oldest.done !== true) map.delete(oldest.value);
      }
      map.set(key, value);
    },
  };
};

/**
 * What a create refused for its owner map lacks, in the words a refusal line names, or null when
 * the failure is not about the owner map (sealant#333's words and code).
 */
export const ownerMapRefusalOf = (error: SealantPlatformError): string | null => {
  if (error.message.includes("is not available on Kubernetes")) {
    return "Kubernetes workspaces cannot run per-person users: no one's sudo works there";
  }
  if (error.message.includes("is not available in Cloudflare")) {
    return "Cloudflare sandboxes cannot run per-person users";
  }
  if (error.code === "owner-map-unsupported" || error.message.includes("names an owner map")) {
    return "its sealantd does not restore files per person";
  }
  return null;
};

/** What a POST names for the launcher's create-time logins, put elsewhere (decision 1's fallback). */
const homeLoginsOf = (credentials: WorkspaceCredentialsOptions | undefined): HomeLogins => {
  const logins: HomeLogins = {};
  for (const provider of ["claude", "codex", "github"] as const) {
    const choice = credentials?.[provider];
    if (choice === true || typeof choice === "string") logins[provider] = choice;
  }
  return logins;
};

/** A person's home in an executor, and what Core keeps there for them (decision 5). */
interface HeldLogins {
  readonly identity: LinuxIdentity;
  /** Providers whose login Core writes there. */
  readonly held: ReadonlySet<LoginProvider>;
  /** Optional providers the person had not connected when Mend last asked. */
  readonly absent: ReadonlySet<LoginProvider>;
  /**
   * Optional providers whose login file in the home Core could not write (`login-file-unusable`):
   * not named again while the home is held, since only the person can change the file.
   */
  readonly unusable: ReadonlySet<LoginProvider>;
}

/** Whether what a home holds covers what a process needs: no POST then. */
const covers = (holding: HeldLogins | undefined, need: LoginNeed): boolean =>
  holding !== undefined &&
  need.required.every((provider) => holding.held.has(provider)) &&
  need.optional.every(
    (provider) =>
      holding.held.has(provider) || holding.absent.has(provider) || holding.unusable.has(provider),
  );

/**
 * What a home holds once a partial POST answered (sealant#337): a provider named `true` and not
 * left out is held; one named `null`, or left out for its account, is absent (Core removed its
 * login); one left out for its file is unusable.
 */
const heldAfter = (
  holding: HeldLogins | undefined,
  identity: LinuxIdentity,
  choices: ReadonlyMap<LoginProvider, true | null>,
  skipped: ReadonlyMap<LoginProvider, LoginSkip>,
): HeldLogins => {
  const held = new Set(holding?.held ?? []);
  const absent = new Set(holding?.absent ?? []);
  const unusable = new Set(holding?.unusable ?? []);
  for (const [provider, choice] of choices) {
    const skip = skipped.get(provider);
    held.delete(provider);
    absent.delete(provider);
    unusable.delete(provider);
    if (choice === true && skip === undefined) held.add(provider);
    else if (skip?.reason === "login-file-unusable") unusable.add(provider);
    else absent.add(provider);
  }
  return { identity, held, absent, unusable };
};

/**
 * The key of one person's home in one executor: what their starts, releases, re-POSTs and the
 * startup reconciliation are serialised on. By home, so a home Core lists is locked before Mend
 * knows whose it is.
 */
const homeKey = (workspaceId: string, home: string) => `${workspaceId}\u0000${home}`;

/** A launch Mend cannot name, in a worktree that runs per person: never run as root there. */
export const UNKNOWN_LAUNCH_REFUSAL =
  "Mend cannot tell which workspace launch this process belongs to, and this worktree runs each person as their own user, so nothing was started. Start the session again.";

/** DELETE is retried: a release that fails leaves a login where nobody runs any more. */
const RELEASE_RETRY = Schedule.exponential("200 millis").pipe(Schedule.both(Schedule.recurs(4)));
/** A re-POST after an authentication failure, at most this often per person and executor. */
const RELOGIN_SPACING_MS = 60_000;

export const makeHarnessLayoutSteps = (deps: {
  readonly flag: HarnessLayout;
  readonly repo: HarnessLayoutsRepo["Service"];
  readonly platform: PersonLayoutPlatform["Service"];
  readonly organizations: OrganizationsRepo["Service"];
  readonly sealant: Pick<SealantClientShape, "exec">;
  readonly harnessHome: string;
  /**
   * An identity pickup ticket (purpose `session-token`) for `person` in `launchId`, bound to them:
   * redeemed, it answers their Mend token, minted then, and their git author.
   */
  readonly identityTicket: (input: {
    readonly sessionId: string;
    readonly worktreeId: string;
    readonly launchId: string;
    readonly person: LinuxIdentity;
  }) => Effect.Effect<string>;
  /** Forget a ticket the exec that carried it no longer needs (`PickupTickets.discard`). */
  readonly discardTicket: (ticket: string) => void;
  /**
   * Revoke a person's Mend tokens of a launch issued before `issuedBefore`: their logins there
   * were released, or their start was refused. A token minted for a start after it stays.
   */
  readonly revokePersonToken: (
    launchId: string,
    accountId: string,
    issuedBefore: Date,
  ) => Effect.Effect<void>;
  /** `HarnessLayoutConfig.loginReleaseGrace`; `LOGIN_RELEASE_GRACE` when absent. */
  readonly loginReleaseGrace?: Duration.Duration;
  /** Starts work that nothing waits on (the worktree repair). */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * Whether any launch or worktree had a layout recorded when this process started
   * (`HarnessLayoutsRepo.anyRecorded`, one query). With the flag off and none, every layout
   * question answers `shared` with no store read, until something is recorded.
   */
  readonly anyRecorded: boolean;
}): HarnessLayoutSteps => {
  const { flag, repo, platform, sealant } = deps;
  const layoutByLaunch = bounded<string, HarnessLayout>();
  /** The people already made in an executor, per workspace. */
  const madeIn = bounded<string, Set<string>>();
  /** Whose process started last in an executor's worktree, per workspace. */
  const lastIn = bounded<string, string>();
  /**
   * Who holds a home in each executor, by workspace and person, with the launch that made it and
   * its launcher, whose create-time home is never released while the executor lives.
   */
  const loginsIn = bounded<
    string,
    {
      readonly launchId: string | null;
      launcher: string | null;
      readonly people: Map<string, HeldLogins>;
    }
  >();
  /** When each person's last process start was asked for, by workspace and home. */
  const startedAt = bounded<string, number>();
  const reloggedAt = bounded<string, number>();
  /** One login write or release at a time per person and executor. */
  const loginLocks = bounded<string, Semaphore.Semaphore>();
  const lockOf = (key: string) => {
    const known = loginLocks.get(key);
    if (known !== undefined) return known;
    const made = Semaphore.makeUnsafe(1);
    loginLocks.set(key, made);
    return made;
  };
  const executorOf = (workspaceId: string, launchId: string | null) => {
    const known = loginsIn.get(workspaceId);
    if (known !== undefined) return known;
    const made = { launchId, launcher: null, people: new Map<string, HeldLogins>() };
    loginsIn.set(workspaceId, made);
    return made;
  };
  /** Whether a start of this home's person was asked for within the grace. */
  const startedWithinGrace = (key: string, now: number) =>
    now - (startedAt.get(key) ?? Number.NEGATIVE_INFINITY) < releaseGraceMs;
  const releaseGraceMs = Duration.toMillis(deps.loginReleaseGrace ?? LOGIN_RELEASE_GRACE);
  /** Some launch or worktree has a layout recorded (at startup, or since). */
  let layoutsRecorded = deps.anyRecorded;
  const nothingRecorded = () => flag === "shared" && !layoutsRecorded;

  const prepareTickets: HarnessLayoutSteps["prepareTickets"] = Effect.fn(
    "HarnessLayoutSteps.prepareTickets",
  )(function* (input) {
    const { layout } = input;
    if (layout.layout !== "person") return null;
    const tickets = yield* Effect.forEach(
      [layout.launcher, ...layout.members],
      (person) =>
        deps
          .identityTicket({
            sessionId: input.sessionId,
            worktreeId: input.worktreeId,
            launchId: input.launchId,
            person,
          })
          .pipe(Effect.map((ticket) => [person.accountId, ticket] as const)),
      { concurrency: 4 },
    );
    return new Map(tickets);
  });

  const capabilityFor = Effect.fn("HarnessLayoutSteps.capabilityFor")(function* (
    image: WorkspaceImage,
    ownerUserId: string,
    harness: Harness,
  ) {
    // What Mend knows without asking, then what the control plane says of itself (one cached
    // read): a Core that cannot run a process as a person is refused here, before create.
    const obstacle =
      staticLayoutObstacle(image, { processUser: platform.processUser }) ??
      (yield* platform.controlPlaneObstacle);
    if (obstacle !== null) {
      return {
        capability: { person: false, missing: [obstacle], source: "static" } as const,
        imageKey: imageLayoutKeyOf(image, null),
        runtime: "unknown",
      };
    }
    const report = yield* platform.imageReport({ ownerUserId, image, harness });
    const imageKey = imageLayoutKeyOf(image, report.digest);
    const runtime = report.runtime ?? "unknown";
    // Mend's record of what a prepare found wins over Core's report for the same image.
    const recorded = yield* repo.capabilityOf(imageKey, runtime);
    const capability: LayoutCapability =
      recorded !== null
        ? { person: recorded.person, missing: recorded.missing, source: "mend" }
        : report.person !== null
          ? { person: report.person, missing: report.missing, source: "core" }
          : UNKNOWN_CAPABILITY;
    return { capability, imageKey, runtime };
  });

  const membersOf = Effect.fn("HarnessLayoutSteps.membersOf")(function* (
    organizationId: OrganizationId,
    launcher: string,
  ) {
    const members = yield* deps.organizations.members(organizationId);
    return yield* repo.identitiesOf(
      members.map((member) => member.userId).filter((id) => id !== launcher),
    );
  });

  const decide: HarnessLayoutSteps["decide"] = Effect.fn("HarnessLayoutSteps.decide")(
    function* (input) {
      // The flag off and nothing ever recorded: shared, as before, with no read at all.
      if (nothingRecorded()) {
        layoutByLaunch.set(input.launchId, "shared");
        return SHARED_AS_BEFORE;
      }
      const worktree = yield* repo.worktreeLayout(input.worktreeId);
      // Nothing asks for person: as before, nothing read, nothing recorded.
      if (worktree.layout === null && worktree.requested === null && flag === "shared") {
        // Known now, at no cost: the channel never reads this launch's layout from the store.
        layoutByLaunch.set(input.launchId, "shared");
        return SHARED_AS_BEFORE;
      }
      // The record is written before any person process runs; the head is read as a belt only
      // where the flag is on and the worktree has no record.
      const headHasPeople =
        worktree.layout === null && flag === "person" ? yield* input.headHasPeople : false;
      const { capability, imageKey, runtime } = yield* capabilityFor(
        yield* input.image,
        input.ownerUserId,
        input.harness,
      );
      // Decision 1's fallback for dotfiles: where the platform cannot apply a person's dotfiles
      // as them yet, a fresh worktree whose launcher keeps some runs shared, as before, and their
      // dotfiles apply at boot. A worktree already person stays person (decision 14) and starts
      // without them, which the session says.
      const dotfilesBlocked =
        !platform.dotfilesUser &&
        worktree.layout === null &&
        worktree.requested === null &&
        !headHasPeople &&
        flag === "person" &&
        capability.person === true &&
        input.launcherHasDotfiles !== undefined &&
        (yield* input.launcherHasDotfiles);
      const decision = decideHarnessLayout({
        flag,
        worktree,
        headHasPeople,
        capability,
        dotfilesBlocked,
      });
      if (decision.kind === "refuse") return yield* layoutRefused(decision.message);
      if (decision.layout === "shared") {
        yield* repo.recordLaunch({
          launchId: input.launchId,
          worktreeId: input.worktreeId,
          sessionId: input.sessionId,
          layout: "shared",
          source: decision.source,
          reason: decision.reason,
          imageKey,
          confirmed: !decision.probe,
        });
        layoutByLaunch.set(input.launchId, "shared");
        return {
          layout: "shared",
          source: decision.source,
          reason: decision.reason,
          probe: decision.probe,
          imageKey,
          runtime,
          recorded: true,
        };
      }
      const launcher = yield* repo
        .ensureIdentity(input.ownerUserId)
        .pipe(Effect.mapError((error) => layoutRefused(error.message)));
      const members = yield* membersOf(input.organizationId, input.ownerUserId);
      yield* repo.recordLaunch({
        launchId: input.launchId,
        worktreeId: input.worktreeId,
        sessionId: input.sessionId,
        layout: "person",
        source: decision.source,
        reason: null,
        imageKey,
        confirmed: false,
      });
      layoutsRecorded = true;
      layoutByLaunch.set(input.launchId, "person");
      return {
        layout: "person",
        source: decision.source,
        onMissing: decision.onMissing,
        launcher,
        members,
        imageKey,
        runtime,
      };
    },
  );

  const mayRunPerson: HarnessLayoutSteps["mayRunPerson"] = Effect.fn(
    "HarnessLayoutSteps.mayRunPerson",
  )(function* (worktreeId) {
    if (flag === "person") return true;
    if (nothingRecorded()) return false;
    return (yield* repo.worktreeLayout(worktreeId)).layout === "person";
  });

  // A standby boots before any worktree is known, as root and with no capture owner map; sealantd
  // reads that map only at boot (sealant#333), so a standby can never become a person executor.
  // Every launch that could be person (the flag on, a person worktree, the operator's person)
  // skips standbys and launches cold.
  const standbyMayServe: HarnessLayoutSteps["standbyMayServe"] = Effect.fn(
    "HarnessLayoutSteps.standbyMayServe",
  )(function* (worktreeId) {
    if (flag === "person") return false;
    if (nothingRecorded()) return true;
    const worktree = yield* repo.worktreeLayout(worktreeId);
    return worktree.layout === null && worktree.requested !== "person";
  });

  const settlePrepare: HarnessLayoutSteps["settlePrepare"] = Effect.fn(
    "HarnessLayoutSteps.settlePrepare",
  )(function* (input) {
    const { layout } = input;
    if (layout.layout === "shared") {
      if (!layout.probe) return { layout: "shared", fallback: null };
      const report = parseLayoutReport(input.stdout);
      if (report.probed && layout.imageKey !== null) {
        yield* repo.recordCapability({
          imageKey: layout.imageKey,
          runtime: layout.runtime,
          person: report.missing.length === 0,
          missing: report.missing,
        });
      }
      yield* repo.confirm(input.launchId);
      return { layout: "shared", fallback: null };
    }
    const report = parseLayoutReport(input.stdout);
    // The restore, not the image: nothing is recorded against the image, and the launch is
    // refused whatever the worktree, since nobody could edit what came back.
    if (report.unowned !== null) return yield* layoutRefused(ownerMapRefusal(report.unowned));
    // A person could not be given their Mend identity: usually passing, never the image's fault,
    // so the launch is refused with words to try again and nothing is recorded against the image.
    const identityFailures = report.failed.filter((entry) => entry.includes(": identity: "));
    if (!report.ready && report.missing.length === 0 && identityFailures.length > 0) {
      return yield* layoutRefused(identityRefusal(identityFailures));
    }
    if (report.ready) {
      yield* repo.recordCapability({
        imageKey: layout.imageKey,
        runtime: layout.runtime,
        person: true,
        missing: [],
      });
      yield* repo.confirmPerson(input.launchId, input.worktreeId);
      layoutByLaunch.set(input.launchId, "person");
      // Only the people this prepare says it made: a member with an identity (made in some other
      // worktree) whose saved directory did not come back with this head was skipped, and is
      // made at their first process here.
      const made = new Set(report.made);
      madeIn.set(
        input.workspace.id,
        new Set(
          [layout.launcher, ...layout.members]
            .filter((person) => made.has(person.name))
            .map((person) => person.accountId),
        ),
      );
      lastIn.set(input.workspace.id, layout.launcher.accountId);
      // The create wrote the launcher's logins into their home (`credentialsHome`): Core holds it
      // for them while the executor lives, so it is never released (decision 5).
      const executor = executorOf(input.workspace.id, input.launchId);
      executor.launcher = layout.launcher.accountId;
      executor.people.set(layout.launcher.accountId, {
        identity: layout.launcher,
        held: new Set(loginsOfCreate(input.fallback.credentials)),
        absent: new Set(),
        unusable: new Set(),
      });
      const opencode = new Set(report.opencode);
      return {
        layout: "person",
        opencode: [layout.launcher, ...layout.members].filter(
          (person) => made.has(person.name) && opencode.has(person.name),
        ),
      };
    }
    const missing =
      report.missing.length > 0
        ? report.missing
        : report.failed.length > 0
          ? report.failed
          : [report.probed ? "the users could not be made" : "the image could not be checked"];
    if (report.probed && report.missing.length > 0) {
      yield* repo.recordCapability({
        imageKey: layout.imageKey,
        runtime: layout.runtime,
        person: false,
        missing,
      });
    }
    if (layout.onMissing === "refuse") {
      return yield* layoutRefused(
        layout.source === "operator"
          ? `harnessLayout person was asked for, and this image cannot run per-person users (${missing.join(", ")}).`
          : `This worktree's sessions are saved per person, and its image cannot run per-person users (${missing.join(", ")}). Pick an image that can, or start a new worktree.`,
      );
    }
    // A wrong prediction never leaves an agent without a login: the create-time home is released
    // and the launcher's logins are written to `/root`, before anything starts. Either failing
    // fails the launch. Their dotfiles have no way to `/root`: Core's `dotfiles.apply` runs only as
    // a person (sealant#334) and the create applied none at boot, so the session says they were
    // not applied. The image's answer is recorded below, so the next launch on it decides shared
    // before create and its dotfiles apply at boot, as before.
    const home = linuxHomeOf(layout.launcher);
    yield* platform.deleteCredentials(input.workspace, { home });
    const rootLogins = homeLoginsOf(input.fallback.credentials);
    if (Object.keys(rootLogins).length > 0) {
      // Partial, as a start's (sealant#337): a provider disconnected since the create is left
      // out, and only one the harness needs refuses the launch.
      const written = yield* platform.postCredentials(input.workspace, {
        onBehalfOf: layout.launcher.accountId,
        home: "/root",
        logins: rootLogins,
        partial: true,
      });
      const harness = input.fallback.harness ?? null;
      const needed = (provider: LoginProvider) =>
        harness === null || loginNeedOf(harness).required.includes(provider);
      const refused = written.skipped.find((skip) => needed(skip.provider));
      if (refused !== undefined) {
        return yield* loginRefused(loginRefusal(refused.provider, refused.reason));
      }
    }
    const reason = `this image cannot run per-person users (${missing.join(", ")}), so this workspace takes one person`;
    yield* repo.recordFallback(input.launchId, reason);
    layoutByLaunch.set(input.launchId, "shared");
    return {
      layout: "shared",
      fallback: reason,
      dotfilesNotApplied: input.fallback.dotfiles.length > 0 ? DOTFILES_NOT_TO_ROOT : null,
    };
  });

  const refusedOwnerMap: HarnessLayoutSteps["refusedOwnerMap"] = Effect.fn(
    "HarnessLayoutSteps.refusedOwnerMap",
  )(function* (input) {
    const { layout } = input;
    if (layout.layout !== "person") return null;
    const lacks = ownerMapRefusalOf(input.error);
    if (lacks === null) return null;
    yield* repo.recordCapability({
      imageKey: layout.imageKey,
      runtime: layout.runtime,
      person: false,
      missing: [lacks],
    });
    const refused = (message: string) =>
      new SealantPlatformError({
        code: "harness_layout_refused",
        status: 409,
        message,
        cause: input.error,
      });
    if (layout.onMissing === "refuse") {
      return refused(
        layout.source === "operator"
          ? operatorPersonRefusal([lacks])
          : personLayoutRefusal([lacks]),
      );
    }
    // A fresh worktree: nothing ran, and it stays without a layout; the image is known now.
    if (input.launchId !== undefined) {
      yield* repo.recordFallback(
        input.launchId,
        `this image cannot run per-person users (${lacks})`,
      );
      layoutByLaunch.set(input.launchId, "shared");
    }
    return refused(
      `This workspace cannot run per-person users (${lacks}), so nothing was started. The next launch here runs as one person.`,
    );
  });

  const layoutOfLaunch: HarnessLayoutSteps["layoutOfLaunch"] = Effect.fn(
    "HarnessLayoutSteps.layoutOfLaunch",
  )(function* (launchId) {
    if (launchId === null) return "shared";
    const known = layoutByLaunch.get(launchId);
    if (known !== undefined) return known;
    if (nothingRecorded()) return "shared";
    const record = yield* repo.launchLayout(launchId);
    // A person record is person, confirmed or still in prepare (decide wrote it before create;
    // a fallback rewrites it as shared): the window between decide and prepare's confirm is
    // person too, so nothing in it ever reads as a shared executor (review 3 of mend#553, P2-1).
    // Anything else, a launch from before this release included, ran as root.
    const layout: HarnessLayout =
      record !== null && record.layout === "person" ? "person" : "shared";
    // Compare-and-set: what settle wrote while the read was in flight (a fallback's shared, a
    // confirm's person) is newer than the record read, and stays (review 4 of mend#553, P3-5).
    const meanwhile = layoutByLaunch.get(launchId);
    if (meanwhile !== undefined) return meanwhile;
    layoutByLaunch.set(launchId, layout);
    return layout;
  });

  /** A home recorded as held although Mend cannot say what Core wrote: a release reaches it. */
  const keepHeldFor = (workspaceId: string, launchId: string | null, identity: LinuxIdentity) => {
    const people = executorOf(workspaceId, launchId).people;
    const holding = people.get(identity.accountId);
    people.set(identity.accountId, {
      identity,
      held: new Set(holding?.held ?? []),
      absent: new Set(holding?.absent ?? []),
      unusable: new Set(holding?.unusable ?? []),
    });
  };

  /**
   * A person's logins written into their home in this executor (decision 5): one partial POST
   * (sealant#337) naming the providers the process needs that the home does not hold yet, so a
   * join is exactly one Core call. Core writes what the person has connected and answers what it
   * left out: an optional provider left out is not asked for again; a required one refuses the
   * process with Core's reason, and what the POST did write is recorded held, so the release
   * that follows a refused start reaches it. A POST that raced the `useradd` making the home
   * (`home-unusable`) is asked again once the home is made; one Core answered `home-busy` is asked
   * again shortly. Any other failure leaves the home recorded as held (Core may have written it),
   * so a release still reaches it. Run under the home's lock.
   */
  const writeLogins = Effect.fn("HarnessLayoutSteps.writeLogins")(function* (input: {
    readonly workspace: Workspace;
    readonly launchId: string | null;
    readonly identity: LinuxIdentity;
    readonly need: LoginNeed;
    readonly homeMade: Deferred.Deferred<void> | null;
  }) {
    const { identity, need } = input;
    const people = executorOf(input.workspace.id, input.launchId).people;
    const holding = people.get(identity.accountId);
    if (covers(holding, need)) return [];
    const required = new Set(need.required);
    const choices = new Map<LoginProvider, true | null>();
    for (const provider of [...need.required, ...need.optional]) {
      if (holding?.held.has(provider) === true || choices.has(provider)) continue;
      // A file only the person can fix is not named again while the home is held.
      if (holding?.unusable.has(provider) === true && !required.has(provider)) continue;
      choices.set(
        provider,
        holding?.absent.has(provider) === true && !required.has(provider) ? null : true,
      );
    }
    const logins: HomeLogins = {};
    for (const [provider, choice] of choices) logins[provider] = choice;
    const home = linuxHomeOf(identity);
    let busy = 0;
    let waitedForHome = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const written = yield* platform
        .postCredentials(input.workspace, {
          onBehalfOf: identity.accountId,
          home,
          owner: { uid: identity.uid, gid: MEND_GROUP.gid },
          logins,
          partial: true,
        })
        .pipe(Effect.result);
      if (written._tag === "Success") {
        const skipped = new Map(written.success.skipped.map((skip) => [skip.provider, skip]));
        people.set(identity.accountId, heldAfter(holding, identity, choices, skipped));
        const refused = need.required
          .map((provider) => skipped.get(provider))
          .find((skip) => skip !== undefined);
        if (refused !== undefined) {
          return yield* loginRefused(loginRefusal(refused.provider, refused.reason));
        }
        return written.success.skipped;
      }
      const error = written.failure;
      if (error.code === "home-busy" && busy < 3) {
        busy++;
        yield* Effect.sleep(Duration.millis(200 * busy));
        continue;
      }
      if (error.code === "home-unusable" && input.homeMade !== null && !waitedForHome) {
        waitedForHome = true;
        yield* Deferred.await(input.homeMade);
        continue;
      }
      keepHeldFor(input.workspace.id, input.launchId, identity);
      // A put Core refused whole for an account (never a partial one's, sealant#337): its words.
      const refusedWhole = refusedAccountOf(error);
      if (refusedWhole !== null) {
        return yield* loginRefused(loginRefusal(refusedWhole.provider, refusedWhole.reason));
      }
      return yield* new SealantPlatformError({
        code: "person_login_not_written",
        status: error.status,
        message: `${identity.name}'s logins could not be written into this workspace: ${error.message}`,
        cause: error,
      });
    }
    keepHeldFor(input.workspace.id, input.launchId, identity);
    return yield* new SealantPlatformError({
      code: "person_login_not_written",
      status: null,
      message: `${identity.name}'s logins could not be written into this workspace: Core kept refusing`,
      cause: null,
    });
  });

  const processAs: HarnessLayoutSteps["processAs"] = Effect.fn("HarnessLayoutSteps.processAs")(
    function* (input) {
      if (input.launchId === null) {
        // A launch Mend cannot name: in a worktree that runs per person every executor is a
        // person executor, and a root process there could read every home. Refused.
        if (
          !nothingRecorded() &&
          (yield* repo.worktreeLayout(WorktreeId.make(input.worktreeId))).layout === "person"
        ) {
          return yield* layoutRefused(UNKNOWN_LAUNCH_REFUSAL);
        }
        return null;
      }
      const launchId = input.launchId;
      if ((yield* layoutOfLaunch(launchId)) !== "person") return null;
      const identity = yield* repo
        .ensureIdentity(input.accountId)
        .pipe(Effect.mapError((error) => layoutRefused(error.message)));
      const workspaceId = input.workspace.id;
      const key = homeKey(workspaceId, linuxHomeOf(identity));
      const need = loginNeedOf(input.harness);
      // The start's whole make-and-POST holds the home's lock, so a release or the startup
      // reconciliation never runs between what it reads and what it writes (review of mend#564,
      // P2-1); the make and the POST still run beside each other inside it.
      const leftOut = yield* lockOf(key).withPermit(
        Effect.gen(function* () {
          startedAt.set(key, yield* Clock.currentTimeMillis);
          const made = madeIn.get(workspaceId) ?? new Set<string>();
          const needsHome = !made.has(identity.accountId);
          const needsLogins = !covers(
            loginsIn.get(workspaceId)?.people.get(identity.accountId),
            need,
          );
          const tellHomeReady = (madeNow: boolean) =>
            input.homeReady === undefined
              ? Effect.void
              : Deferred.succeed(input.homeReady, {
                  identity,
                  user: processUserOf(identity),
                  made: madeNow,
                }).pipe(Effect.asVoid);
          if (!needsHome) yield* tellHomeReady(false);
          if (!needsHome && !needsLogins) return [];
          const homeMade = yield* Deferred.make<void>();
          let minted = false;
          // Their first process in this executor: their user, home and saved directory (one exec,
          // idempotent, so a server restart that forgot costs one more and changes nothing).
          // Their Mend token and git author ride the same exec through a pickup (decision 4): no
          // exec of their own, and neither in its arguments.
          const makeHome = Effect.gen(function* () {
            if (!needsHome) return;
            const ticket = yield* deps.identityTicket({
              sessionId: input.sessionId,
              worktreeId: input.worktreeId,
              launchId,
              person: identity,
            });
            minted = true;
            const result = yield* sealant
              .exec(input.workspace, [
                "sh",
                "-c",
                `${personHomeScript(identity, { harnessHome: deps.harnessHome })}\n` +
                  identityPickupScript([{ person: identity, ticket }]),
              ])
              .pipe(Effect.ensuring(Effect.sync(() => deps.discardTicket(ticket))));
            if (result.exitCode !== 0) {
              return yield* new SealantPlatformError({
                code: "person_user_not_made",
                status: null,
                message: `${identity.name} could not be made in this workspace: ${result.stderr.trim()}`,
                cause: null,
              });
            }
            made.add(identity.accountId);
            madeIn.set(workspaceId, made);
            yield* tellHomeReady(true);
          }).pipe(Effect.ensuring(Deferred.succeed(homeMade, undefined)));
          // Their own logins, beside it (decision 5): one Core call, which makes the home for them
          // when it gets there first. Nobody else's login is ever read or written for them.
          const writeThem = needsLogins
            ? writeLogins({
                workspace: input.workspace,
                launchId,
                identity,
                need,
                homeMade: needsHome ? homeMade : null,
              })
            : Effect.succeed<ReadonlyArray<LoginSkip>>([]);
          /**
           * A start that did not finish (refused, or interrupted): the Mend token its home exec
           * minted goes (review of mend#564, P2-3), and their next start makes them again; their
           * user and home stay, holding no login. Unless the person still runs something here:
           * their processes read the token file this start rewrote, so it stays theirs.
           */
          const undoMinted = Effect.gen(function* () {
            if (!minted) return;
            if ((yield* input.live).has(identity.accountId)) return;
            made.delete(identity.accountId);
            yield* deps.revokePersonToken(
              launchId,
              identity.accountId,
              new Date((yield* Clock.currentTimeMillis) + 1),
            );
          });
          const [home, logins] = yield* Effect.all(
            [makeHome.pipe(Effect.result), writeThem.pipe(Effect.result)],
            { concurrency: 2 },
          ).pipe(
            // Interrupted mid-write (a client that went away): Core may have written, so the home
            // is recorded held for a release to reach, and the token minted for it goes.
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (needsLogins) keepHeldFor(workspaceId, launchId, identity);
                yield* undoMinted;
              }),
            ),
          );
          // A refused login says what to connect; it wins over anything the home exec said.
          if (logins._tag === "Failure") {
            yield* undoMinted;
            return yield* logins.failure;
          }
          if (home._tag === "Failure") return yield* home.failure;
          return logins.success;
        }),
      );
      const last = lastIn.get(workspaceId);
      if (last !== undefined && last !== identity.accountId) {
        // Another person's process starts in the worktree: what earlier processes left without
        // group write is repaired, off the critical path.
        yield* deps.fork(
          sealant.exec(input.workspace, ["sh", "-c", worktreeRepairScript()]).pipe(
            Effect.tap((result) =>
              Effect.logInfo("session engine: worktree repair · observed").pipe(
                Effect.annotateLogs({
                  workspaceId,
                  exitCode: result.exitCode,
                  repaired: result.stdout.split("\n").filter((line) => line.length > 0).length,
                }),
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("session engine: worktree repair did not run").pipe(
                Effect.annotateLogs({ workspaceId, message: error.message }),
              ),
            ),
            Effect.asVoid,
          ),
        );
      }
      lastIn.set(workspaceId, identity.accountId);
      return {
        user: processUserOf(identity),
        env: personProcessEnv(deps.harnessHome, identity, input.sessionId),
        loginsLeftOut: leftOut.flatMap((skip) => {
          const words = loginLeftOutWords(skip);
          return words === null ? [] : [words];
        }),
      };
    },
  );

  const holdsReleasable: HarnessLayoutSteps["holdsReleasable"] = (workspaceId) => {
    const entry = loginsIn.get(workspaceId);
    if (entry === undefined) return false;
    for (const accountId of entry.people.keys()) if (accountId !== entry.launcher) return true;
    return false;
  };

  /**
   * One person's home released: Core's files and record (pi's and opencode's ChatGPT logins among
   * them, which Core writes and removes, sealant#336), and their token.
   */
  const releaseHome = Effect.fn("HarnessLayoutSteps.releaseHome")(function* (input: {
    readonly workspace: Workspace;
    readonly launchId: string | null;
    readonly home: string;
    readonly identity: LinuxIdentity | null;
    readonly startedAtMs: number;
    readonly why: string;
    /** Their Mend token goes too: not when the home only held someone else's login. */
    readonly revoke: boolean;
  }) {
    const workspaceId = input.workspace.id;
    yield* platform.deleteCredentials(input.workspace, { home: input.home }).pipe(
      Effect.retry(RELEASE_RETRY),
      Effect.andThen(
        Effect.logInfo(`session engine: a person's logins released ${input.why}· observed`).pipe(
          Effect.annotateLogs({ workspaceId, home: input.home }),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning(
          "session engine: a person's logins were not released; they go with the executor",
        ).pipe(Effect.annotateLogs({ workspaceId, home: input.home, message: error.message })),
      ),
    );
    const identity = input.identity;
    if (identity === null) return;
    // Only tokens minted before the release began: one minted for a start since stays.
    if (input.revoke && input.launchId !== null) {
      yield* deps.revokePersonToken(
        input.launchId,
        identity.accountId,
        new Date(input.startedAtMs),
      );
    }
  });

  const releaseIdle: HarnessLayoutSteps["releaseIdle"] = (input) =>
    Effect.gen(function* () {
      const entry = loginsIn.get(input.workspaceId);
      if (entry === undefined) return;
      if (entry.launcher === null) entry.launcher = yield* input.launcher;
      // Whose create-time home it is must be known: unknown, nothing is released.
      const launcher = entry.launcher;
      if (launcher === null) return;
      const candidates = [...entry.people.keys()].filter((accountId) => accountId !== launcher);
      if (candidates.length === 0) return;
      const live = yield* input.live;
      const idle = candidates.filter((accountId) => !live.has(accountId));
      if (idle.length === 0) return;
      // The handle first, outside every lock: a start never waits on a Core lookup.
      const workspace = yield* input.workspace;
      let recheck = false;
      for (const accountId of idle) {
        const holding = entry.people.get(accountId);
        if (holding === undefined) continue;
        const home = linuxHomeOf(holding.identity);
        const key = homeKey(input.workspaceId, home);
        yield* lockOf(key).withPermit(
          Effect.gen(function* () {
            // Under the lock, again: a start that ran meanwhile (it held this lock across its
            // make-and-POST) has set its time, and its process row may not be written yet.
            if (entry.people.get(accountId) !== holding) return;
            const now = yield* Clock.currentTimeMillis;
            if (startedWithinGrace(key, now)) {
              recheck = true;
              return;
            }
            entry.people.delete(accountId);
            // Their next process here makes them again: a new Mend token (theirs is revoked
            // below), and their logins written once more.
            madeIn.get(input.workspaceId)?.delete(accountId);
            yield* releaseHome({
              workspace,
              launchId: entry.launchId,
              home,
              identity: holding.identity,
              startedAtMs: now,
              why: "",
              revoke: true,
            });
          }),
        );
      }
      if (recheck) {
        yield* deps.fork(
          Effect.sleep(Duration.millis(releaseGraceMs)).pipe(Effect.andThen(releaseIdle(input))),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("session engine: the idle-login check did not finish").pipe(
          Effect.annotateLogs({ workspaceId: input.workspaceId, cause: String(cause) }),
        ),
      ),
      Effect.withSpan("HarnessLayoutSteps.releaseIdle"),
    );

  const relogin: HarnessLayoutSteps["relogin"] = (input) =>
    Effect.gen(function* () {
      if ((yield* layoutOfLaunch(input.launchId)) !== "person") return;
      const identity = yield* repo.ensureIdentity(input.accountId);
      const home = linuxHomeOf(identity);
      const key = homeKey(input.workspace.id, home);
      const now = yield* Clock.currentTimeMillis;
      const last = reloggedAt.get(key);
      if (last !== undefined && now - last < RELOGIN_SPACING_MS) return;
      // Nobody is written into whom nothing runs: that login would never be released.
      if (!(yield* input.live).has(input.accountId)) return;
      reloggedAt.set(key, now);
      const people = executorOf(input.workspace.id, input.launchId).people;
      yield* lockOf(key).withPermit(
        Effect.gen(function* () {
          const holding = people.get(input.accountId);
          const providers = new Set([
            ...(holding?.held ?? []),
            ...loginNeedOf(input.harness).required,
          ]);
          if (providers.size === 0) return;
          const choices = new Map<LoginProvider, true>();
          const logins: HomeLogins = {};
          for (const provider of providers) {
            choices.set(provider, true);
            logins[provider] = true;
          }
          // Recorded before the write: whatever Core does with it, a release reaches it.
          people.set(input.accountId, {
            identity,
            held: providers,
            absent: new Set(holding?.absent ?? []),
            unusable: new Set(holding?.unusable ?? []),
          });
          // Partial, as a start's: an account refused since leaves the rest written.
          const written = yield* platform.postCredentials(input.workspace, {
            onBehalfOf: identity.accountId,
            home,
            owner: { uid: identity.uid, gid: MEND_GROUP.gid },
            logins,
            partial: true,
          });
          people.set(
            input.accountId,
            heldAfter(
              holding,
              identity,
              choices,
              new Map(written.skipped.map((skip) => [skip.provider, skip])),
            ),
          );
          yield* Effect.logInfo(
            "session engine: a person's logins written again after an authentication failure · observed",
          ).pipe(Effect.annotateLogs({ workspaceId: input.workspace.id, home }));
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("session engine: a person's logins were not written again").pipe(
          Effect.annotateLogs({ workspaceId: input.workspace.id, cause: String(cause) }),
        ),
      ),
      Effect.withSpan("HarnessLayoutSteps.relogin"),
    );

  const reconcileLogins: HarnessLayoutSteps["reconcileLogins"] = (input) =>
    Effect.gen(function* () {
      if ((yield* layoutOfLaunch(input.launchId)) !== "person") return;
      const workspaceId = input.workspace.id;
      const executor = executorOf(workspaceId, input.launchId);
      // The launcher's create-time home is theirs for the executor's life, whoever started first.
      executor.launcher = input.launcher;
      // Core's homes first, then who is live: a person whose first process starts in between is
      // live by then, or inside the grace below (review of mend#564, P2-2).
      const listed = yield* platform.listCredentials(input.workspace);
      // A conversation home is its conversation's, whoever's login it holds: the caller decides.
      if (input.conversationHome !== undefined) {
        for (const held of listed) {
          if (held.home.startsWith(`${CONVERSATION_HOMES}/`)) yield* input.conversationHome(held);
        }
      }
      const homes = listed.filter((held) =>
        // Only a person's home under /home: `/root` is no person's in this layout.
        held.home.startsWith("/home/"),
      );
      if (homes.length === 0) return;
      const live = yield* input.live;
      // Whose each home is, by its name, whether or not they run anything now.
      const identities = yield* repo.identitiesNamed(
        homes.map((held) => held.home.slice("/home/".length)),
      );
      const byHome = new Map(identities.map((identity) => [linuxHomeOf(identity), identity]));
      let recheck = false;
      for (const held of homes) {
        const key = homeKey(workspaceId, held.home);
        yield* lockOf(key).withPermit(
          Effect.gen(function* () {
            const identity = byHome.get(held.home) ?? null;
            // A home Mend already holds for someone (a start since this Mend came up) is left as
            // Mend recorded it: never released from under them.
            const holder = [...executor.people.values()].find(
              (holding) => linuxHomeOf(holding.identity) === held.home,
            );
            if (holder !== undefined) return;
            const now = yield* Clock.currentTimeMillis;
            if (startedWithinGrace(key, now)) {
              recheck = true;
              return;
            }
            const running =
              identity !== null &&
              (identity.accountId === input.launcher || live.has(identity.accountId));
            // Whose Core says it is must be the person the home belongs to: a login of anyone
            // else in it is released, never adopted (review of mend#564, P3-2).
            const owned =
              identity !== null &&
              (yield* platform.sealantUserOf(identity.accountId).pipe(
                Effect.map((sealantUser) => sealantUser === held.onBehalfOf),
                Effect.orElseSucceed(() => false),
              ));
            if (running && owned) {
              executor.people.set(identity.accountId, {
                identity,
                held: new Set(held.providers),
                absent: new Set(),
                unusable: new Set(),
              });
              // They are made in this executor (they run here), and their token file is theirs:
              // a later start makes them again only once released, so it rewrites and revokes
              // nothing of their running processes (review 2 of mend#564, P2).
              const made = madeIn.get(workspaceId) ?? new Set<string>();
              made.add(identity.accountId);
              madeIn.set(workspaceId, made);
              return;
            }
            // A person whose last process ended while this Mend was down, or a home holding
            // someone else's login: released. A running person keeps their own Mend token.
            if (identity !== null && !running) madeIn.get(workspaceId)?.delete(identity.accountId);
            yield* releaseHome({
              workspace: input.workspace,
              launchId: input.launchId,
              home: held.home,
              identity,
              startedAtMs: now,
              why: "at startup ",
              revoke: !running,
            });
          }),
        );
      }
      // A home left for a start inside the grace is looked at again once it has passed.
      if (recheck) {
        yield* deps.fork(
          Effect.sleep(Duration.millis(releaseGraceMs)).pipe(
            Effect.andThen(reconcileLogins(input)),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("session engine: the logins of a live executor were not reconciled").pipe(
          Effect.annotateLogs({ workspaceId: input.workspace.id, cause: String(cause) }),
        ),
      ),
      Effect.withSpan("HarnessLayoutSteps.reconcileLogins"),
    );

  const forgetExecutor: HarnessLayoutSteps["forgetExecutor"] = (workspaceId) => {
    loginsIn.delete(workspaceId);
    madeIn.delete(workspaceId);
    lastIn.delete(workspaceId);
  };

  const turnRefusal: HarnessLayoutSteps["turnRefusal"] = Effect.fn(
    "HarnessLayoutSteps.turnRefusal",
  )(function* (input) {
    if (input.author === null || input.author === input.ownerUserId) return null;
    return (yield* layoutOfLaunch(input.launchId)) === "person" ? PERSON_STEER_REFUSAL : null;
  });

  return {
    flag,
    decide,
    mayRunPerson,
    personPossible: () => !nothingRecorded(),
    noteRecorded: () => {
      layoutsRecorded = true;
    },
    standbyMayServe,
    prepareTickets,
    prepareScript: layoutPrepareScript,
    settlePrepare,
    refusedOwnerMap,
    layoutOfLaunch,
    processAs,
    holdsReleasable,
    releaseIdle,
    relogin,
    reconcileLogins,
    forgetExecutor,
    turnRefusal,
  };
};
