import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProjectSettingsOverrides,
  KeybindingsConfig,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
  ServerSettings,
  ServerSettingsPatch,
  type KeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerUpsertKeybindingInput,
  type ServerRemoveKeybindingInput,
} from "@mend/t3-contracts";
import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@mend/t3-contracts/keybindings";
import { applyServerSettingsPatch } from "@mend/t3-contracts/server-settings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const SupportedRuntimeMode = Schema.Literals(["approval-required", "full-access"]);
const ProjectPreferences = Schema.Struct({
  defaultModelSelection: ServerSettingsPatch.fields.defaultModelSelection,
  defaultRuntimeMode: Schema.optionalKey(SupportedRuntimeMode),
  responseStreamingMode: ServerSettingsPatch.fields.responseStreamingMode,
  sourceControlWriterModelSelection:
    ProjectSettingsOverrides.fields.sourceControlWriterModelSelection,
  sourceControlWritingStyle: ProjectSettingsOverrides.fields.sourceControlWritingStyle,
  textGenerationModelSelection: ProjectSettingsOverrides.fields.textGenerationModelSelection,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Preferences consumed by T3's client; server behaviors require their own implementation. */
export const PersonPreferences = Schema.Struct({
  reviewGuidesEnabled: ServerSettings.fields.reviewGuidesEnabled,
  sourceControlWriterModelSelection: ServerSettings.fields.sourceControlWriterModelSelection,
  sourceControlWritingStyle: ServerSettings.fields.sourceControlWritingStyle,
  textGenerationModelSelection: ServerSettings.fields.textGenerationModelSelection,
  responseStreamingMode: ServerSettings.fields.responseStreamingMode,
  defaultModelSelection: ServerSettings.fields.defaultModelSelection,
  defaultRuntimeMode: SupportedRuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("full-access" as const)),
  ),
  environmentIcon: ServerSettings.fields.environmentIcon,
  projectSettingsOverrides: Schema.Record(ProjectId, ProjectPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
/** The whitelist also applies to data read back from SQLite. */
export type PersonPreferences = typeof PersonPreferences.Type;

/** Personal preferences and custom shortcuts share one atomic write and revision. */
export const PersonConfiguration = Schema.Struct({
  preferences: PersonPreferences,
  keybindings: KeybindingsConfig,
});
/** Stored rules contain native key strings, before compilation and default merging. */
export type PersonConfiguration = typeof PersonConfiguration.Type;

/** The revision advances on every successful personal configuration write. */
export interface KeptPersonConfiguration {
  readonly version: number;
  readonly configuration: PersonConfiguration;
}

/** A person with no saved configuration sees the native T3 defaults. */
export const NO_PERSON_CONFIGURATION: PersonConfiguration = {
  preferences: Schema.decodeUnknownSync(PersonPreferences)({}),
  keybindings: [],
};

const PersonPreferencesPatch = Schema.Struct({
  reviewGuidesEnabled: ServerSettingsPatch.fields.reviewGuidesEnabled,
  sourceControlWriterModelSelection: ServerSettingsPatch.fields.sourceControlWriterModelSelection,
  sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  textGenerationModelSelection: ServerSettingsPatch.fields.textGenerationModelSelection,
  responseStreamingMode: ServerSettingsPatch.fields.responseStreamingMode,
  defaultModelSelection: ServerSettingsPatch.fields.defaultModelSelection,
  defaultRuntimeMode: Schema.optionalKey(SupportedRuntimeMode),
  environmentIcon: ServerSettingsPatch.fields.environmentIcon,
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(ProjectPreferences)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Each project entry replaces its override set; null restores inherited defaults. */
export type PersonPreferencesPatch = typeof PersonPreferencesPatch.Type;
const decodePatch = Schema.decodeUnknownOption(PersonPreferencesPatch, {
  onExcessProperty: "error",
});

/** Accept only supported personal fields, never provider mutations or mixed unsupported writes. */
export const personPreferencesUpdateOf = (update: {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: unknown;
}): PersonPreferencesPatch | null => {
  if (update.providerInstanceMutation !== undefined) return null;
  const set = Object.entries(update.patch).filter(([, value]) => value !== undefined);
  if (set.length === 0) return null;
  return Option.getOrNull(decodePatch(Object.fromEntries(set)));
};

/** Oversized model options cannot grow one person's preference record without bound. */
export class PersonSettingsTooLarge extends Schema.TaggedError<PersonSettingsTooLarge>()(
  "PersonSettingsTooLarge",
  {},
) {
  override get message(): string {
    return "The personal settings exceed the gateway's limit of 64 KiB.";
  }
}

/** A whole-record limit bounds arbitrary model ids and provider option strings. */
export const applyPersonPreferences = (
  current: PersonConfiguration,
  patch: PersonPreferencesPatch,
): Result.Result<PersonConfiguration, PersonSettingsTooLarge> => {
  const applied = applyServerSettingsPatch(
    { ...DEFAULT_SERVER_SETTINGS, ...current.preferences },
    patch,
  );
  const preferences: PersonPreferences = {
    reviewGuidesEnabled: applied.reviewGuidesEnabled,
    sourceControlWriterModelSelection: applied.sourceControlWriterModelSelection,
    sourceControlWritingStyle: applied.sourceControlWritingStyle,
    textGenerationModelSelection: applied.textGenerationModelSelection,
    responseStreamingMode: applied.responseStreamingMode,
    defaultModelSelection: applied.defaultModelSelection,
    defaultRuntimeMode: patch.defaultRuntimeMode ?? current.preferences.defaultRuntimeMode,
    environmentIcon: applied.environmentIcon,
    projectSettingsOverrides: Schema.decodeUnknownSync(
      Schema.Record(ProjectId, ProjectPreferences),
    )(applied.projectSettingsOverrides),
  };
  const next = { ...current, preferences };
  return Buffer.byteLength(JSON.stringify(next.preferences)) > 64 * 1024
    ? Result.fail(new PersonSettingsTooLarge())
    : Result.succeed(next);
};

/** Compile with the pinned client's own parser, command override, and 256-rule cap. */
export const resolvedPersonKeybindings = (
  configuration: PersonConfiguration,
): ResolvedKeybindingsConfig =>
  mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(configuration.keybindings));

const sameRule = (left: KeybindingRule, right: KeybindingRule) =>
  left.key === right.key && left.command === right.command && left.when === right.when;

/** Native upsert identity is exact key, command and when; replace removes the old custom rule. */
export const upsertPersonKeybinding = (
  current: PersonConfiguration,
  input: ServerUpsertKeybindingInput,
  configPath: string,
): Result.Result<PersonConfiguration, KeybindingsConfigError> => {
  const { replace, ...rule } = input;
  if (
    compileResolvedKeybindingRule(rule) === null ||
    (replace !== undefined && compileResolvedKeybindingRule(replace) === null)
  ) {
    return Result.fail(
      new KeybindingsConfigError({ configPath, detail: "Invalid shortcut or when expression." }),
    );
  }
  const keybindings = [
    ...current.keybindings.filter(
      (entry) => !sameRule(entry, rule) && (replace === undefined || !sameRule(entry, replace)),
    ),
    rule,
  ].slice(-MAX_KEYBINDINGS_COUNT);
  return Result.succeed({ ...current, keybindings });
};

/** Removing a custom rule restores that command's native defaults. */
export const removePersonKeybinding = (
  current: PersonConfiguration,
  input: ServerRemoveKeybindingInput,
): PersonConfiguration => ({
  ...current,
  keybindings: current.keybindings.filter((entry) => !sameRule(entry, input)),
});
