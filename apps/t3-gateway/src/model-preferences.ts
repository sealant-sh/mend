import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@mend/t3-contracts";
import { applyServerSettingsPatch } from "@mend/t3-contracts/server-settings";

/**
 * A person's model favorites, hidden models and model order (ADR 0012, "State"). Since v0.1.1
 * t3code keeps them in its server settings, not the browser: the model picker's star and the
 * migration of a browser's old list both send `server.updateSettings`. The gateway keeps them per
 * person and serves every other setting at t3code's default, so a settings patch it takes may
 * carry only these keys.
 *
 * `null` is t3code's "no client has migrated this preference yet": a client then sends its
 * browser's list once (`migrateModelPreferences`), which applies only while the value is unset.
 */
export type ModelPreferences = Pick<ServerSettings, "favorites" | "providerModelPreferences">;

export const NO_MODEL_PREFERENCES: ModelPreferences = {
  favorites: null,
  providerModelPreferences: null,
};

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
 * mutates a provider: the gateway serves those at t3code's defaults and takes no edits to them. A
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

export const applyModelPreferencesPatch = (
  current: ModelPreferences,
  patch: ModelPreferencesPatch,
): ModelPreferences => {
  const next = applyServerSettingsPatch(settingsWith(current), patch);
  return { favorites: next.favorites, providerModelPreferences: next.providerModelPreferences };
};
