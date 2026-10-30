import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { NO_ANSWER } from "@/data/failure-words";
import {
  clearTray,
  forgetDevice,
  grantedPushToken,
  mintPushToken,
  postDevice,
  pushPermissionGranted,
  type PushRegistration,
} from "@/data/notifications";
import { pairingKeyOf, type PairingKey } from "@/data/pairing-key";

export interface Connection {
  readonly url: string;
  readonly token: string;
  /** The name the machine recorded for this device when it paired. */
  readonly deviceName: string | null;
  /** ISO timestamp of the pairing claim; null for a hand-typed token. */
  readonly pairedAt: string | null;
}

export interface MendConfig extends Connection {
  readonly pushToken: string | null;
}

const EMPTY: MendConfig = { url: "", token: "", deviceName: null, pairedAt: null, pushToken: null };

const readString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const parseConfig = (raw: string): MendConfig | null => {
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
      pushToken: "pushToken" in value ? readString(value.pushToken) : null,
    };
  } catch {
    return null;
  }
};

// One store, read two ways: `loadConfig()` for the fetch path (awaits the
// first read off disk) and `useConfig()` for the pairing boundary (re-renders
// on save, no effect; screens read `usePairing()`). Hydrated once at import,
// same pattern as preferences.ts.
//
// null is a third state, not a missing value: "the store has not answered
// yet". The boundary renders nothing until it answers, or a phone that is
// paired flashes the pairing panel on every cold start.
let current: MendConfig | null = null;
const configListeners = new Set<() => void>();
const notifyConfig = (): void => {
  for (const listener of configListeners) listener();
};

const settle = (config: MendConfig): void => {
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

export const loadConfig = async (): Promise<MendConfig> => {
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

const endPairing = (ended: MendConfig): void => {
  void clearTray().catch(() => undefined);
  void pushRequestInTurn(async (deadline) => {
    const pushToken = ended.pushToken ?? (await grantedPushToken());
    if (pushToken !== null && !deadline.aborted) await forgetDevice(ended, pushToken, deadline);
  }, undefined);
};

let stored: Promise<void> = Promise.resolve();

const write = async (change: (before: MendConfig) => MendConfig): Promise<void> => {
  await hydrated;
  const before = current ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  settle(after);
  if (!samePairing(before, after)) {
    if (before.token !== "") endPairing(before);
    if (after.token !== "") void registerPushIfAllowed(after);
  }
  const saved = stored.then(() =>
    after === EMPTY ? removeStoredConfig() : writeStoredConfig(JSON.stringify(after)),
  );
  stored = saved.catch(() => undefined);
  await saved;
};

export const saveConfig = (connection: Connection): Promise<void> =>
  write((before) => ({
    ...connection,
    pushToken: samePairing(before, connection) ? before.pushToken : null,
  }));

/** Forget the machine on this device, and ask it to stop pushing here. It keeps the device. */
export const clearConfig = (): Promise<void> => write(() => EMPTY);

const keepPushToken = (connection: Connection, pushToken: string): Promise<void> =>
  write((before) => (samePairing(before, connection) ? { ...before, pushToken } : before)).catch(
    () => console.warn("the push token the machine accepted was not stored on this phone"),
  );

let registering: { readonly key: PairingKey; readonly done: Promise<PushRegistration> } | null =
  null;

export const registerPush = (connection: Connection): Promise<PushRegistration> => {
  const key = pairingKeyOf(connection);
  if (registering?.key === key) return registering.done;
  const done = (async (): Promise<PushRegistration> => {
    if (connection.url === "") return { state: "unavailable", reason: "set the server URL first" };
    const minted = await mintPushToken();
    if (minted.state !== "minted") return minted;
    return pushRequestInTurn(async (deadline): Promise<PushRegistration> => {
      if (!isCurrentPairing(connection)) {
        return {
          state: "unavailable",
          reason: "the pairing changed meanwhile — enable notifications again",
        };
      }
      const posted = await postDevice(connection, minted.token, deadline);
      if (posted.state === "registered" && !deadline.aborted) {
        await keepPushToken(connection, posted.token);
      }
      return posted;
    }, NOT_ANSWERED);
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
  registering = { key, done };
  return done;
};

const registerPushIfAllowed = async (connection: Connection): Promise<void> => {
  if (await pushPermissionGranted().catch(() => false)) await registerPush(connection);
};

/** null until the stored config has been read — see the note on `current`. */
export const useConfig = (): MendConfig | null =>
  useSyncExternalStore(
    (onChange: () => void) => {
      configListeners.add(onChange);
      return () => configListeners.delete(onChange);
    },
    () => current,
    () => null,
  );
