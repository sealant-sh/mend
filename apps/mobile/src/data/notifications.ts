// Push registration: ask iOS/Android for permission, mint the Expo push
// token, and hand it to the Mend server — which posts to Expo's push API when
// a session settles or waits. The server stores the token; registering again
// is an upsert, so calling this on every settings save is safe.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { failureLogLine, failureWords } from "@/data/failure-words";
import { loadConfig } from "@/data/live";

export type PushRegistration =
  | { readonly state: "registered"; readonly token: string }
  | { readonly state: "unavailable"; readonly reason: string };

export const enablePushNotifications = async (): Promise<PushRegistration> => {
  if (Platform.OS === "web") {
    return { state: "unavailable", reason: "push rides the native app, not the web build" };
  }
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    return { state: "unavailable", reason: "permission denied — allow in system settings" };
  }
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync()).data;
  } catch (cause) {
    // The usual cause: no EAS projectId yet (one-time `eas init`) or offline.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { state: "unavailable", reason: message };
  }
  const config = await loadConfig();
  if (config.url === "") {
    return { state: "unavailable", reason: "set the server URL first" };
  }
  const response = await fetch(`${config.url}/api/devices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ token, platform: Platform.OS }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    console.warn(failureLogLine("POST /api/devices", response.status, body));
    return { state: "unavailable", reason: failureWords(response.status, body).words };
  }
  return { state: "registered", token };
};

/** Has the user granted notification permission (without prompting)? */
export const pushPermissionGranted = async (): Promise<boolean> => {
  if (Platform.OS === "web") return false;
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted;
};

export const easProjectId = (): string | null => {
  const fromConfig = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof fromConfig === "string" ? fromConfig : null;
};
