import { defaultSettings, type MendSettings } from "@mend/domain";
import * as Context from "effect/Context";

/**
 * The instance's settings while no row is saved (`builtInSettingsFor`): Mend's defaults, unless
 * the server's composition says its sessions run on Boat until organizations choose. Its own
 * module, importing no database code, because migration 0230 reads it too.
 */
export const BuiltInSettings = Context.Reference<MendSettings>("@mend/db/BuiltInSettings", {
  defaultValue: () => defaultSettings,
});
