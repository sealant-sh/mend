import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExecutionEnvironmentDescriptor,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type RuntimeMode,
  type ServerAuthDescriptor,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerProviderModel,
} from "@mend/t3-contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@mend/t3-contracts/keybindings";

import type { MendConnectedAccount, MendHarnessCatalog } from "./mend-client.ts";

/**
 * t3code's server config for one paired person, built from Mend's model catalog
 * (`GET /api/harnesses/models`, read with the person's device token). The ADR's provider-instance
 * row: a Mend harness is a t3code provider instance, `codex` → driver `codex`, `claude` → driver
 * `claudeAgent`. Other harnesses (opencode, pi, shell) are not protocol-mode sessions the gateway
 * can show, so they are left out.
 *
 * Every capability flag says what Mend can do, not what t3code's own drivers can: a session keeps
 * the model it launched with, has no rollback, no plan mode and no provider setup through t3code.
 */

interface HarnessDriver {
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  /** The option id t3code's own driver uses for the effort select. */
  readonly effortOptionId: string;
}

const HARNESS_DRIVERS: Readonly<Record<string, HarnessDriver>> = {
  codex: {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    effortOptionId: "reasoningEffort",
  },
  claude: {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    effortOptionId: "effort",
  },
};

/**
 * The t3code provider a Mend harness is shown as, or null for a harness the gateway does not
 * show. The instance id is the driver's own name: one instance per driver.
 */
export const harnessProvider = (
  harness: string,
): {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
} | null => {
  const driver = HARNESS_DRIVERS[harness];
  return driver === undefined
    ? null
    : {
        instanceId: ProviderInstanceId.make(driver.driver),
        driver: driver.driver,
        displayName: driver.displayName,
      };
};

/** The Mend harness a t3code provider instance stands for, or null for one Mend does not run. */
export const harnessOfInstance = (
  instanceId: string,
): { readonly harness: string; readonly effortOptionId: string } | null => {
  for (const [harness, driver] of Object.entries(HARNESS_DRIVERS)) {
    if (driver.driver === instanceId) return { harness, effortOptionId: driver.effortOptionId };
  }
  return null;
};

/** The option id and choice t3code's Codex driver uses for priority processing. */
export const SERVICE_TIER_OPTION_ID = "serviceTier";
export const STANDARD_SERVICE_TIER = "default";
export const FAST_SERVICE_TIER = "fast";

/**
 * Mend's permission modes as t3code runtime modes: `bypass` is `full-access`, `ask` is
 * `approval-required`. Mend has nothing between them.
 */
export const SUPPORTED_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "full-access",
  "approval-required",
];

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const nonEmpty = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const effortDescriptor = (
  optionId: string,
  efforts: ReadonlyArray<string>,
): ProviderOptionDescriptor | undefined => {
  const options: Array<ProviderOptionChoice> = [];
  for (const effort of efforts) {
    const id = nonEmpty(effort);
    if (id !== undefined) options.push({ id, label: EFFORT_LABELS[id] ?? id });
  }
  return options.length === 0
    ? undefined
    : { id: optionId, label: "Reasoning", type: "select", options };
};

const serviceTierDescriptor: ProviderOptionDescriptor = {
  id: SERVICE_TIER_OPTION_ID,
  label: "Service Tier",
  type: "select",
  options: [
    { id: STANDARD_SERVICE_TIER, label: "Standard", isDefault: true },
    { id: FAST_SERVICE_TIER, label: "Fast" },
  ],
  currentValue: STANDARD_SERVICE_TIER,
};

const modelsFor = (
  catalog: MendHarnessCatalog,
  driver: HarnessDriver,
): ReadonlyArray<ServerProviderModel> => {
  const models: Array<ServerProviderModel> = [];
  for (const model of catalog.models) {
    const slug = nonEmpty(model.id);
    if (slug === undefined) continue;
    const optionDescriptors: Array<ProviderOptionDescriptor> = [];
    const efforts = effortDescriptor(driver.effortOptionId, model.efforts ?? catalog.efforts);
    if (efforts !== undefined) optionDescriptors.push(efforts);
    if (catalog.fastCapable) optionDescriptors.push(serviceTierDescriptor);
    models.push({
      slug,
      name: nonEmpty(model.label) ?? slug,
      isCustom: false,
      ...(slug === catalog.defaultModel ? { isDefault: true } : {}),
      capabilities: optionDescriptors.length === 0 ? null : { optionDescriptors },
    });
  }
  return models;
};

/** What the gateway observed of the login a person's sessions use for one harness. */
export type Login =
  | { readonly kind: "signed-in" }
  /** No usable login: none, or Mend's marks it invalid or archived. `reason` says which. */
  | { readonly kind: "none"; readonly reason: string }
  /** Held, but observed expired or failing to refresh: whether it works is not known. */
  | { readonly kind: "unsure"; readonly reason: string };

/** Each served harness's login, or null when the gateway could not read them. */
export type PersonLogins = ReadonlyMap<string, Login> | null;

/** The account Mend's sessions use for a harness: the one named `default` (review R650-1). */
export const SESSION_ACCOUNT = "default";

/** An epoch in milliseconds as an ISO time. */
const at = (epoch: number) => new Date(epoch).toISOString();

const numberAt = (metadata: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/**
 * A person's logins as their sessions will meet them (reviews R650-1 and R650-2): only the
 * `default` account of each harness counts, as Mend's sessions select it; an active one observed
 * expired with its refresh failed or its refresh grant expired, or with its last refresh failed,
 * is `unsure`, with what was observed. Never "signed in" on a stored status alone when expiry or
 * a failed refresh says otherwise.
 */
export const loginsOf = (
  accounts: ReadonlyArray<MendConnectedAccount>,
  now: number,
): ReadonlyMap<string, Login> => {
  const logins = new Map<string, Login>();
  for (const [harness, driver] of Object.entries(HARNESS_DRIVERS)) {
    const account = accounts.find(
      (candidate) => candidate.provider === harness && candidate.name === SESSION_ACCOUNT,
    );
    const name = driver.displayName;
    if (account === undefined) {
      const others = accounts.some((candidate) => candidate.provider === harness);
      logins.set(harness, {
        kind: "none",
        reason: others
          ? `Mend holds no default ${name} login of yours, the one sessions use (only others by name).`
          : `Mend holds no ${name} login of yours.`,
      });
      continue;
    }
    if (account.status !== "active") {
      logins.set(harness, {
        kind: "none",
        reason: `Mend's ${name} login of yours is ${account.status}.`,
      });
      continue;
    }
    const expiresAt = numberAt(account.metadata, "expiresAt");
    const refreshExpiresAt = numberAt(account.metadata, "refreshTokenExpiresAt");
    const refreshFailed = account.metadata?.["lastRefreshOutcome"] === "failed";
    const expired = expiresAt !== undefined && expiresAt <= now;
    if (expired && refreshExpiresAt !== undefined && refreshExpiresAt <= now) {
      logins.set(harness, {
        kind: "unsure",
        reason: `Mend's ${name} login of yours expired at ${at(expiresAt)}, and its refresh grant at ${at(refreshExpiresAt)}.`,
      });
    } else if (expired && refreshFailed) {
      logins.set(harness, {
        kind: "unsure",
        reason: `Mend's ${name} login of yours expired at ${at(expiresAt)}, and its last refresh failed.`,
      });
    } else if (refreshFailed) {
      logins.set(harness, {
        kind: "unsure",
        reason: `Mend's last refresh of your ${name} login failed.`,
      });
    } else {
      logins.set(harness, { kind: "signed-in" });
    }
  }
  return logins;
};

/**
 * One t3code provider per Mend harness the gateway can show, in Mend's order. Its login is what
 * Mend observed of the account sessions use (`loginsOf`): signed in is `authenticated`; none is
 * `unauthenticated`, and unsure is `unknown`, each with a warning saying what was observed and how
 * to connect one (t3code otherwise tells the person a provider is "Connected"). A warning, not an
 * error: the turn still goes to Mend, which decides what runs. Unread logins stay `unknown`.
 */
export const providersFromMend = (
  catalogs: ReadonlyArray<MendHarnessCatalog>,
  checkedAt: string,
  logins: PersonLogins,
): ReadonlyArray<ServerProvider> => {
  const providers: Array<ServerProvider> = [];
  for (const catalog of catalogs) {
    const driver = HARNESS_DRIVERS[catalog.harness];
    if (driver === undefined) continue;
    const login = logins === null ? null : (logins.get(catalog.harness) ?? null);
    providers.push({
      instanceId: ProviderInstanceId.make(driver.driver),
      driver: driver.driver,
      displayName: driver.displayName,
      // A Mend session keeps the model it launched with.
      requiresNewThreadForModelChange: true,
      supportsConversationRollback: false,
      // No plan mode: Mend sessions have no interaction modes.
      showInteractionModeToggle: false,
      supportedRuntimeModes: SUPPORTED_RUNTIME_MODES,
      // Thread titles come from Mend, never from t3code asking the provider.
      supportsTextGeneration: false,
      // Logins and installs are Mend's: each turn runs on its person's own login.
      setup: { canAuthenticate: false, canInstall: false },
      configurableProviders: false,
      enabled: true,
      installed: true,
      version: null,
      status: login === null || login.kind === "signed-in" ? "ready" : "warning",
      // What Mend holds of the login, never whether it works: that shows when a turn runs.
      auth: {
        status:
          login === null || login.kind === "unsure"
            ? "unknown"
            : login.kind === "signed-in"
              ? "authenticated"
              : "unauthenticated",
      },
      ...(login === null || login.kind === "signed-in"
        ? {}
        : {
            message: `${login.reason} ${login.kind === "none" ? "Connect one" : "If it does not work, connect it again"} with mend connect ${catalog.harness}.`,
          }),
      checkedAt,
      models: modelsFor(catalog, driver),
      slashCommands: [],
      skills: [],
    });
  }
  return providers;
};

/** Where the gateway itself lives, standing in for the paths t3code's config names. */
export interface GatewayPaths {
  /** The gateway's own directory: its state file's, or its working directory when in memory. */
  readonly directory: string;
  readonly keybindingsConfigPath: string;
  readonly logsDirectoryPath: string;
}

export const makeServerConfig = (input: {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly auth: ServerAuthDescriptor;
  readonly paths: GatewayPaths;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ServerConfig => ({
  environment: input.environment,
  auth: input.auth,
  cwd: input.paths.directory,
  // Never written: the gateway serves t3code's default keybindings and accepts no edits.
  keybindingsConfigPath: input.paths.keybindingsConfigPath,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  issues: [],
  providers: input.providers,
  // Nothing opens on the machine Mend runs on.
  availableEditors: [],
  observability: {
    logsDirectoryPath: input.paths.logsDirectoryPath,
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});

/** The `welcome` lifecycle event: nothing to bootstrap, so the bootstrap is complete. */
export const makeWelcome = (input: {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly paths: GatewayPaths;
}): ServerLifecycleWelcomePayload => ({
  environment: input.environment,
  cwd: input.paths.directory,
  projectName: input.environment.label,
  bootstrapStatus: "complete",
});
