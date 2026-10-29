// Native pairing composition. The arrival URL carries the claim; the server
// selects the configured URL saved with the resulting bearer token.

import * as Device from "expo-device";
import { Platform } from "react-native";

import { isSavedConfig, saveConfig } from "@/data/live";
import type { PairOutcome } from "@/data/pairing-client";
import { HttpPairingClient } from "@/data/pairing-client";
import { normalizeBaseUrl, normalizeCode, type PairPayload } from "@/data/pairing-code";

export type { PairedUser, PairOutcome } from "@/data/pairing-client";
export * from "@/data/pairing-code";

/** What the machine will list this device as. */
export const deviceLabel = (): string =>
  Device.deviceName ?? Device.modelName ?? `${Platform.OS} device`;

/** Translate React Native's platform into the pairing protocol. */
export const devicePlatform = (): "ios" | "android" | "web" | "other" =>
  Platform.OS === "ios"
    ? "ios"
    : Platform.OS === "android"
      ? "android"
      : Platform.OS === "web"
        ? "web"
        : "other";

const pairing = new HttpPairingClient({ saveConfig });
const claiming = new Map<string, Promise<PairOutcome>>();
const pairedBy = new Map<string, Extract<PairOutcome, { readonly state: "paired" }>>();

/**
 * Claim a code and save the validated server-selected URL with its bearer token. The same code
 * again (on the pair screen its new pairing remounts, or a second scan) gets this claim while it
 * runs or while its pairing is saved; a refused code can be claimed again.
 */
export const claimPairing = (payload: PairPayload): Promise<PairOutcome> => {
  const link = `${normalizeBaseUrl(payload.url)}\n${normalizeCode(payload.code)}`;
  const paired = pairedBy.get(link);
  if (paired !== undefined && isSavedConfig(paired.config)) return Promise.resolve(paired);
  const held = claiming.get(link);
  if (held !== undefined) return held;
  const claim = pairing.claim(payload, { name: deviceLabel(), platform: devicePlatform() });
  claiming.set(link, claim);
  void claim.then(
    (outcome) => {
      claiming.delete(link);
      if (outcome.state === "paired") pairedBy.set(link, outcome);
      return outcome;
    },
    () => claiming.delete(link),
  );
  return claim;
};
