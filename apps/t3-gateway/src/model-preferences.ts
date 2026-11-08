import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
  type ResolvedKeybindingsConfig,
} from "@mend/t3-contracts";
import { applyServerSettingsPatch } from "@mend/t3-contracts/server-settings";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  NO_PERSON_CONFIGURATION,
  resolvedPersonKeybindings,
  type KeptPersonConfiguration,
} from "./person-settings.ts";

/**
 * A person's model favorites, hidden models and model order (ADR 0012, "State"). Since v0.1.1
 * t3code keeps them in its server settings, not the browser: the model picker's star and the
 * migration of a browser's old list both send `server.updateSettings`. The gateway keeps them per
 * person, independently of other personal settings. Model-only patches need only
 * orchestration:operate.
 *
 * `null` is t3code's "no client has migrated this preference yet": a client then sends its
 * browser's list once (`migrateModelPreferences`), which applies only while the value is unset.
 */
export type ModelPreferences = Pick<ServerSettings, "favorites" | "providerModelPreferences">;

export const NO_MODEL_PREFERENCES: ModelPreferences = {
  favorites: null,
  providerModelPreferences: null,
};

export interface KeptModelPreferences {
  readonly version: number;
  readonly preferences: ModelPreferences;
}

const MODEL_PREFERENCE_PATCH_KEYS = [
  "setModelFavorites",
  "setModelsHidden",
  "setProviderModelOrder",
  "favorites",
  "providerModelPreferences",
  "migrateModelPreferences",
] as const satisfies ReadonlyArray<keyof ServerSettingsPatch>;

type ModelPreferencePatchKey = (typeof MODEL_PREFERENCE_PATCH_KEYS)[number];

export type ModelPreferencesPatch = Pick<ServerSettingsPatch, ModelPreferencePatchKey>;

const isModelPreferenceKey = (key: string): key is ModelPreferencePatchKey =>
  MODEL_PREFERENCE_PATCH_KEYS.some((known) => known === key);

/**
 * A `server.updateSettings` as model preferences alone, or null when it sets any other setting or
 * mutates a provider. Other supported personal fields use their separate settings write. A
 * patch that sets nothing is not a model preference change. Unlike t3code, which keeps these for
 * the whole machine behind `settings:write`, the gateway keeps them per person, so such an update
 * needs only `orchestration:operate` (`rpc-scopes.ts`).
 */
export const modelPreferencesUpdateOf = (update: {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: unknown;
}): ModelPreferencesPatch | null => {
  if (update.providerInstanceMutation !== undefined) return null;
  const set = Object.entries(update.patch).filter(([, value]) => value !== undefined);
  return set.length > 0 && set.every(([key]) => isModelPreferenceKey(key)) ? update.patch : null;
};

export const settingsWith = (preferences: ModelPreferences): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  favorites: preferences.favorites,
  providerModelPreferences: preferences.providerModelPreferences,
});

export interface KeptSettings {
  readonly version: number;
  readonly settings: ServerSettings;
  readonly keybindings?: ResolvedKeybindingsConfig;
}

export const keptSettingsOf = (
  kept: KeptModelPreferences,
  person: KeptPersonConfiguration = { version: 0, configuration: NO_PERSON_CONFIGURATION },
): KeptSettings => ({
  version: kept.version + person.version,
  settings: { ...settingsWith(kept.preferences), ...person.configuration.preferences },
  keybindings: resolvedPersonKeybindings(person.configuration),
});

export const applyModelPreferencesPatch = (
  current: ModelPreferences,
  patch: ModelPreferencesPatch,
): ModelPreferences => {
  const next = applyServerSettingsPatch(settingsWith(current), patch);
  return { favorites: next.favorites, providerModelPreferences: next.providerModelPreferences };
};

export const MODEL_PREFERENCE_LIMITS = {
  favorites: 1_024,
  providers: 64,
  modelsPerProviderList: 2_048,
  modelIdLength: 512,
  encodedBytes: 256 * 1024,
} as const;

export class ModelPreferencesTooLarge extends Schema.TaggedError<ModelPreferencesTooLarge>()(
  "ModelPreferencesTooLarge",
  { limit: Schema.String },
) {
  override get message(): string {
    return `The model preferences would exceed the gateway's limit of ${this.limit}.`;
  }
}

const firstLimitExceeded = (preferences: ModelPreferences): string | null => {
  const limits = MODEL_PREFERENCE_LIMITS;
  const favorites = preferences.favorites ?? [];
  if (favorites.length > limits.favorites) return `${limits.favorites} favorites`;
  const providers = Object.values(preferences.providerModelPreferences ?? {});
  if (providers.length > limits.providers) return `${limits.providers} providers`;
  if (
    providers.some(
      (lists) =>
        lists.hiddenModels.length > limits.modelsPerProviderList ||
        lists.modelOrder.length > limits.modelsPerProviderList,
    )
  ) {
    return `${limits.modelsPerProviderList} hidden or ordered models per provider`;
  }
  const modelIds = [
    ...favorites.map((favorite) => favorite.model),
    ...providers.flatMap((lists) => [...lists.hiddenModels, ...lists.modelOrder]),
  ];
  if (modelIds.some((model) => model.length > limits.modelIdLength)) {
    return `${limits.modelIdLength} characters per model id`;
  }
  if (Buffer.byteLength(JSON.stringify(preferences)) > limits.encodedBytes) {
    return `${limits.encodedBytes} bytes stored`;
  }
  return null;
};

export const boundedModelPreferences = (
  preferences: ModelPreferences,
): Result.Result<ModelPreferences, ModelPreferencesTooLarge> => {
  const limit = firstLimitExceeded(preferences);
  return limit === null
    ? Result.succeed(preferences)
    : Result.fail(new ModelPreferencesTooLarge({ limit }));
};
