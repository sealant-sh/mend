import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { NO_ANSWER } from "@/data/failure-words";
import {
  clearTray,
  forgetDevice,
  mintPushToken,
  postDevice,
  pushPermissionGranted,
  type PushRegistration,
} from "@/data/notifications";
import { pairingKeyOf } from "@/data/pairing-key";

export interface Connection {
  readonly url: string;
  readonly token: string;
  /** The name the machine recorded for this device when it paired. */
  readonly deviceName: string | null;
  /** ISO timestamp of the pairing claim; null for a hand-typed token. */
  readonly pairedAt: string | null;
}

const EMPTY: Connection = { url: "", token: "", deviceName: null, pairedAt: null };

const readString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const parseConfig = (raw: string): Connection | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("url" in value) ||
      !("token" in value) ||
      typeof value.url !== "string" ||
      typeof value.token !== "string"
    ) {
      return null;
    }
    return {
      url: value.url,
      token: value.token,
      deviceName: "deviceName" in value ? readString(value.deviceName) : null,
      pairedAt: "pairedAt" in value ? readString(value.pairedAt) : null,
    };
  } catch {
    return null;
  }
};

// null is a third state, not a missing value: "the store has not answered
// yet". The boundary renders nothing until it answers, or a phone that is
// paired flashes the pairing panel on every cold start.
let current: Connection | null = null;
const configListeners = new Set<() => void>();
const notifyConfig = (): void => {
  for (const listener of configListeners) listener();
};

const settle = (config: Connection): void => {
  current = config;
  notifyConfig();
};

// ─── where the token lives ──────────────────────────────────────────────────
//
// The bearer token is a credential for the machine, so it sits in the OS
// keychain (iOS Keychain, Android Keystore), readable only while the phone is
// unlocked and never carried to another device by a backup — the machine
// recorded THIS device, and a restore onto a new phone should pair again.
// The web build has no keychain: it keeps the browser's storage, as before.
// Phones that paired before this change hold the config in AsyncStorage;
// the first read moves it across and clears the plain copy.

const CONFIG_KEY = "mend-config";
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const keychainUsable = Platform.OS !== "web";

const readStoredConfig = async (): Promise<string | null> => {
  if (!keychainUsable) return AsyncStorage.getItem(CONFIG_KEY);
  const secure = await SecureStore.getItemAsync(CONFIG_KEY, KEYCHAIN);
  if (secure !== null) return secure;
  const legacy = await AsyncStorage.getItem(CONFIG_KEY);
  if (legacy === null) return null;
  await SecureStore.setItemAsync(CONFIG_KEY, legacy, KEYCHAIN);
  await AsyncStorage.removeItem(CONFIG_KEY);
  return legacy;
};

const writeStoredConfig = (raw: string): Promise<void> =>
  keychainUsable
    ? SecureStore.setItemAsync(CONFIG_KEY, raw, KEYCHAIN)
    : AsyncStorage.setItem(CONFIG_KEY, raw);

const removeStoredConfig = async (): Promise<void> => {
  // Both homes, so a pre-keychain copy cannot outlive an unpair.
  if (keychainUsable) await SecureStore.deleteItemAsync(CONFIG_KEY, KEYCHAIN);
  await AsyncStorage.removeItem(CONFIG_KEY);
};

const hydrated: Promise<void> = readStoredConfig()
  .then((raw) => {
    settle((raw === null ? null : parseConfig(raw)) ?? EMPTY);
    return undefined;
  })
  .catch(() => settle(EMPTY));

export const loadConfig = async (): Promise<Connection> => {
  await hydrated;
  return current ?? EMPTY;
};

const samePairing = (a: Pick<Connection, "url" | "token">, b: Pick<Connection, "url" | "token">) =>
  pairingKeyOf(a) === pairingKeyOf(b);

export const isCurrentPairing = (connection: Pick<Connection, "url" | "token">): boolean =>
  current !== null && current.token !== "" && samePairing(current, connection);

const PUSH_STEP_MS = 10_000;
const NOT_ANSWERED: PushRegistration = { state: "unavailable", reason: NO_ANSWER };

let lastPushRequest: Promise<unknown> = Promise.resolve();

const withDeadline = async <T>(
  step: (deadline: AbortSignal) => Promise<T>,
  late: T,
): Promise<T> => {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PUSH_STEP_MS);
  const passed = new Promise<T>((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve(late));
  });
  try {
    return await Promise.race([step(deadline.signal), passed]);
  } finally {
    clearTimeout(timer);
  }
};

const pushRequestInTurn = <T>(step: (deadline: AbortSignal) => Promise<T>, late: T): Promise<T> => {
  const done = lastPushRequest.then(() => withDeadline(step, late)).catch(() => late);
  lastPushRequest = done;
  return done;
};

const endPairing = (ended: Connection): void => {
  void clearTray().catch(() => undefined);
  void pushRequestInTurn((deadline) => forgetDevice(ended, deadline), undefined);
};

let stored: Promise<void> = Promise.resolve();

let pairingGeneration = 0;

const write = async (change: (before: Connection) => Connection): Promise<void> => {
  await hydrated;
  const before = current ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  settle(after);
  if (!samePairing(before, after)) {
    pairingGeneration += 1;
    if (before.token !== "") endPairing(before);
    if (after.token !== "") void registerPushIfAllowed(after);
  }
  const saved = stored.then(() =>
    after === EMPTY ? removeStoredConfig() : writeStoredConfig(JSON.stringify(after)),
  );
  stored = saved.catch(() => undefined);
  await saved;
};

export const saveConfig = (connection: Connection): Promise<void> => write(() => connection);

/** Forget the machine on this device, and ask it to stop pushing here. It keeps the device. */
export const clearConfig = (): Promise<void> => write(() => EMPTY);

const PAIRING_CHANGED: PushRegistration = {
  state: "unavailable",
  reason: "the pairing changed meanwhile — enable notifications again",
};

let registering: { readonly generation: number; readonly done: Promise<PushRegistration> } | null =
  null;

export const registerPush = (connection: Connection): Promise<PushRegistration> => {
  if (connection.url === "") {
    return Promise.resolve({ state: "unavailable", reason: "set the server URL first" });
  }
  if (!isCurrentPairing(connection)) return Promise.resolve(PAIRING_CHANGED);
  const generation = pairingGeneration;
  if (registering?.generation === generation) return registering.done;
  const done = (async (): Promise<PushRegistration> => {
    const minted = await mintPushToken();
    if (minted.state !== "minted") return minted;
    return pushRequestInTurn(
      (deadline): Promise<PushRegistration> =>
        pairingGeneration === generation
          ? postDevice(connection, minted.token, deadline)
          : Promise.resolve(PAIRING_CHANGED),
      NOT_ANSWERED,
    );
  })()
    .catch(
      (cause: unknown): PushRegistration => ({
        state: "unavailable",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    )
    .finally(() => {
      if (registering?.done === done) registering = null;
    });
  registering = { generation, done };
  return done;
};

const registerPushIfAllowed = async (connection: Connection): Promise<void> => {
  if (await pushPermissionGranted().catch(() => false)) await registerPush(connection);
};

/** null until the stored config has been read — see the note on `current`. */
export const useConfig = (): Connection | null =>
  useSyncExternalStore(
    (onChange: () => void) => {
      configListeners.add(onChange);
      return () => configListeners.delete(onChange);
    },
    () => current,
    () => null,
  );

const registerPushOnLaunch = (): void => {
  if (current !== null && current.token !== "") void registerPushIfAllowed(current);
};

void hydrated.then(registerPushOnLaunch);
