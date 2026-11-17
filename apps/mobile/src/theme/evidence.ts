// The Evidence Review theme for React Native. Colors, radii, spacing, and
// type all come from @mend/ui-old/tokens — the same authority as the web sheet.

import type { EvidenceColors, EvidenceScheme } from "@mend/ui-old/tokens";
import { evidenceColors, shadows } from "@mend/ui-old/tokens";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

import { useDisplayPreferences } from "@/data/preferences";

export { fontFamilies, radius, spacing, typeScale } from "@mend/ui-old/tokens";
export type { EvidenceColors, EvidenceScheme };

export type EvidenceShadows = { readonly [K in keyof (typeof shadows)["light"]]: string };

export interface EvidenceTheme {
  readonly scheme: EvidenceScheme;
  readonly colors: EvidenceColors;
  readonly shadow: EvidenceShadows;
}

function subscribe(onChange: () => void): () => void {
  const subscription = Appearance.addChangeListener(onChange);
  return () => subscription.remove();
}

function getScheme(): EvidenceScheme {
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}

// useSyncExternalStore rather than RN's useColorScheme: on the statically
// rendered web build the latter keeps the server's "light" snapshot after
// hydration; this re-reads the real scheme on client mount. The user's
// Settings override wins over the OS scheme when one is set.
export function useEvidenceScheme(): EvidenceScheme {
  const os = useSyncExternalStore<EvidenceScheme>(subscribe, getScheme, () => "light");
  const { theme } = useDisplayPreferences();
  return theme === "system" ? os : theme;
}

export function useEvidenceTheme(): EvidenceTheme {
  const scheme = useEvidenceScheme();
  return { scheme, colors: evidenceColors[scheme], shadow: shadows[scheme] };
}
