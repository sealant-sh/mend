import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { failureLogLine, failureWords } from "@/data/failure-words";

interface Unavailable {
  readonly state: "unavailable";
  readonly reason: string;
}

export type PushRegistration =
  | { readonly state: "registered"; readonly token: string }
  | Unavailable;

interface Machine {
  readonly url: string;
  readonly token: string;
}

const FORGET_MS = 5_000;

export const mintPushToken = async (): Promise<
  { readonly state: "minted"; readonly token: string } | Unavailable
> => {
  if (Platform.OS === "web") {
    return { state: "unavailable", reason: "push rides the native app, not the web build" };
  }
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    return { state: "unavailable", reason: "permission denied — allow in system settings" };
  }
  try {
    return { state: "minted", token: (await Notifications.getExpoPushTokenAsync()).data };
  } catch (cause) {
    // The usual cause: no EAS projectId yet (one-time `eas init`) or offline.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { state: "unavailable", reason: message };
  }
};

export const grantedPushToken = async (): Promise<string | null> => {
  if (!(await pushPermissionGranted())) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync()).data;
  } catch {
    return null;
  }
};

export const postDevice = async (
  machine: Machine,
  pushToken: string,
): Promise<PushRegistration> => {
  const response = await fetch(`${machine.url}/api/devices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${machine.token}`,
    },
    body: JSON.stringify({ token: pushToken, platform: Platform.OS }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    console.warn(failureLogLine("POST /api/devices", response.status, body));
    return { state: "unavailable", reason: failureWords(response.status, body).words };
  }
  return { state: "registered", token: pushToken };
};

export const forgetDevice = async (machine: Machine, pushToken: string): Promise<void> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FORGET_MS);
  try {
    const response = await fetch(`${machine.url}/api/devices/${encodeURIComponent(pushToken)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${machine.token}` },
      signal: abort.signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      console.warn(failureLogLine("DELETE /api/devices", response.status, body));
    }
  } catch {
    console.warn(failureLogLine("DELETE /api/devices", 0, null));
  } finally {
    clearTimeout(timer);
  }
};

export const clearTray = async (): Promise<void> => {
  if (Platform.OS === "web") return;
  await Promise.all([
    Notifications.dismissAllNotificationsAsync(),
    Notifications.setBadgeCountAsync(0),
  ]);
};

/** Has the user granted notification permission (without prompting)? */
export const pushPermissionGranted = async (): Promise<boolean> => {
  if (Platform.OS === "web") return false;
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted;
};
