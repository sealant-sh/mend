// Notification taps land in the session they announce. Two paths (t3code's
// pattern, MIT — pingdotgg/t3code notificationNavigation): a live listener
// for taps while the app runs, and the cold-start read of the response that
// launched the app — deduped by response identifier so one tap never routes
// twice, and the cold-start response cleared so it can't replay on reload.

import * as Notifications from "expo-notifications";

import {
  foregroundPresentation,
  notifiedSessionId,
  watchedSessionId,
} from "@/data/notification-presence";

export interface NotificationRouter {
  readonly push: (sessionId: string) => void;
}

const sessionIdOf = (response: Notifications.NotificationResponse): string | null =>
  notifiedSessionId(response.notification.request.content.data);

export const wireNotificationNavigation = (router: NotificationRouter): (() => void) => {
  const handled = new Set<string>();
  const handle = (response: Notifications.NotificationResponse) => {
    if (handled.has(response.notification.request.identifier)) return;
    handled.add(response.notification.request.identifier);
    const sessionId = sessionIdOf(response);
    if (sessionId !== null) router.push(sessionId);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  void Notifications.getLastNotificationResponseAsync()
    .then((last) => {
      if (last === null) return;
      handle(last);
      return Notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => undefined);
  return () => subscription.remove();
};

/**
 * Foreground: a push about the session on screen is silent — it is already
 * there; any other shows as it would from the lock screen
 * (notification-presence.ts).
 */
export const configureForegroundPresentation = (): void => {
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(
        foregroundPresentation(watchedSessionId(), notification.request.content.data),
      ),
  });
};
